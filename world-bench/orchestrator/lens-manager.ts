// World-Bench v0.4 — Lens Manager
// Spawns lens agents via AgentAdapter, monitors lifecycle,
// handles research phase time enforcement, writes events.

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import {
  LensConfig,
  AgentAdapter,
  AgentResult,
  WorkflowEvent,
  RunMeta,
} from '../agents/types';
import {
  buildLensSystemPrompt,
  buildResearchPrompt,
  buildProductionPrompt,
} from '../agents/base-lens-agent';

const DEFAULT_RESEARCH_DURATION = 120; // seconds

export interface LensRunResult {
  lens: LensConfig;
  researchResult?: AgentResult;
  productionResult?: AgentResult;
  events: WorkflowEvent[];
}

export class LensManager {
  private adapter: AgentAdapter;
  private worldBenchRoot: string;

  constructor(adapter: AgentAdapter, worldBenchRoot: string) {
    this.adapter = adapter;
    this.worldBenchRoot = worldBenchRoot;
  }

  /**
   * Run a lens through its full lifecycle: research (if enabled) → production.
   * Sequential execution — one lens at a time per spec (Claude Max rate limits).
   */
  async runLens(
    lens: LensConfig,
    projectSlug: string,
    runId: string,
    taskPrompt: string,
    priorLensOutput?: string,
    feedback?: string,
  ): Promise<LensRunResult> {
    const allEvents: WorkflowEvent[] = [];
    let researchResult: AgentResult | undefined;
    let researchOutput: string | undefined;

    // Emit start event
    const startEvent = this.createEvent(runId, 'orchestrator', 'state_change',
      `Starting lens: ${lens.name}`, { lens_id: lens.id, phase: 'start' });
    allEvents.push(startEvent);
    this.appendEvent(projectSlug, runId, startEvent);

    const lensWorkspace = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'lenses', lens.id, 'workspace',
    );
    fs.mkdirSync(lensWorkspace, { recursive: true });

    // ─── Research Phase ───
    if (lens.researchPhase.enabled) {
      const researchEvent = this.createEvent(runId, lens.name, 'state_change',
        `Entering research phase`, { phase: 'researching' });
      allEvents.push(researchEvent);
      this.appendEvent(projectSlug, runId, researchEvent);

      const researchPrompt = buildResearchPrompt(lens);
      const systemPrompt = buildLensSystemPrompt(lens);
      const maxDuration = (lens.researchPhase.maxDuration || DEFAULT_RESEARCH_DURATION) * 1000;

      researchResult = await this.spawnWithTimeout(
        researchPrompt,
        lens.tools,
        {
          systemPrompt,
          run_id: runId,
          lens_name: lens.name,
          cwd: lensWorkspace,
        },
        maxDuration,
      );

      // Save research output to workspace
      researchOutput = researchResult.output;
      const researchFile = path.join(lensWorkspace, 'research-output.json');
      fs.writeFileSync(researchFile, JSON.stringify({
        lens: lens.name,
        run_id: runId,
        timestamp: new Date().toISOString(),
        status: researchResult.status,
        output: researchOutput,
      }, null, 2));

      allEvents.push(...researchResult.events);
      for (const e of researchResult.events) {
        this.appendEvent(projectSlug, runId, e);
      }

      const researchDoneEvent = this.createEvent(runId, lens.name, 'state_change',
        `Research phase ${researchResult.status}`, {
          phase: 'research_done',
          status: researchResult.status,
        });
      allEvents.push(researchDoneEvent);
      this.appendEvent(projectSlug, runId, researchDoneEvent);
    }

    // ─── Production Phase ───
    const prodEvent = this.createEvent(runId, lens.name, 'state_change',
      `Entering production phase`, { phase: 'producing' });
    allEvents.push(prodEvent);
    this.appendEvent(projectSlug, runId, prodEvent);

    const productionPrompt = buildProductionPrompt(
      lens, taskPrompt, researchOutput, priorLensOutput,
    );
    const systemPrompt = buildLensSystemPrompt(lens);

    const productionResult = await this.adapter.spawn(
      productionPrompt,
      lens.tools,
      {
        systemPrompt,
        run_id: runId,
        lens_name: lens.name,
        cwd: lensWorkspace,
        researchOutput,
        priorLensOutput,
        feedback,
      },
    );

