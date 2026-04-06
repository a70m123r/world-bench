// World-Bench v0.4 — Lens Manager
// Spawns lens agents via AgentAdapter, monitors lifecycle,
// handles research phase (with timeout), writes events.
// Uses SDK file checkpointing for workspace rollback on failure.

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import {
  LensConfig,
  AgentResult,
  WorkflowEvent,
  RunMeta,
  STEM_CELL_DENIED,
} from '../agents/types';
import { ClaudeAgentAdapter } from './agent-adapter';
import {
  buildLensSystemPrompt,
  buildResearchPrompt,
  buildProductionPrompt,
} from '../agents/base-lens-agent';
import { createEvent, appendEvent, setWorldBenchRoot } from './event-log';
import { PermissionManager } from './permission-manager';

const DEFAULT_RESEARCH_DURATION = 120; // seconds

export interface LensRunResult {
  lens: LensConfig;
  researchResult?: AgentResult;
  productionResult?: AgentResult;
  events: WorkflowEvent[];
  hardeningSuggestion?: string; // Set when tool usage has converged
}

export class LensManager {
  private adapter: ClaudeAgentAdapter;
  private worldBenchRoot: string;
  private permissionManager: PermissionManager;
  private mcpServers: Record<string, any> | null = null;

  constructor(adapter: ClaudeAgentAdapter, worldBenchRoot: string) {
    this.adapter = adapter;
    this.worldBenchRoot = worldBenchRoot;
    this.permissionManager = new PermissionManager(worldBenchRoot);
    this.loadMcpConfig();
  }

  private loadMcpConfig(): void {
    const mcpPath = path.join(this.worldBenchRoot, 'mcp-servers.json');
    try {
      if (fs.existsSync(mcpPath)) {
        let raw = fs.readFileSync(mcpPath, 'utf-8');
        // Interpolate env vars (same pattern as index.ts)
        raw = raw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
        const config = JSON.parse(raw);
        this.mcpServers = config.mcpServers || null;
      }
    } catch { }
    setWorldBenchRoot(this.worldBenchRoot);
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
    const startEvent = createEvent(runId, 'orchestrator', 'state_change',
      `Starting lens: ${lens.name}`, { lens_id: lens.id, phase: 'start' });
    allEvents.push(startEvent);
    appendEvent(projectSlug, runId, startEvent);

    const lensWorkspace = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'lenses', lens.id, 'workspace',
    );
    fs.mkdirSync(lensWorkspace, { recursive: true });

    // Resolve effective tool permissions
    const effectiveTools = this.permissionManager.getEffectiveTools(lens);
    const deniedTools = [...(lens.permissions?.denied || STEM_CELL_DENIED)];

