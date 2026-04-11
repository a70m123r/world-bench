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
    // v0.6.6: streaming context threads terminal + verbose flag into the
    // SDK hooks so PostToolUse/PostToolUseFailure can post to the lens
    // channel in real time. `any` for terminal to avoid circular import.
    streamingContext?: { terminal: any; lensId: string; verbose: boolean },
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
      // v0.6.5.8: default production maxTurns raised from 10 to 30. The first
      // Harvester render (run 09ac10dd, 2026-04-09 03:19:30) hit the 10-turn
      // ceiling after burning turns on a wrong-Slack-MCP OAuth loop + Bash
      // quoting failures — before doing any useful work. Research phases + real
      // implementation legitimately need more than 10 turns. The per-lens
      // maxTurns override in lens.json takes precedence if present.
      maxTurns: (lens as any).maxTurns || 30,
      // v0.6.6: lens channel streaming context (threaded from executeRun)
      ...(streamingContext ? {
        terminal: streamingContext.terminal,
        lensId: streamingContext.lensId,
        verbose: streamingContext.verbose,
      } : {}),
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
   * v0.6.4: Meet a lens before render.
   *
   * Spawns the stem cell in conversation-only mode with a meeting prompt.
   * The lens reads its brief, surfaces questions, flags contract concerns,
   * suggests amendments — and then stops. No research phase. No production.
   * No artifact writes. Just an introduction conversation.
   *
   * Council direction (v0.6.4 escalation, 2026-04-08):
   *   - "spawn lens in conversation-only mode" (Claw)
   *   - "lens receives brief + current proposal" (Claw)
   *   - "allowed outputs: questions, risks, boundary corrections, suggested amendments" (Claw)
   *   - "forbidden outputs: research run, artifact writes, side effects" (Claw)
   *   - "the entire value of the meet is that the stem cell surfaces questions
   *      the Orchestrator can't predict" (Soren)
   *
   * Mechanical guardrails (enforced here, not just in the prompt):
   *   - Tool list is filtered to remove ALL mutation tools (Write/Edit/NotebookEdit/MultiEdit)
   *     so the lens cannot write artifacts even if its prompt slips
   *   - Research phase is NOT invoked
   *   - Production phase is NOT invoked
   *   - The session ID is captured and returned for render_lens to resume
   *
   * Returns the lens's response text + the session ID for resume continuity.
   */
  async runLensMeet(
    lens: LensConfig,
    continuationMessage?: string,
    sessionId?: string,
    speaker?: string,
    // v0.6.9: 'conversation' mode — post-render lens channel chat. The lens
    // has been rendered, has a brief + production history. This is NOT a
    // pre-render introduction meeting. The message is from Pav (or Orchestrator)
    // talking to the lens in its channel.
    mode?: 'preflight' | 'continuation' | 'conversation',
  ): Promise<{ output: string; sessionId?: string; status: 'completed' | 'failed' }> {
    // v0.6.5: Reject mixed states hard for continuation mode.
    // v0.6.9: 'conversation' mode bypasses this check — it has a message but
    // intentionally no sessionId (fresh conversation with an already-rendered lens).
    const effectiveMode = mode || (continuationMessage && sessionId ? 'continuation' : continuationMessage ? 'conversation' : 'preflight');

    if (effectiveMode === 'continuation' && (!continuationMessage || !sessionId)) {
      throw new Error(
        `runLensMeet continuation mode requires BOTH continuationMessage AND sessionId. ` +
        `Got: continuationMessage=${!!continuationMessage}, sessionId=${!!sessionId}. ` +
        `This is the v0.6.5 hard-fail contract — silent param drops are forbidden.`,
      );
    }
    const isContinuation = effectiveMode === 'continuation';

    // Strip all mutation tools from the lens's tool list — meeting is read-only.
    // The lens still has Read/Glob/Grep/WebSearch/WebFetch (if those were in its
    // tools list) so it can carry small bricks during the meeting if it wants.
    const MUTATION_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
    const meetTools = (lens.tools || []).filter(t => !MUTATION_TOOLS.has(t));

    // Build the meeting prompt. The lens's normal system prompt stays intact
    // (so it knows its identity, goal, contracts). The meeting framing comes
    // through the user message — that's the per-call mode signal.
    const defaultIntro = `MEETING MODE — you have not been rendered yet. This is your introduction.

Read your brief carefully — your goal, your input/output contracts, your constraints, the framework you operate in. Then respond with:

1. *Your understanding of the goal* (one paragraph in your own words — confirms you read it correctly)
2. *Questions you have* before committing to the work — anything ambiguous, missing, or that would change your approach
3. *Contract concerns* — any field that's underspecified, that you don't think you can produce, or that you'd shape differently
4. *Suggested amendments* — concrete proposals if you'd change something in the brief or contract
5. *Anything you'd push back on* — the brief is not sacred. If something feels wrong, say so.

Do NOT begin work. Do NOT write any files. Do NOT run a research harvest. This is a conversation, not an execution. After Pav reviews your response and (possibly) amends the brief, you'll be invoked again with the production task — at which point your full conversation history will be available to you, so anything you say here is preserved.

If everything looks good and you have no questions, say so explicitly. Silence is not consent.`;

    // Build the user message based on mode
    let meetPrompt: string;
    if (effectiveMode === 'continuation') {
      const speakerLabel = speaker || 'pav';
      meetPrompt = `CONVERSATION CONTINUES — you've been here before. Read this new turn from the conversation and respond.

From ${speakerLabel}:
${continuationMessage}

Respond directly to what you just read. You can ask clarifying questions, push back, suggest amendments, or proceed with what they're asking. You still have not been rendered for production work — this is still the meeting phase. If they're asking you to do production work, tell them you're still in meeting mode and need to be explicitly rendered.`;
    } else if (effectiveMode === 'conversation') {
      // v0.6.9: post-render lens channel conversation. The lens has been rendered
      // and has production experience. This is Pav (or the Orchestrator) talking
      // to it in its channel — not a pre-render introduction.
      meetPrompt = `You are in your lens channel. You have been rendered and have completed production runs. Someone is talking to you. Read the context block (if present) to understand your current state, then respond naturally.

${continuationMessage}

You can:
- Answer questions about your work, output, or approach
- Discuss your contracts and how they're holding up
- Suggest improvements to your own config or implementation
- Read files in your workspace if you need to check something
- Write notes to memory/scratchpad.md for your future self

Respond directly and conversationally. You are an architect and maintainer of your lens, not a script runner.`;
    } else {
      meetPrompt = defaultIntro;
    }

    // Build context — same as runLens, but no run_id (no run yet), no
    // research phase, no priorLensOutput. Just identity + brief.
    const meetContext: Record<string, any> = {
      systemPrompt: buildLensSystemPrompt(lens),
      lens_name: lens.name,
      purpose: lens.purpose,
      cwd: this.worldBenchRoot, // safe cwd; the lens has no workspace yet
      deniedTools: [...(lens.permissions?.denied || STEM_CELL_DENIED), ...Array.from(MUTATION_TOOLS)],
      maxTurns: 5, // meetings are short by design
    };

    // v0.6.5: thread sessionId through to the adapter for resume.
    // The adapter at agent-adapter.ts:52 already supports `resumeSessionId` —
    // the plumbing exists, was never connected to the meet path until now.
    if (sessionId) {
      meetContext.resumeSessionId = sessionId;
    }

    // Wire MCP servers if the lens needs them (e.g. to read sample data).
    // Slack MCP read tools stay available so the lens can carry a brick.
    const mcpToolNames = meetTools.filter(t => t.startsWith('mcp__'));
    if (mcpToolNames.length > 0 && this.mcpServers) {
      meetContext.mcpServers = this.mcpServers;
      meetContext.mcpTools = mcpToolNames;
    }

    const modeLabel = isContinuation ? `continuation (resume ${sessionId!.slice(0, 8)})` : 'preflight';
    console.log(`[LensManager] Meeting lens "${lens.id}" in ${modeLabel} mode with ${meetTools.length} tool(s)`);
    const result = await this.adapter.spawn(meetPrompt, meetTools, meetContext);

    return {
      output: result.output,
      sessionId: (result as any).sessionId,
      status: result.status,
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