    // Save production output
    const outputDir = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'lenses', lens.id, 'output',
    );
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `${runId}.json`), JSON.stringify({
      lens: lens.name,
      run_id: runId,
      timestamp: new Date().toISOString(),
      status: productionResult.status,
      output: productionResult.output,
    }, null, 2));

    allEvents.push(...productionResult.events);
    for (const e of productionResult.events) {
      this.appendEvent(projectSlug, runId, e);
    }

    // Emit completion event
    const doneEvent = this.createEvent(runId, 'orchestrator', 'state_change',
      `Lens ${lens.name} finished: ${productionResult.status}`, {
        lens_id: lens.id,
        phase: 'done',
        status: productionResult.status,
      });
    allEvents.push(doneEvent);
    this.appendEvent(projectSlug, runId, doneEvent);

    return {
      lens,
      researchResult,
      productionResult,
      events: allEvents,
    };
  }

  /**
   * Spawn with timeout enforcement for research phases.
   * If maxDuration exceeded, kills agent, returns partial output.
   */
  private async spawnWithTimeout(
    prompt: string,
    tools: string[],
    context: Record<string, any>,
    timeoutMs: number,
  ): Promise<AgentResult> {
    let agentId: string | undefined;

    const spawnPromise = this.adapter.spawn(prompt, tools, context).then(result => {
      agentId = result.id;
      return result;
    });

    const timeoutPromise = new Promise<AgentResult>((resolve) => {
      setTimeout(async () => {
        if (agentId) {
          await this.adapter.kill(agentId);
        }
        resolve({
          id: agentId || uuid(),
          status: 'failed',
          output: 'Research phase timed out. Partial output may be available in workspace.',
          events: [{
            id: uuid(),
            timestamp: new Date().toISOString(),
            run_id: context.run_id || '',
            actor: context.lens_name || 'unknown',
            type: 'error',
            content: `Research phase exceeded ${timeoutMs / 1000}s limit`,
            metadata: { timeout: true },
          }],
        });
      }, timeoutMs);
    });

    return Promise.race([spawnPromise, timeoutPromise]);
  }

  /**
   * Initialize a run: create the run directory and meta.json.
   */
  initRun(projectSlug: string, runId: string, lenses: LensConfig[]): RunMeta {
    const runDir = path.join(this.worldBenchRoot, 'projects', projectSlug, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const meta: RunMeta = {
      run_id: runId,
      project_slug: projectSlug,
      started_at: new Date().toISOString(),
      status: 'running',
      lenses: lenses.map(l => ({
        slug: l.id,
        status: 'pending',
      })),
    };

    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * Finalize a run: update meta.json with completion status.
   */
  finalizeRun(projectSlug: string, runId: string, results: LensRunResult[]): RunMeta {
    const runDir = path.join(this.worldBenchRoot, 'projects', projectSlug, 'runs', runId);
    const metaPath = path.join(runDir, 'meta.json');
    const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    meta.finished_at = new Date().toISOString();

    const anyFailed = results.some(r => r.productionResult?.status === 'failed');
    const allFailed = results.every(r => r.productionResult?.status === 'failed');

    meta.status = allFailed ? 'failed' : anyFailed ? 'partial' : 'completed';

    for (const result of results) {
      const lensMeta = meta.lenses.find(l => l.slug === result.lens.id);
      if (lensMeta) {
        lensMeta.status = result.productionResult?.status === 'completed' ? 'completed' : 'failed';
        lensMeta.finished_at = new Date().toISOString();
      }
    }

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  // ─── Event Helpers ───

  private createEvent(
    runId: string,
    actor: string,
    type: WorkflowEvent['type'],
    content: string,
    metadata?: Record<string, any>,
    ref?: string,
  ): WorkflowEvent {
    return {
      id: uuid(),
      timestamp: new Date().toISOString(),
      run_id: runId,
      actor,
      type,
      content,
      metadata,
      ref,
    };
  }

  private appendEvent(projectSlug: string, runId: string, event: WorkflowEvent): void {
    const eventsFile = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'runs', runId, 'events.jsonl',
    );
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
  }
}