    // v0.5: load lens session ID for resume support
    const lensJsonPath = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'lenses', lens.id, 'lens.json',
    );
    let resumeSessionId: string | undefined;
    try {
      if (fs.existsSync(lensJsonPath)) {
        const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
        resumeSessionId = lensData.sessionId;
      }
    } catch { }

    // Check if lens needs MCP tools (any tool starting with 'mcp__')
    const mcpToolNames = effectiveTools.filter(t => t.startsWith('mcp__'));
    const needsMcp = mcpToolNames.length > 0;

    const baseContext: Record<string, any> = {
      systemPrompt: buildLensSystemPrompt(lens),
      run_id: runId,
      lens_name: lens.name,
      purpose: lens.purpose,
      cwd: lensWorkspace,
      projectSlug,
      deniedTools,
      resumeSessionId,
      permissionManager: this.permissionManager,
      lensConfig: lens,
    };

    // Pass MCP servers to lens if it needs MCP tools
    if (needsMcp && this.mcpServers) {
      baseContext.mcpServers = this.mcpServers;
      baseContext.mcpTools = mcpToolNames;
    }

    // ─── Research Phase ───
    if (lens.researchPhase.enabled) {
      const researchEvent = createEvent(runId, lens.name, 'state_change',
        `Entering research phase`, { phase: 'researching' });
      allEvents.push(researchEvent);
      appendEvent(projectSlug, runId, researchEvent);

      const researchPrompt = buildResearchPrompt(lens);
      const maxDuration = (lens.researchPhase.maxDuration || DEFAULT_RESEARCH_DURATION) * 1000;

      researchResult = await this.spawnWithTimeout(
        researchPrompt,
        effectiveTools,
        baseContext,
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
        appendEvent(projectSlug, runId, e);
      }

      // If research failed, attempt workspace rollback via file checkpoint
      if (researchResult.status === 'failed') {
        const rewound = await this.adapter.rewindOnFailure(researchResult);
        if (rewound) {
          const rewindEvent = createEvent(runId, 'orchestrator', 'state_change',
            `Research workspace rolled back via file checkpoint`, { phase: 'rewind' });
          allEvents.push(rewindEvent);
          appendEvent(projectSlug, runId, rewindEvent);
        }
      }

      const researchDoneEvent = createEvent(runId, lens.name, 'state_change',
        `Research phase ${researchResult.status}`, {
          phase: 'research_done',
          status: researchResult.status,
        });
      allEvents.push(researchDoneEvent);
      appendEvent(projectSlug, runId, researchDoneEvent);
    }

    // ─── Production Phase ───
    const prodEvent = createEvent(runId, lens.name, 'state_change',
      `Entering production phase`, { phase: 'producing' });
    allEvents.push(prodEvent);
    appendEvent(projectSlug, runId, prodEvent);

    const productionPrompt = buildProductionPrompt(
      lens, taskPrompt, researchOutput, priorLensOutput,
    );

    const productionResult = await this.adapter.spawn(
      productionPrompt,
      lens.tools,
      {
        ...baseContext,
        researchOutput,
        priorLensOutput,
        feedback,
      },
    );

    // If production failed, attempt workspace rollback via file checkpoint
    if (productionResult.status === 'failed') {
      const rewound = await this.adapter.rewindOnFailure(productionResult);
      if (rewound) {
        const rewindEvent = createEvent(runId, 'orchestrator', 'state_change',
          `Production workspace rolled back via file checkpoint`, { phase: 'rewind' });
        allEvents.push(rewindEvent);
        appendEvent(projectSlug, runId, rewindEvent);
      }
    }

    // v0.5: persist lens session ID for resume on next run
    const prodSessionId = (productionResult as any).sessionId;
    if (prodSessionId) {
      try {
        const lensData = fs.existsSync(lensJsonPath)
          ? JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'))
          : { ...lens };
        lensData.sessionId = prodSessionId;
        fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));
      } catch { }
    }

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
      appendEvent(projectSlug, runId, e);
    }

    // Track tool usage for permission hardening
    let hardeningSuggestion: string | undefined;
    if (productionResult.status === 'completed') {
      const runTools = allEvents
        .filter(e => e.actor === lens.name && e.type === 'message' && e.metadata?.tool)
        .map(e => e.metadata!.tool as string);
      const hardening = this.permissionManager.updateToolUsage(lens, projectSlug, runTools);
      if (hardening.suggest) {
        hardeningSuggestion = hardening.message;
        const hardenEvent = createEvent(runId, 'orchestrator', 'state_change',
          hardening.message || 'Lens ready for hardening',
          { lens_id: lens.id, phase: 'hardening_suggestion' });
        allEvents.push(hardenEvent);
        appendEvent(projectSlug, runId, hardenEvent);
      }
    }

    // Emit completion event
    const doneEvent = createEvent(runId, 'orchestrator', 'state_change',
      `Lens ${lens.name} finished: ${productionResult.status}`, {
        lens_id: lens.id,
        phase: 'done',
        status: productionResult.status,
      });
    allEvents.push(doneEvent);
    appendEvent(projectSlug, runId, doneEvent);

    return {
      lens,
      researchResult,
      productionResult,
      events: allEvents,
      hardeningSuggestion,
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
    let timedOut = false;

    const spawnPromise = this.adapter.spawn(prompt, tools, context).then(result => {
      agentId = result.id;
      return result;
    });

    const timeoutPromise = new Promise<AgentResult>((resolve) => {
      setTimeout(() => {
        timedOut = true;

        // Use AbortController directly — works even if spawn hasn't resolved yet.
        // This is the fix for the race condition: kill(id) requires agentId which
        // may not be set yet. AbortController aborts the underlying SDK query.
        if (agentId) {
          const controller = this.adapter.getAbortController(agentId);
          if (controller) controller.abort();
        }
        // If agentId isn't set yet, the spawn will complete and find timedOut=true

        resolve({
          id: agentId || uuid(),
          status: 'failed',
          output: 'Research phase timed out. Partial output may be available in workspace.',
          events: [createEvent(
            context.run_id || '', context.lens_name || 'unknown', 'error',
            `Research phase exceeded ${timeoutMs / 1000}s limit`,
            { timeout: true },
          )],
        });
      }, timeoutMs);
    });

    const result = await Promise.race([spawnPromise, timeoutPromise]);

    // If spawn resolved after timeout, clean up the ghost agent
    if (timedOut && agentId) {
      await this.adapter.kill(agentId);
    }

    return result;
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
}
