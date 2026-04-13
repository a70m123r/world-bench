// World-Bench v0.4 — Orchestrator Entry Point
// The OS of the system. Interprets Pav's intent, differentiates stem cells
// into lenses, routes work, manages state, handles handoffs.

// v0.7 DEBUG: lens.json write trap — remove after clobber is found
import './lens-json-trap';

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import dotenv from 'dotenv';
import {
  LensConfig,
  LensSketch,
  ProjectMeta,
  ProjectSeed,
  WorkflowEvent,
  OrchestratorCommand,
  OrchestratorState,
  STEM_CELL_ALLOWED,
  STEM_CELL_DENIED,
} from '../agents/types';
import { ClaudeAgentAdapter } from './agent-adapter';
import { LensManager, LensRunResult } from './lens-manager';
import { Terminal } from './terminal';
import { ContextProvider } from './context-provider';
import { SeedManager, NoIgnitedSeedError, SeedNotYetApprovedError } from './seed-manager';
import {
  transitionMaturity, getMaturity, countConsecutiveCleanRenders,
  savePromptVersion, countWastedTurns,
} from './maturity';
import { buildLensContext } from './lens-context';

// Load env from orchestrator config dir
dotenv.config({ path: path.join(__dirname, 'config', '.env'), override: true });

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const PAV_USER_ID = process.env.PAV_USER_ID || 'U0AL61DRV6D';

// v0.7: unified state — same spine as lenses
export class Orchestrator {
  private adapter: ClaudeAgentAdapter;
  private lensManager: LensManager;
  private terminal: Terminal;
  private contextProvider: ContextProvider | null = null;
  private orchestratorState!: OrchestratorState;
  private lastPromptHash: string | null = null;
  private mcpServers: Record<string, any> | null = null;
  private availableMcpTools: string[] = [];
  private seedManager: SeedManager;

  // v0.6.4 + v0.6.5: pending meet sessions, keyed by `${projectSlug}:${lensId}`.
  // Populated by meet_lens / continue_meet after a successful meeting. Consumed by
  // attachLensToProject during render_lens, which writes the sessionId into the
  // new lens.json so runLens picks it up as resumeSessionId.
  //
  // v0.6.5 expansion: each entry now also stores meetChannelId + meetThreadTs so
  // the thread-aware routing can look up "what session does this thread belong to?"
  // via the threadToSession reverse map below.
  //
  // RESTART VOLATILITY (G5): in-memory only. Pre-render meet sessions are lost on
  // restart. Rendered lenses recover via rehydrateLensSessions() reading lens.json.
  private pendingMeetSessions: Map<string, {
    sessionId: string;
    meetChannelId: string;
    meetThreadTs: string;
  }> = new Map();

  // v0.6.5: reverse-lookup map for thread-aware routing (G1).
  // Key is `${channelId}:${threadTs}` — compound, NEVER just threadTs alone,
  // because Slack thread timestamps are unique per channel, not globally.
  // Value points back at the lens session that owns this thread.
  // PUBLIC so the Terminal can read it during the message routing decision.
  // (Read-only by convention — only Orchestrator methods mutate it.)
  threadToSession: Map<string, {
    projectSlug: string;
    lensId: string;
    sessionId: string;
  }> = new Map();

  // v0.6.5: per-thread serialization mutex (G3). Prevents concurrent continue_meet
  // dispatches against the same thread from forking the conversation timeline.
  // Key is `${channelId}:${threadTs}`. Value is true while a continue_meet is in flight.
  private threadDispatchLocks: Set<string> = new Set();

  constructor() {
    this.adapter = new ClaudeAgentAdapter();
    this.lensManager = new LensManager(this.adapter, WORLD_BENCH_ROOT);
    this.seedManager = new SeedManager(WORLD_BENCH_ROOT);
    this.terminal = new Terminal(this);
    this.loadMcpConfig();
    this.loadOrchestratorState();
    // v0.6.5 (G5): rebuild thread→session map from disk for rendered lenses
    this.rehydrateLensSessions();
    // v0.7: ensure scratchpad exists
    const scratchpadPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'memory', 'scratchpad.md');
    if (!fs.existsSync(scratchpadPath)) {
      fs.mkdirSync(path.dirname(scratchpadPath), { recursive: true });
      fs.writeFileSync(scratchpadPath, '# Orchestrator Scratchpad\n\n> Notes you leave here persist across sessions and appear in your context on every wake.\n');
    }
  }

  /** Called by Terminal after Slack client is ready */
  initContextProvider(client: any, orchestratorChannelId: string, botUserId: string): void {
    this.contextProvider = new ContextProvider(client);
    this.contextProvider.setOrchestratorChannel(orchestratorChannelId);
    this.contextProvider.setBotUserId(botUserId);
    console.log('[Orchestrator] Context provider initialized.');
  }

  private loadMcpConfig(): void {
    const mcpPath = path.join(WORLD_BENCH_ROOT, 'mcp-servers.json');
    try {
      if (fs.existsSync(mcpPath)) {
        let raw = fs.readFileSync(mcpPath, 'utf-8');
        raw = raw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
        const config = JSON.parse(raw);
        this.mcpServers = config.mcpServers || null;

        // Enumerate available MCP tool names from server source files
        this.availableMcpTools = this.enumerateMcpTools();
        console.log(`[Orchestrator] MCP servers loaded: ${Object.keys(this.mcpServers || {}).join(', ')}`);
        console.log(`[Orchestrator] MCP tools available: ${this.availableMcpTools.length}`);
      }
    } catch (e: any) {
      console.warn(`[Orchestrator] Failed to load MCP config: ${e.message}`);
    }
  }

  /**
   * Enumerate canonical MCP tool names from known servers.
   * Injected into system prompt so the Orchestrator doesn't hallucinate tool names.
   */
  private enumerateMcpTools(): string[] {
    const tools: string[] = [];

    // Slack MCP tools (from slack-mcp-server/src/index.ts)
    const slackTools = [
      'slack_read_channel', 'slack_read_thread', 'slack_read_dm',
      'slack_post_message', 'slack_search', 'slack_list_channels',
      'slack_react', 'slack_user_info', 'slack_create_canvas', 'slack_channel_info',
    ];
    for (const t of slackTools) tools.push(`mcp__slack__${t}`);

    // Memory MCP tools (@modelcontextprotocol/server-memory)
    const memoryTools = [
      'create_entities', 'add_observations', 'create_relations',
      'search_nodes', 'open_nodes', 'read_graph',
      'delete_entities', 'delete_observations', 'delete_relations',
    ];
    for (const t of memoryTools) tools.push(`mcp__memory__${t}`);

    return tools;
  }

  private loadOrchestratorState(): void {
    // v0.7: unified state file replaces the legacy sessions.json Map
    const statePath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'orchestrator.json');
    try {
      if (fs.existsSync(statePath)) {
        this.orchestratorState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        console.log(`[Orchestrator] State loaded: maturity=${this.orchestratorState.maturity}, session=${this.orchestratorState.sessionId?.slice(0, 8) || 'none'}`);
        return;
      }
    } catch (e: any) {
      console.warn(`[Orchestrator] Failed to load orchestrator.json: ${e.message}`);
    }

    // Migration: read legacy sessions.json if orchestrator.json doesn't exist
    const legacyPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'sessions.json');
    let migratedSessionId: string | undefined;
    try {
      if (fs.existsSync(legacyPath)) {
        const entries: [string, any][] = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        const main = entries.find(([key]) => key === 'orchestrator-main');
        if (main) migratedSessionId = main[1].sessionId;
        console.log(`[Orchestrator] Migrated sessionId from sessions.json: ${migratedSessionId?.slice(0, 8) || 'none'}`);
      }
    } catch { }

    // First boot or migration — create default state
    this.orchestratorState = {
      sessionId: migratedSessionId,
      sessionCwd: WORLD_BENCH_ROOT,
      maturity: 'settling',
      maturityLog: [{
        from: 'discovery' as any,
        to: 'settling' as any,
        reason: 'v0.7 unification — Orchestrator has been running since v0.4',
        triggeredBy: 'automatic',
        timestamp: new Date().toISOString(),
      }],
      activePromptVersion: 1,
      lastActivity: new Date().toISOString(),
    };
    this.saveOrchestratorState();
  }

  private saveOrchestratorState(): void {
    const statePath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'orchestrator.json');
    try {
      fs.writeFileSync(statePath, JSON.stringify(this.orchestratorState, null, 2));
    } catch (e: any) {
      console.warn(`[Orchestrator] Failed to save orchestrator.json: ${e.message}`);
    }
  }

  private hashString(s: string): string {
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(36);
  }

  private loadMemoryContext(): string {
    const sections: string[] = [];

    // MEMORY.md — orchestrator's own memory index
    const memoryMd = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'memory', 'MEMORY.md');
    if (fs.existsSync(memoryMd)) {
      const content = fs.readFileSync(memoryMd, 'utf-8').trim();
      if (content) sections.push(`## Memory Index\n${content}`);
    }

    // Breadcrumbs — council-wide situational awareness
    const breadcrumbs = path.join(WORLD_BENCH_ROOT, '..', 'council', 'BREADCRUMBS.md');
    if (fs.existsSync(breadcrumbs)) {
      const content = fs.readFileSync(breadcrumbs, 'utf-8').trim();
      if (content) {
        const tail = content.length > 2000 ? '...\n' + content.slice(-2000) : content;
        sections.push(`## Recent Breadcrumbs (council situational awareness)\n${tail}`);
      }
    }

    // v0.6: Active seeds — replaces both project state listing and ROOM-ZERO-STATE ingest.
    // The Orchestrator resumes from where Pav left off, NOT from a cron-written priority stack.
    // ROOM-ZERO-STATE.md auto-ingest deleted per SPEC-orchestrator-v0.6-seed-lifecycle.md.
    // The unauthorized mandate channel (Spinner cron → state file → Orchestrator worldview)
    // is severed. Mandate has only one source: Pav-approved artifact or direct Pav instruction.
    const activeSeedsContext = this.seedManager.formatActiveSeedsForContext();
    if (activeSeedsContext) {
      sections.push(activeSeedsContext);
    }

    // Legacy project listing — pre-v0.6 projects only (legacy_pre_seed marker).
    // Post-v0.6 projects appear in active seeds above.
    const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
    try {
      if (fs.existsSync(projectsDir)) {
        const legacySummaries: string[] = [];
        for (const slug of fs.readdirSync(projectsDir)) {
          const pjPath = path.join(projectsDir, slug, 'project.json');
          if (!fs.existsSync(pjPath)) continue;
          const pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
          // Only show pre-seed legacy projects here — the rest go through active seeds
          if (!pj.legacy_pre_seed) continue;
          const lenses = pj.lenses?.join(', ') || 'none';
          legacySummaries.push(`- **${pj.name}** (\`${slug}\`) [pre-seed legacy]: lenses: ${lenses}`);
        }
        if (legacySummaries.length > 0) {
          sections.push(`## Legacy Projects (pre-v0.6, grandfathered)\n${legacySummaries.join('\n')}`);
        }
      }
    } catch { }

    // v0.7: Orchestrator scratchpad — notes to future self
    const scratchpadPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'memory', 'scratchpad.md');
    try {
      if (fs.existsSync(scratchpadPath)) {
        const content = fs.readFileSync(scratchpadPath, 'utf-8').trim();
        if (content && content !== '# Orchestrator Scratchpad') {
          const capped = content.length > 2000
            ? content.slice(0, 2000) + '\n...(truncated, full file at orchestrator/memory/scratchpad.md)'
            : content;
          sections.push(`## Your Scratchpad (notes you left for yourself)\n${capped}`);
        }
      }
    } catch { }

    // v0.7: Orchestrator state summary
    if (this.orchestratorState) {
      const stateLines: string[] = [];
      stateLines.push(`## Your State (orchestrator.json)`);
      stateLines.push(`- Maturity: ${this.orchestratorState.maturity}`);
      stateLines.push(`- Prompt version: ${this.orchestratorState.activePromptVersion}`);
      stateLines.push(`- Session: ${this.orchestratorState.sessionId?.slice(0, 8) || 'none'}`);
      if (this.orchestratorState.maturityLog?.length > 0) {
        const last3 = this.orchestratorState.maturityLog.slice(-3);
        stateLines.push('- Recent transitions:');
        for (const entry of last3) {
          stateLines.push(`  - ${entry.from} → ${entry.to}: ${entry.reason}`);
        }
      }
      sections.push(stateLines.join('\n'));
    }

    // v0.7: All-project SHOOTS.md — cross-project awareness
    try {
      if (fs.existsSync(projectsDir)) {
        const shootsSections: string[] = [];
        let projectCount = 0;
        for (const slug of fs.readdirSync(projectsDir)) {
          if (projectCount >= 3) break; // Cap at 3 projects per Claw's guard
          const shootsPath = path.join(projectsDir, slug, 'SHOOTS.md');
          if (!fs.existsSync(shootsPath)) continue;
          const content = fs.readFileSync(shootsPath, 'utf-8').trim();
          if (!content) continue;
          const capped = content.length > 1500
            ? content.slice(0, 1500) + '\n...(truncated)'
            : content;
          shootsSections.push(`### ${slug}\n${capped}`);
          projectCount++;
        }
        if (shootsSections.length > 0) {
          sections.push(`## Project Shoots (living state)\n${shootsSections.join('\n\n')}`);
        }
      }
    } catch { }

    if (sections.length === 0) return '';
    return '\n\n---\n# Context (loaded on wake)\n' + sections.join('\n\n');
  }

  async start(): Promise<void> {
    console.log('[Orchestrator] Starting World-Bench v0.4...');
    console.log(`[Orchestrator] Root: ${WORLD_BENCH_ROOT}`);
    await this.terminal.start();
    console.log('[Orchestrator] Terminal connected. Listening on #orchestrator.');
  }

  // ─── Project Genesis ───

  /**
   * Create a new project: filesystem dirs first, Slack channels second.
   * Rollback dirs if Slack fails.
   */
  async createProject(
    name: string,
    slug: string,
    lensConfigs: LensConfig[],
  ): Promise<ProjectMeta> {
    // v0.6 HARD GATE: refuse to run unless an ignited seed exists for this slug.
    // The Orchestrator cannot create projects from intent parsing alone.
    // Only render_lens (operating against an ignited seed) may call this method.
    // Throws NoIgnitedSeedError if no ignited seed exists.
    this.seedManager.requireIgnited(slug);

    // v0.6: split into bootstrapProject + attachLensToProject so we can
    // add lenses one at a time instead of all at once.
    if (!this.projectExists(slug)) {
      await this.bootstrapProject(name, slug);
    }
    for (const lens of lensConfigs) {
      await this.attachLensToProject(slug, lens);
    }

    const meta = this.loadProjectMeta(slug);
    if (!meta) throw new Error(`Project ${slug} bootstrap failed: meta missing`);
    return meta;
  }

  /**
   * Check if a project exists on disk (project.json present).
   */
  private projectExists(slug: string): boolean {
    return fs.existsSync(path.join(WORLD_BENCH_ROOT, 'projects', slug, 'project.json'));
  }

  /**
   * Load project metadata from disk.
   */
  private loadProjectMeta(slug: string): ProjectMeta | null {
    const pjPath = path.join(WORLD_BENCH_ROOT, 'projects', slug, 'project.json');
    if (!fs.existsSync(pjPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * v0.6: Bootstrap a project shell. Creates the project directory + project
   * Slack channel + project.json. NO lens directories. NO lens channels.
   * Lenses are attached one at a time via attachLensToProject().
   */
  async bootstrapProject(name: string, slug: string): Promise<ProjectMeta> {
    const projectDir = path.join(WORLD_BENCH_ROOT, 'projects', slug);

    // Step 1: Create project filesystem (no lens dirs)
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'runs'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'lenses'), { recursive: true });
    } catch (error: any) {
      console.error(`[Orchestrator] Project bootstrap failed: ${error.message}`);
      throw error;
    }

    // Step 2: Create the project Slack channel
    let projectChannelId: string | undefined;
    try {
      projectChannelId = await this.terminal.createChannel(
        `wb-proj-${slug}`,
        `World-Bench project: ${name}`,
      ) || undefined;
    } catch (error: any) {
      console.error(`[Orchestrator] Slack channel creation failed: ${error.message}`);
      console.error('[Orchestrator] Rolling back project directory...');
      fs.rmSync(projectDir, { recursive: true, force: true });
      throw error;
    }

    // Step 3: Write project.json
    const meta: ProjectMeta = {
      name,
      slug,
      created_at: new Date().toISOString(),
      project_channel_id: projectChannelId,
      lenses: [],
    };

    fs.writeFileSync(
      path.join(projectDir, 'project.json'),
      JSON.stringify(meta, null, 2),
    );

    console.log(`[Orchestrator] Project bootstrapped: ${slug}`);
    return meta;
  }

  /**
   * v0.6: Attach a single lens to an existing project. Creates the lens
   * directory + lens.json + lens Slack channel, then appends to project.json's
   * lenses array. This is the one-lens-at-a-time path.
   *
   * Idempotent: if the lens already exists, returns its existing config without
   * recreating the channel or rewriting the lens.json.
   */
  async attachLensToProject(
    slug: string,
    lens: LensConfig,
    meetSessionId?: string,
    meetChannelId?: string,
    meetThreadTs?: string,
  ): Promise<void> {
    const meta = this.loadProjectMeta(slug);
    if (!meta) {
      throw new Error(`Cannot attach lens: project ${slug} does not exist. Bootstrap it first.`);
    }

    // Idempotency check — if already attached, no-op
    if (meta.lenses.includes(lens.id)) {
      console.log(`[Orchestrator] Lens ${lens.id} already attached to ${slug}, skipping`);
      return;
    }

    const lensDir = path.join(WORLD_BENCH_ROOT, 'projects', slug, 'lenses', lens.id);

    // v0.6.5.7: Do NOT write the meet sessionId as lens.json.sessionId, because
    // lens-manager.runLens reads lens.json.sessionId and passes it as
    // resumeSessionId to the SDK. The SDK resume feature is cwd-scoped — session
    // jsonl files live under ~/.claude/projects/{cwd-hash}/ — and the meet runs
    // at `worldBenchRoot` cwd while render runs at the newly-created lens
    // workspace cwd. Different cwd hashes mean the render can't find the meet
    // session file, and Claude Code fails with "No conversation found with
    // session ID: ...". This was the v0.6.5.6 first-render failure on the
    // Harvester at 2026-04-09 02:55.
    //
    // The meet session is preserved under a different key (`meetSessionId`) for
    // provenance only. It's informational, not loadable as a resume target.
    // runLens spawns the first production turn with a fresh session; the
    // production session id is then written back into `lens.json.sessionId`
    // (lens-manager.ts:220), and subsequent runs resume normally because they
    // all share the same lens workspace cwd.
    //
    // The meet context is not lost — it was always intended to shape the brief
    // (the lens config's systemPrompt + contracts), not to be resumed verbatim
    // into production. The brief IS the persistent artifact. If a meet decision
    // matters, it needs to be encoded in the brief before render.
    //
    // v0.6.5: meetChannelId + meetThreadTs continue to be persisted so
    // rehydrateLensSessions can rebuild the threadToSession map after a restart.
    const lensWithSession: any = { ...lens };
    // Explicitly clear any pre-existing sessionId from the lens config object
    // (in case a re-render is happening and the old lens.json had a stale
    // sessionId from a prior broken attempt).
    delete lensWithSession.sessionId;
    if (meetSessionId) {
      lensWithSession.meetSessionId = meetSessionId;
      console.log(`[Orchestrator] Persisting meet session for ${slug}/${lens.id} as provenance (NOT as resume target): ${meetSessionId}`);
    }
    if (meetChannelId) lensWithSession.meetChannelId = meetChannelId;
    if (meetThreadTs) lensWithSession.meetThreadTs = meetThreadTs;

    // Create lens directory structure
    // v0.6.6 fix: preserve slack_channel_id + sessionId from existing lens.json
    // on re-attach. Previous code overwrote lens.json entirely with the fresh
    // action plan config, losing the channel ID (written on first attach) and
    // the production sessionId (written after first successful run). This caused
    // postToLensChannel to silently skip every post because getLensChannelId
    // returned null. Lens channels appeared empty despite successful renders.
    const lensJsonPath = path.join(lensDir, 'lens.json');
    let existingChannelId: string | undefined;
    let existingSessionId: string | undefined;
    let existingMaturity: string | undefined;
    let existingMaturityLog: any[] | undefined;
    let existingPromptVersion: number | undefined;
    try {
      if (fs.existsSync(lensJsonPath)) {
        const existing = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
        existingChannelId = existing.slack_channel_id;
        existingSessionId = existing.sessionId;
        existingMaturity = existing.maturity;
        existingMaturityLog = existing.maturityLog;
        existingPromptVersion = existing.activePromptVersion;
      }
    } catch { /* first attach — no existing file */ }

    // Carry forward preserved fields
    if (existingChannelId) (lensWithSession as any).slack_channel_id = existingChannelId;
    if (existingSessionId && !lensWithSession.sessionId) lensWithSession.sessionId = existingSessionId;
    // v0.6.7: preserve maturity state + log across re-attach
    if (existingMaturity) (lensWithSession as any).maturity = existingMaturity;
    if (existingMaturityLog) (lensWithSession as any).maturityLog = existingMaturityLog;
    if (existingPromptVersion) (lensWithSession as any).activePromptVersion = existingPromptVersion;
    // Set initial maturity if this is first attach
    if (!existingMaturity && !(lensWithSession as any).maturity) {
      (lensWithSession as any).maturity = 'discovery';
    }

    try {
      fs.mkdirSync(path.join(lensDir, 'memory'), { recursive: true });
      fs.mkdirSync(path.join(lensDir, 'workspace'), { recursive: true });
      fs.mkdirSync(path.join(lensDir, 'output'), { recursive: true });
      fs.writeFileSync(
        lensJsonPath,
        JSON.stringify(lensWithSession, null, 2),
      );
    } catch (error: any) {
      console.error(`[Orchestrator] Lens directory creation failed: ${error.message}`);
      throw error;
    }

    // Create lens Slack channel (skip if already exists from prior attach)
    let lensChannelId: string | undefined = existingChannelId;
    if (!lensChannelId) {
      try {
        lensChannelId = await this.terminal.createChannel(
          `wb-lens-${lens.id}`,
          `Lens: ${lens.name} — ${lens.purpose}`,
        ) || undefined;
      } catch (error: any) {
        console.error(`[Orchestrator] Lens channel creation failed: ${error.message}`);
        // Roll back the lens directory only — don't touch the project
        fs.rmSync(lensDir, { recursive: true, force: true });
        throw error;
      }
    }

    // Update lens.json with channel ID (first attach or if somehow missing)
    if (lensChannelId && !(lensWithSession as any).slack_channel_id) {
      const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
      lensData.slack_channel_id = lensChannelId;
      fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));
    }

    // Append to project.json's lenses array
    meta.lenses.push(lens.id);
    fs.writeFileSync(
      path.join(WORLD_BENCH_ROOT, 'projects', slug, 'project.json'),
      JSON.stringify(meta, null, 2),
    );

    // Advance seed status: ignited → rendering on first lens attached
    const seed = this.seedManager.loadSeed(slug);
    if (seed && seed.status === 'ignited') {
      this.seedManager.markRendering(slug);
    }

    console.log(`[Orchestrator] Lens attached: ${slug}/${lens.id}`);
  }

  // ─── Workflow Execution ───

  /**
   * Execute a full workflow run: spawn lenses sequentially, collect results.
   * Degrade-don't-kill: if a lens fails, continue with partial results.
   */
  async executeRun(
    projectSlug: string,
    lensConfigs: LensConfig[],
    taskPrompt: string,
    feedback?: string,
    // v0.6.6: options for lens channel streaming and post-run audit
    options?: { verbose?: boolean },
  ): Promise<{ runId: string; results: LensRunResult[]; summary: string }> {
    const runId = uuid();

    // Initialize run
    this.lensManager.initRun(projectSlug, runId, lensConfigs);

    await this.terminal.postToProject(
      projectSlug,
      `Starting run \`${runId.slice(0, 8)}\` with ${lensConfigs.length} lens(es): ${lensConfigs.map(l => l.name).join(', ')}`,
    );

    const results: LensRunResult[] = [];
    let priorOutput: string | undefined;

    // Sequential execution — one lens at a time (Claude Max rate limits)
    const verbose = options?.verbose ?? false;

    for (const lens of lensConfigs) {
      // v0.6.6: post start message to lens channel
      await this.terminal.postToLensChannel(
        projectSlug, lens.id, lens,
        `:satellite_antenna: **${lens.name}** run started — run \`${runId.slice(0, 8)}\``,
      );

      await this.terminal.postAsLens(
        lens,
        projectSlug,
        `Starting work on: ${taskPrompt.slice(0, 100)}...`,
      );

      // v0.6.9: inject situational awareness into the task prompt so the lens
      // knows its maturity, recent history, pipeline position, and SHOOTS.md
      // state during production renders — not just during conversation mode.
      let enrichedTaskPrompt = taskPrompt;
      try {
        const renderContext = await buildLensContext(
          projectSlug, lens.id,
          this.terminal.getSlackClient?.() || null,
        );
        if (renderContext) {
          enrichedTaskPrompt = `${renderContext}\n${taskPrompt}`;
        }
      } catch (e: any) {
        console.warn(`[Orchestrator] Render context injection failed (non-critical): ${e.message}`);
      }

      const result = await this.lensManager.runLens(
        lens, projectSlug, runId, enrichedTaskPrompt, priorOutput, feedback,
        // v0.6.6: thread terminal + verbose into the SDK hooks
        { terminal: this.terminal, lensId: lens.id, verbose },
      );
      results.push(result);

      // Post results — full output to lens channel, clean summary to project channel
      const status = result.productionResult?.status || 'unknown';
      const rawOutput = result.productionResult?.output || '';
      const humanSummary = summarizeOutput(rawOutput, lens.name);

      // Lens channel gets the full output (split if needed for Slack's 4000 char limit)
      await this.terminal.postToLensChannel(
        projectSlug, lens.id, lens,
        `**${lens.name}** finished: \`${status}\``,
      );
      for (const chunk of splitForSlack(rawOutput)) {
        await this.terminal.postToLensChannel(projectSlug, lens.id, lens, chunk);
      }

      // v0.6.6: post structured run audit to lens channel
      const audit = this.buildRunAudit(projectSlug, runId, lens.name, lens.id);
      await this.terminal.postToLensChannel(projectSlug, lens.id, lens, audit);

      // v0.6.9: check for escalation.json — lens may have written one during the run
      await this.checkAndPostEscalation(projectSlug, lens);

      // v0.6.7: maturity transitions based on run outcome
      const currentMaturity = getMaturity(projectSlug, lens.id);
      if (status === 'completed') {
        if (currentMaturity === 'discovery' || currentMaturity === 'first-cut') {
          // First successful render → advance to settling
          transitionMaturity(projectSlug, lens.id, 'settling', 'first successful render', 'automatic', {
            evidence: `run ${runId.slice(0, 8)} completed, output contract met`,
            runId,
          });
          // Save first prompt version if none exists
          savePromptVersion(projectSlug, lens.id, lens, 'initial config at first success', 'orchestrator');
        } else if (currentMaturity === 'settling') {
          // Check if we should advance to steady (2+ clean renders, no wasted turns)
          const wastedTurns = countWastedTurns(projectSlug, runId, lens.name, currentMaturity);
          if (wastedTurns === 0) {
            const cleanCount = countConsecutiveCleanRenders(projectSlug, lens.id) + 1;
            // Log the clean render even if we don't advance
            transitionMaturity(projectSlug, lens.id,
              cleanCount >= 2 ? 'steady' : 'settling',
              cleanCount >= 2
                ? `${cleanCount} consecutive clean renders, no wasted turns — advancing to steady`
                : `clean render ${cleanCount}/2 — config stable`,
              'automatic',
              { evidence: `run ${runId.slice(0, 8)}: ${wastedTurns} wasted turns`, runId },
            );
          } else {
            // Wasted turns — stay at settling, log why
            transitionMaturity(projectSlug, lens.id, 'settling',
              `settling: ${wastedTurns} wasted turn(s) detected`, 'automatic',
              { evidence: `run ${runId.slice(0, 8)}: needs config refinement`, runId },
            );
          }
        }
        // steady + completed = no transition needed
      } else if (status === 'failed' && currentMaturity === 'steady') {
        // Regression: steady → settling on structural failure
        transitionMaturity(projectSlug, lens.id, 'settling',
          'regression: render failed in steady state', 'automatic',
          { evidence: `run ${runId.slice(0, 8)} failed`, runId },
        );
      }

      // Project channel gets a human-readable summary
      await this.terminal.postAsLens(
        lens,
        projectSlug,
        `**${lens.name}** — \`${status}\`\n\n${humanSummary}`,
      );

      if (status === 'failed') {
        // Degrade and continue — spec: skip failed lens, present partial results
        await this.terminal.postToProject(
          projectSlug,
          `Lens "${lens.name}" failed. Continuing with remaining lenses.`,
        );
      } else {
        // Chain output: pass this lens's output to the next lens
        priorOutput = result.productionResult?.output;
      }

      // Surface hardening suggestion to Pav
      if (result.hardeningSuggestion) {
        await this.terminal.postToProject(projectSlug,
          `:lock: *Permission hardening available:* ${result.hardeningSuggestion}\n_Reply "harden it" to lock, or ignore to keep shaping._`,
        );
      }
    }

    // Finalize run
    const meta = this.lensManager.finalizeRun(projectSlug, runId, results);

    // Build final summary (v0.6.5.8: pass projectSlug + runId so the failure
    // detail extractor can find the events.jsonl file for any failed lenses)
    const summary = this.buildRunSummary(results, meta, projectSlug, runId);
    await this.terminal.postToProject(projectSlug, summary);

    return { runId, results, summary };
  }

  private buildRunSummary(results: LensRunResult[], meta: any, projectSlug?: string, runId?: string): string {
    const lines: string[] = [];
    lines.push(`**Run Complete** — Status: \`${meta.status}\``);
    lines.push('');

    for (const r of results) {
      const status = r.productionResult?.status || 'skipped';
      const icon = status === 'completed' ? ':white_check_mark:' : ':x:';
      lines.push(`${icon} **${r.lens.name}**: ${status}`);

      // v0.6.5.8: "degrade, don't kill" — when a lens fails, surface the actual
      // reason inline instead of burying it in events.jsonl. Pav noted (2026-04-09
      // 03:24:25): "expected it to ping us or you when it hit a wall in this
      // channel with more detail on its thinking in its dedicated channel".
      //
      // Read the events.jsonl tail and extract the last `error` event + the last
      // `message` (tool call) so Pav sees "what failed" + "what it was trying
      // to do when it failed" directly in the project channel, no jsonl hunting.
      if (status === 'failed' && projectSlug && runId) {
        const detail = this.extractFailureDetail(projectSlug, runId, r.lens.name);
        if (detail) {
          lines.push(`> ${detail.replace(/\n/g, '\n> ')}`);
        }
      }
    }

    // v0.6.6: inline per-lens audit in the project channel summary
    if (projectSlug && runId) {
      for (const r of results) {
        const audit = this.buildRunAudit(projectSlug, runId, r.lens.name, r.lens.id);
        lines.push('');
        lines.push(audit);
      }
    }

    lines.push('');
    lines.push('_Full trace in each lens channel._');

    return lines.join('\n');
  }

  /**
   * v0.6.5.8: read the tail of events.jsonl for a failed lens and return a
   * short summary: last error message + last tool call. Best-effort — returns
   * undefined on any read failure. The goal is to give Pav enough context to
   * decide what to do next without having to ssh into the events file.
   */
  private extractFailureDetail(projectSlug: string, runId: string, lensName: string): string | undefined {
    if (!projectSlug || !runId) return undefined;
    const eventsPath = path.join(
      WORLD_BENCH_ROOT, 'projects', projectSlug, 'runs', runId, 'events.jsonl',
    );
    try {
      if (!fs.existsSync(eventsPath)) return undefined;
      const raw = fs.readFileSync(eventsPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return undefined;

      // Walk backwards, collect the last error + last tool call for this lens
      let lastError: string | undefined;
      let lastTool: string | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.actor !== lensName && event.actor !== 'orchestrator') continue;
          if (!lastError && event.type === 'error') {
            lastError = (event.content || '').toString().slice(0, 400);
          }
          if (!lastError && event.type === 'state_change' && /failed|error|maximum/i.test(event.content || '')) {
            lastError = (event.content || '').toString().slice(0, 400);
          }
          if (!lastTool && event.type === 'message' && event.content?.startsWith?.('Tool:')) {
            const toolName = event.metadata?.tool || event.content.replace(/^Tool:\s*/, '');
            lastTool = toolName;
          }
          if (lastError && lastTool) break;
        } catch {
          // Skip malformed line
        }
      }

      const parts: string[] = [];
      if (lastError) parts.push(`:warning: **Error**: ${lastError}`);
      if (lastTool) parts.push(`:wrench: **Last tool**: \`${lastTool}\``);
      if (parts.length === 0) return undefined;
      return parts.join('\n');
    } catch {
      return undefined;
    }
  }

  /**
   * v0.6.6: build a structured audit summary from events.jsonl for a completed
   * lens run. Posted to both the lens channel (full detail) and the project
   * channel (via buildRunSummary). Council decision 2026-04-10: Pav wants to
   * see timing, tools used, escalation count, errors, and output stats — the
   * HOW, not just the WHAT.
   */
  /**
   * v0.6.9: Check for escalation.json in a lens's output dir. If found, post
   * the escalation to both the lens channel and the project channel, then
   * archive the file (rename to escalation-{timestamp}.json so it doesn't
   * re-fire on the next render).
   *
   * Council decision: "File is the record, Slack is the attention surface.
   * Wire them together." (Veil, 2026-04-12)
   *
   * The lens writes escalation.json during a render when it hits a blocker.
   * Shape: { type, severity, message, context?, requestedAction? }
   */
  private async checkAndPostEscalation(projectSlug: string, lens: LensConfig): Promise<void> {
    const escalationPath = path.join(
      WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lens.id, 'output', 'escalation.json',
    );

    try {
      if (!fs.existsSync(escalationPath)) return;

      const raw = fs.readFileSync(escalationPath, 'utf-8');
      const escalation = JSON.parse(raw);

      const severity = escalation.severity || 'medium';
      const severityIcon = severity === 'critical' ? ':rotating_light:'
        : severity === 'high' ? ':warning:'
        : ':information_source:';

      const slackMsg = [
        `${severityIcon} **Escalation from ${lens.name}** (${severity})`,
        '',
        `**Issue:** ${escalation.message || 'No message provided'}`,
        escalation.context ? `**Context:** ${escalation.context}` : '',
        escalation.requestedAction ? `**Requested action:** ${escalation.requestedAction}` : '',
        '',
        `_Filed via \`escalation.json\` during run. Orchestrator to review and act or escalate to Pav._`,
      ].filter(Boolean).join('\n');

      // Post to both surfaces
      const persona = lens.slackPersona || { username: lens.name, icon_emoji: ':dna:' };
      await this.terminal.postToLensChannel(projectSlug, lens.id, lens, slackMsg);
      await this.terminal.postAsLens(lens, projectSlug, slackMsg);

      // Archive the escalation file (don't delete — audit trail)
      const archiveName = `escalation-${Date.now()}.json`;
      const archivePath = path.join(
        WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lens.id, 'output', archiveName,
      );
      fs.renameSync(escalationPath, archivePath);

      console.log(`[Orchestrator] Escalation from ${lens.name} posted + archived: ${archiveName}`);
    } catch (e: any) {
      // Non-critical — don't crash the run for an escalation read failure
      console.warn(`[Orchestrator] Failed to read/post escalation for ${lens.id}: ${e.message}`);
    }
  }

  private buildRunAudit(projectSlug: string, runId: string, lensName: string, lensId: string): string {
    const eventsPath = path.join(
      WORLD_BENCH_ROOT, 'projects', projectSlug, 'runs', runId, 'events.jsonl',
    );

    const toolCounts: Record<string, number> = {};
    let escalationCount = 0;
    let errorCount = 0;
    let startTime: string | undefined;
    let endTime: string | undefined;
    let researchEndTime: string | undefined;

    try {
      if (!fs.existsSync(eventsPath)) return `:satellite_antenna: **${lensName}** run audit — no events recorded`;
      const raw = fs.readFileSync(eventsPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (!startTime) startTime = event.timestamp;
          endTime = event.timestamp;

          // Detect research→production boundary
          if (event.type === 'state_change' && /research.done|producing/i.test(event.content || '')) {
            if (!researchEndTime) researchEndTime = event.timestamp;
          }

          // Count tools for this lens
          if (event.actor === lensName && event.type === 'message' && event.metadata?.tool) {
            const tool = event.metadata.tool;
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;
          }

          if (event.type === 'elevation_request') escalationCount++;
          if (event.type === 'error') errorCount++;
        } catch { /* skip malformed */ }
      }
    } catch {
      return `:satellite_antenna: **${lensName}** run audit — events.jsonl unreadable`;
    }

    // Format timing
    const dur = (s?: string, e?: string): string => {
      if (!s || !e) return '—';
      const ms = new Date(e).getTime() - new Date(s).getTime();
      const m = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    const totalTime = dur(startTime, endTime);
    const researchTime = researchEndTime ? dur(startTime, researchEndTime) : undefined;
    const productionTime = researchEndTime ? dur(researchEndTime, endTime) : undefined;
    const timingStr = researchTime && productionTime
      ? `${totalTime} (research ${researchTime} + production ${productionTime})`
      : totalTime;

    // Format tools: sorted by count descending
    const toolStr = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t} x${c}`)
      .join(', ') || 'none';

    // Check output file
    let outputStr = '—';
    try {
      const outputFile = path.join(
        WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'output', `${runId}.json`,
      );
      if (fs.existsSync(outputFile)) {
        const sizeKB = Math.round(fs.statSync(outputFile).size / 1024);
        outputStr = `${runId.slice(0, 8)}.json — ${sizeKB}KB`;
      }
    } catch { /* best effort */ }

    // Check for harvest-specific output
    try {
      const harvestFile = path.join(
        WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'output', 'harvest.json',
      );
      if (fs.existsSync(harvestFile)) {
        const sizeKB = Math.round(fs.statSync(harvestFile).size / 1024);
        try {
          const data = JSON.parse(fs.readFileSync(harvestFile, 'utf-8'));
          const msgCount = data.messages?.length || '?';
          outputStr += ` + harvest.json — ${msgCount} msgs, ${sizeKB}KB`;
        } catch {
          outputStr += ` + harvest.json — ${sizeKB}KB`;
        }
      }
    } catch { /* best effort */ }

    const errorStr = errorCount === 0 ? '0' : `${errorCount}`;
    const escStr = escalationCount === 0
      ? '0'
      : `${escalationCount} (all advisory — bypassPermissions mode)`;

    // v0.6.7: include maturity in audit
    const maturity = getMaturity(projectSlug, lensId);

    const out: string[] = [];
    out.push(`:satellite_antenna: **${lensName}** run audit\n`);
    out.push(`**Timing:**      ${timingStr}`);
    out.push(`**Tools used:**  ${toolStr}`);
    out.push(`**Escalations:** ${escStr}`);
    out.push(`**Errors:**      ${errorStr}`);
    out.push(`**Output:**      ${outputStr}`);
    out.push(`**Maturity:**    ${maturity}`);

    return out.join('\n');
  }

  // ─── Lens Resume ───

  /**
   * v0.6.2: Rehearse a multi-lens flow.
   *
   * Rehearse is *composition*, not *differentiation*. It runs lenses that are
   * already attached to the project, in an explicit order, with executeRun's
   * normal seam-chaining (lens A's output becomes lens B's prior context).
   *
   * The point is to watch the seam — what crosses the boundary between lenses,
   * where shape drift happens, whether the contracts hold. No new lenses are
   * born here. No channels created. No status changes. The seed must already
   * be ignited (rendering or complete).
   *
   * Council direction (v0.6.2):
   *   - bare verb only — hydrate, run, return per-lens outputs
   *   - explicit lensSlugs[] order, do NOT infer from creation order
   *   - no automatic contract mutation
   *   - no implicit attach/bootstrap fallback
   *   - per-lens outputs are visible by default (executeRun already does this)
   *
   * Returns the same shape as executeRun. Per-lens outputs land in their
   * respective #wb-lens-* channels; the project channel gets the chain summary.
   */
  async rehearse(
    projectSlug: string,
    lensSlugs: string[],
    taskPrompt: string,
  ): Promise<{ runId: string; results: LensRunResult[]; summary: string }> {
    if (!Array.isArray(lensSlugs) || lensSlugs.length === 0) {
      throw new Error('rehearse requires a non-empty lensSlugs array.');
    }

    // 1. Project must exist (no implicit bootstrap)
    if (!this.projectExists(projectSlug)) {
      throw new Error(`Cannot rehearse: project "${projectSlug}" does not exist. Render at least one lens first.`);
    }
    const meta = this.loadProjectMeta(projectSlug);
    if (!meta) {
      throw new Error(`Cannot rehearse: project.json for "${projectSlug}" is unreadable.`);
    }

    // 2. Seed must be past draft (any post-ignition status is valid for rehearse).
    //    Legacy pre-seed projects bypass this gate via the same grandfather path
    //    used elsewhere — if no seed exists but project.json declares legacy_pre_seed,
    //    allow rehearsal so old projects don't get locked out.
    const seed = this.seedManager.loadSeed(projectSlug);
    if (!seed && !meta.legacy_pre_seed) {
      throw new Error(`Cannot rehearse: no seed found for "${projectSlug}" and project is not marked legacy_pre_seed.`);
    }
    if (seed && seed.status === 'draft') {
      throw new Error(`Cannot rehearse: seed "${projectSlug}" is still draft. Ignite and render at least one lens before rehearsing.`);
    }

    // 3. Every requested lens must already be attached. No silent attach.
    const missing = lensSlugs.filter(slug => !meta.lenses.includes(slug));
    if (missing.length > 0) {
      throw new Error(`Cannot rehearse: lens(es) not attached to "${projectSlug}": ${missing.join(', ')}. Render them first via render_lens.`);
    }

    // 4. Hydrate each lens config from disk in the explicit requested order.
    //    Order is whatever the caller passed — NOT the order from project.json.
    //    This is the "explicit pipeline definition" Soren asked for.
    const lensConfigs: LensConfig[] = [];
    for (const slug of lensSlugs) {
      const lens = this.loadLensFromDisk(projectSlug, slug);
      if (!lens) {
        throw new Error(`Cannot rehearse: lens.json missing on disk for "${projectSlug}/${slug}".`);
      }
      lensConfigs.push(lens);
    }

    console.log(`[Orchestrator] Rehearsing ${lensConfigs.length} lens(es) for ${projectSlug}: ${lensSlugs.join(' → ')}`);

    // 5. Run via executeRun. It already chains priorOutput between lenses
    //    (the seam) and posts per-lens outputs to their channels. No status
    //    advancement here — rehearse is read-only on the seed lifecycle.
    return await this.executeRun(projectSlug, lensConfigs, taskPrompt);
  }

  /**
   * Load a lens config from disk by slug. Used by rehearse() and resumeLens().
   * Returns null if the lens is not attached to the project.
   */
  private loadLensFromDisk(projectSlug: string, lensId: string): LensConfig | null {
    const lensJsonPath = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json');
    if (!fs.existsSync(lensJsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
    } catch (e: any) {
      console.error(`[Orchestrator] Failed to read lens.json for ${projectSlug}/${lensId}: ${e.message}`);
      return null;
    }
  }

  /**
   * v0.6.5: Validate a speaker against the extensible allowlist (G6).
   *
   * Council direction: "Speaker validation as a whitelist (not hardcoded enum)
   * to avoid the six-edit problem when mediated-lens:* ships in v0.7." (Veil)
   *
   * Accepts:
   *   - 'pav' (Pav speaking directly)
   *   - 'orchestrator' (Orchestrator speaking in its own voice during intervene mode)
   *   - 'mediated-lens:{slug}' (v0.7 shape-cutting — recognized now so the
   *     validator doesn't need to be edited then)
   *
   * Rejects everything else with an explicit error.
   */
  validateSpeaker(speaker: string): { valid: boolean; error?: string } {
    if (speaker === 'pav' || speaker === 'orchestrator') {
      return { valid: true };
    }
    if (/^mediated-lens:[a-z0-9][a-z0-9-]*$/.test(speaker)) {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Invalid speaker "${speaker}". Allowed: 'pav', 'orchestrator', 'mediated-lens:{slug}'.`,
    };
  }

  /**
   * v0.6.4: Meet a lens before render.
   *
   * Spawns the stem cell in conversation-only mode (mutation tools stripped),
   * gives it the meeting prompt, captures its response. Stores the session ID
   * + thread routing keys in pendingMeetSessions and threadToSession so
   * render_lens AND future continue_meet calls can find the right session.
   *
   * Council guardrails (enforced by lens-manager.runLensMeet):
   *   - Conversation-only — no research phase, no production phase
   *   - Mutation tools stripped from the lens's tool list at the SDK layer
   *   - No artifact writes, no project mutation, no channel/bootstrap side effects
   *
   * v0.6.5 update: now records meetChannelId + meetThreadTs alongside the session
   * so thread-aware routing can find this session by thread on subsequent turns.
   */
  async meetLens(
    projectSlug: string,
    lens: LensConfig,
    meetChannelId?: string,
    meetThreadTs?: string,
  ): Promise<{ output: string; sessionId?: string; status: 'completed' | 'failed' }> {
    const result = await this.lensManager.runLensMeet(lens);
    if (result.sessionId && result.status === 'completed') {
      const key = `${projectSlug}:${lens.id}`;
      this.pendingMeetSessions.set(key, {
        sessionId: result.sessionId,
        meetChannelId: meetChannelId || '',
        meetThreadTs: meetThreadTs || '',
      });
      // v0.6.5: register the reverse-lookup map entry (G1)
      if (meetChannelId && meetThreadTs) {
        const threadKey = `${meetChannelId}:${meetThreadTs}`;
        this.threadToSession.set(threadKey, {
          projectSlug,
          lensId: lens.id,
          sessionId: result.sessionId,
        });
        console.log(`[Orchestrator] Bound thread ${threadKey} → ${projectSlug}:${lens.id} session ${result.sessionId.slice(0, 8)}`);
      }
      console.log(`[Orchestrator] Stored meet session for ${key}: ${result.sessionId}`);
    }
    return result;
  }

  /**
   * v0.6.5: Continue an existing lens meeting with a new turn.
   *
   * This is the foundational dialogue primitive. continue_meet works for both
   * pre-render and post-render conversations. Same agent, growing context, with
   * speaker attribution and verbatim transport.
   *
   * Guardrails enforced here (council direction from v0.6.5 escalation):
   *   G2 — session freshness: validate that the session ID we're about to resume
   *        is the CURRENT active session for this lens. If stale, hard fail.
   *   G3 — per-thread serialization: only one continuation in flight per thread
   *        at a time. Concurrent dispatch attempts get rejected with a visible
   *        "still processing" message.
   *   G6 — speaker validation: reject unknown speakers via validateSpeaker().
   *
   * Returns the meeting result. Caller is responsible for posting to the channel.
   */
  async continueMeet(
    projectSlug: string,
    lensId: string,
    speaker: string,
    message: string,
    verbatim: boolean,
    channelId: string,
    threadTs: string,
  ): Promise<{ output: string; sessionId?: string; status: 'completed' | 'failed'; error?: string }> {
    // G6: speaker validation
    const speakerCheck = this.validateSpeaker(speaker);
    if (!speakerCheck.valid) {
      return { output: '', status: 'failed', error: speakerCheck.error };
    }

    // G3: per-thread serialization mutex
    const threadKey = `${channelId}:${threadTs}`;
    if (this.threadDispatchLocks.has(threadKey)) {
      return {
        output: '',
        status: 'failed',
        error: `Still processing previous turn for ${lensId} in this thread. Please wait for it to complete before sending the next message.`,
      };
    }

    // G2: session freshness validation
    // Look up the CURRENT active session for this lens. The thread-bound session
    // (in threadToSession) must match the current session in pendingMeetSessions.
    // If they differ, the lens has been re-met or re-rendered and this thread's
    // routing is stale.
    const lensKey = `${projectSlug}:${lensId}`;
    const currentMeet = this.pendingMeetSessions.get(lensKey);
    const threadBinding = this.threadToSession.get(threadKey);

    if (!threadBinding) {
      return {
        output: '',
        status: 'failed',
        error: `Thread ${threadKey} is not bound to any active lens session. Re-issue meet_lens to start a fresh conversation.`,
      };
    }

    if (!currentMeet) {
      return {
        output: '',
        status: 'failed',
        error: `No active meet session for ${lensKey}. The lens may have been re-rendered or the session was lost on restart. Re-issue meet_lens to reestablish.`,
      };
    }

    if (currentMeet.sessionId !== threadBinding.sessionId) {
      return {
        output: '',
        status: 'failed',
        error: `Stale thread routing rejected. Thread ${threadKey} is bound to session ${threadBinding.sessionId.slice(0, 8)}, but lens ${lensId} is currently on session ${currentMeet.sessionId.slice(0, 8)}. Re-issue meet_lens to start a fresh thread.`,
      };
    }

    // Verbatim flag enforcement: when speaker is pav and verbatim is true,
    // the message is delivered as-is. When speaker is orchestrator and verbatim
    // is false, the Orchestrator's framing is preserved (no automatic rewrite,
    // just no enforcement of exact-words). The actual transport is the same —
    // verbatim is a contract about WHO is allowed to transform the message,
    // not a different code path. The lens-manager continuation prompt template
    // includes the speaker label and the message as written. The interlock is
    // that the Orchestrator MUST NOT have rewritten the message before passing
    // it here when speaker=pav.
    //
    // We can't enforce that the caller didn't rewrite — that's a contract at
    // the action handler / system prompt layer. What we DO enforce here is the
    // explicit speaker label so attribution is unambiguous in the lens's history.

    // Acquire the mutex
    this.threadDispatchLocks.add(threadKey);
    try {
      const result = await this.lensManager.runLensMeet(
        // Need the lens config — load from disk if attached, or from pendingMeetSessions
        // metadata. For pre-render meets, the lens isn't on disk yet; we need to keep
        // the lensConfig in pendingMeetSessions too. But the v0.6.4 implementation
        // didn't store it... we'll need to handle both cases.
        await this.loadLensForContinue(projectSlug, lensId),
        message,
        currentMeet.sessionId,
        speaker,
      );

      // Update the session ID in our maps if it changed (it usually doesn't since
      // we're resuming, but let's be safe)
      if (result.sessionId && result.status === 'completed') {
        currentMeet.sessionId = result.sessionId;
        threadBinding.sessionId = result.sessionId;
      }

      return result;
    } finally {
      // G3: always release the mutex, even on failure
      this.threadDispatchLocks.delete(threadKey);
    }
  }

  /**
   * v0.6.5: Handle a relay-mode message from the Terminal.
   *
   * Called by Terminal when an untagged message lands in a known lens meet thread.
   * Soren's structural-not-behavioral rule: the routing decision was already made
   * by the Terminal based on thread origin. We just dispatch the relay verbatim.
   *
   * v0.6.8: Handle a message in a lens channel (#wb-lens-*).
   * If the lens has a sessionId, uses continueMeet (resume existing conversation).
   * If not (common — the SDK's query() stream doesn't reliably emit session_id),
   * spawns a fresh meet session with the message as the user prompt. The lens
   * gets its full system prompt + the user's message, responds, and the new
   * sessionId is captured for future continue_meet calls.
   */
  async handleLensChannelMessage(args: {
    channelId: string;
    projectSlug: string;
    lensId: string;
    sessionId: string;  // may be empty string if not available
    speaker: string;
    message: string;
    triggerTs: string;
  }): Promise<void> {
    await this.terminal.addThinkingReaction(args.channelId, args.triggerTs);

    // Load the lens config from disk
    const lens = this.loadLensFromDisk(args.projectSlug, args.lensId);
    if (!lens) {
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      await this.terminal.postToChannel(args.channelId,
        `:warning: Lens \`${args.lensId}\` not found on disk for project \`${args.projectSlug}\`.`);
      return;
    }

    const persona = lens.slackPersona || { username: args.lensId, icon_emoji: ':dna:' };

    try {
      // v0.6.9 Gate 2: inject structured context so the lens knows who it is,
      // what it did last, and what Pav said about it. For fresh meets this is
      // essential (the lens has no conversation history). For continue_meet it's
      // supplemental (the lens already has its session history, but the context
      // adds operational awareness).
      let contextBlock = '';
      try {
        contextBlock = await buildLensContext(
          args.projectSlug, args.lensId,
          this.terminal.getSlackClient?.() || null,
        );
      } catch (e: any) {
        console.warn(`[Orchestrator] Context injection failed (non-critical): ${e.message}`);
      }

      const enrichedMessage = contextBlock
        ? `${contextBlock}\nFrom ${args.speaker}:\n${args.message}`
        : args.message;

      let result: { output: string; sessionId?: string; status: string };

      if (args.sessionId) {
        // Has session — resume via runLensMeet continuation mode.
        // NOT continueMeet() — that requires thread bindings (G2/G3) which
        // don't exist for lens channel messages. runLensMeet with
        // mode='continuation' goes directly through the SDK resume path.
        console.log(`[Orchestrator] Lens channel resume: ${args.lensId} session ${args.sessionId.slice(0, 8)}`);
        try {
          result = await this.lensManager.runLensMeet(
            lens, enrichedMessage, args.sessionId, args.speaker, 'continuation',
          );
        } catch (resumeErr: any) {
          // If session resume fails (cross-cwd, expired, etc.),
          // fall back to fresh conversation mode.
          console.warn(`[Orchestrator] Session resume failed for ${args.lensId}: ${resumeErr.message}. Falling back to fresh conversation.`);
          result = await this.lensManager.runLensMeet(
            lens, enrichedMessage, undefined, args.speaker, 'conversation',
          );
        }
        // Update sessionId (may be new from fallback, or same from resume)
        if (result.sessionId) {
          try {
            const ljp = path.join(WORLD_BENCH_ROOT, 'projects', args.projectSlug, 'lenses', args.lensId, 'lens.json');
            const ld = JSON.parse(fs.readFileSync(ljp, 'utf-8'));
            ld.sessionId = result.sessionId;
            // v0.6.9: one-session model — conversation now uses lens workspace cwd,
            // matching render cwd. Record it so the render path knows it can resume.
            const workspace = path.join(WORLD_BENCH_ROOT, 'projects', args.projectSlug, 'lenses', args.lensId, 'workspace');
            ld.sessionCwd = workspace;
            fs.writeFileSync(ljp, JSON.stringify(ld, null, 2));
          } catch { }
        }
      } else {
        // No session — spawn a fresh conversation with context + user's message
        console.log(`[Orchestrator] Lens channel conversation: ${args.lensId} (no session, spawning new with context)`);
        result = await this.lensManager.runLensMeet(
          lens, enrichedMessage, undefined, args.speaker, 'conversation',
        );

        // Capture the new sessionId so future messages can continue
        if (result.sessionId) {
          const key = `${args.projectSlug}:${args.lensId}`;
          this.pendingMeetSessions.set(key, {
            sessionId: result.sessionId,
            meetChannelId: args.channelId,
            meetThreadTs: args.triggerTs,
          });
          // Also persist to lens.json for rehydration
          try {
            const lensJsonPath = path.join(
              WORLD_BENCH_ROOT, 'projects', args.projectSlug, 'lenses', args.lensId, 'lens.json',
            );
            const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
            lensData.sessionId = result.sessionId;
            const workspace = path.join(WORLD_BENCH_ROOT, 'projects', args.projectSlug, 'lenses', args.lensId, 'workspace');
            lensData.sessionCwd = workspace;
            fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));
            console.log(`[Orchestrator] Persisted new sessionId ${result.sessionId.slice(0, 8)} to lens.json (cwd=${workspace.slice(-40)})`);
          } catch { }
        }
      }

      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);

      if (result.status === 'failed') {
        await this.terminal.postToChannel(args.channelId,
          `:warning: ${args.lensId} relay failed: ${result.output?.slice(0, 300) || 'unknown error'}`);
        return;
      }

      // Post the lens's response in the lens channel under its persona
      const rawOutput = result.output || '_(no response)_';
      const chunks = splitForSlack(rawOutput);
      for (const chunk of chunks) {
        await this.terminal.postToChannelAs(args.channelId, persona, chunk);
      }
    } catch (e: any) {
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      await this.terminal.postToChannel(args.channelId,
        `:warning: Lens channel relay error: ${e.message}`);
    }
  }

  /**
   * This is the path Pav uses for direct conversation with a lens — post in the
   * meet thread, words go through. No SDK conversation, no Orchestrator judgment,
   * just transport.
   */
  async handleLensThreadRelay(args: {
    channelId: string;
    threadTs: string;
    binding: { projectSlug: string; lensId: string; sessionId: string };
    speaker: string;
    message: string;
    triggerTs: string;
  }): Promise<void> {
    await this.terminal.addThinkingReaction(args.channelId, args.triggerTs);
    try {
      const result = await this.continueMeet(
        args.binding.projectSlug,
        args.binding.lensId,
        args.speaker,
        args.message,
        true, // verbatim=true for direct relay (Veil's interlock)
        args.channelId,
        args.threadTs,
      );
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      if (result.status === 'failed') {
        const errMsg = result.error || result.output || 'unknown error';
        // v0.6.5.4: thread failure post under the wave too
        await this.terminal.postToChannel(args.channelId, `:warning: Relay failed: ${errMsg}`, args.threadTs);
        return;
      }
      // v0.6.5.4: post the lens's response under its persona AND THREADED UNDER
      // the wave thread (args.threadTs). The previous v0.6.5.x code had the
      // comment "in the same thread" but didn't actually pass thread_ts —
      // resulting in the relay response landing as a NEW top-level message
      // sibling of the wave instead of nested under it. Same threading discipline
      // as the meet response chunks. Also chunked via splitForSlack so long
      // continue_meet responses don't get truncated.
      const lens = this.loadLensFromDisk(args.binding.projectSlug, args.binding.lensId);
      const persona = lens?.slackPersona || { username: args.binding.lensId, icon_emoji: ':dna:' };
      const rawOutput = result.output || '_(no response captured)_';
      const chunks = splitForSlack(rawOutput);
      console.log(`[Orchestrator] Posting ${chunks.length} chunk(s) of relay response (total ${rawOutput.length} chars) to thread ${args.threadTs}`);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const labelled = chunks.length > 1
          ? `${chunk}\n\n_(part ${i + 1}/${chunks.length})_`
          : chunk;
        await this.terminal.postToChannelAs(args.channelId, persona, labelled, args.threadTs);
      }
    } catch (e: any) {
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      // v0.6.5.4: thread error post too
      await this.terminal.postToChannel(args.channelId, `:warning: Relay error: ${e.message}`, args.threadTs);
    }
  }

  /**
   * v0.6.5: Handle an Orchestrator-tagged message in a lens thread.
   *
   * Two postures (Q11: simple binary at the parser level):
   *   - 'review' — Orchestrator reads the lens's last reply and gives Pav its
   *                own assessment. The lens never sees this. Sidebar in-thread.
   *   - 'intervene' — Orchestrator speaks TO the lens in its own voice
   *                   (speaker=orchestrator). Lens sees the message as Orchestrator-
   *                   authored, not Pav-authored. Visible to Pav in-thread.
   *
   * Council decision Q10: NO special icon. The Orchestrator already has a distinct
   * Slack identity. Distinguish by speaker/provenance, not cosmetic markers.
   */
  async handleLensThreadOrchestratorMode(args: {
    channelId: string;
    threadTs: string;
    binding: { projectSlug: string; lensId: string; sessionId: string };
    mode: 'review' | 'intervene';
    message: string;
    triggerTs: string;
  }): Promise<void> {
    await this.terminal.addThinkingReaction(args.channelId, args.triggerTs);
    try {
      if (args.mode === 'review') {
        // REVIEW mode: Orchestrator reads the thread and gives Pav its assessment.
        // The lens never sees this — we don't call continueMeet at all. We just
        // run a quick conversation with the SDK (the Orchestrator's own session)
        // asking it to review the last lens response in this thread.
        //
        // For v0.6.5, this is implemented as a normal handleCommand pass with the
        // user message rephrased as "review the last lens response in this thread."
        // The SDK will use its Slack MCP tools to read the thread itself.
        const reviewCmd: OrchestratorCommand = {
          raw: `Review the lens \`${args.binding.lensId}\`'s most recent response in this thread (channel ${args.channelId}, thread ts ${args.threadTs}). Use slack_read_thread to fetch it. Give Pav your assessment — does the response actually address what was asked? Are the contracts holding? What would you push back on? Do NOT call continue_meet; this is a sidebar between you and Pav, the lens should not see it.`,
          intent: 'review lens response',
          channel_id: args.channelId,
          thread_ts: args.threadTs,
          user_id: PAV_USER_ID,
          ts: args.triggerTs,
        };
        await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
        await this.handleCommand(reviewCmd);
        return;
      }

      // INTERVENE mode: Orchestrator speaks TO the lens in its own voice.
      // continueMeet with speaker=orchestrator, verbatim=false (Orchestrator can
      // shape its own message; verbatim=true is for Pav's words specifically).
      const result = await this.continueMeet(
        args.binding.projectSlug,
        args.binding.lensId,
        'orchestrator',
        args.message,
        false,
        args.channelId,
        args.threadTs,
      );
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      if (result.status === 'failed') {
        const errMsg = result.error || result.output || 'unknown error';
        // v0.6.5.4: thread failure post under the wave
        await this.terminal.postToChannel(args.channelId, `:warning: Intervene failed: ${errMsg}`, args.threadTs);
        return;
      }
      // v0.6.5.4: thread the intervene response under the wave + chunk it
      const lens = this.loadLensFromDisk(args.binding.projectSlug, args.binding.lensId);
      const persona = lens?.slackPersona || { username: args.binding.lensId, icon_emoji: ':dna:' };
      const rawOutput = result.output || '_(no response captured)_';
      const chunks = splitForSlack(rawOutput);
      console.log(`[Orchestrator] Posting ${chunks.length} chunk(s) of intervene response (total ${rawOutput.length} chars) to thread ${args.threadTs}`);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const labelled = chunks.length > 1
          ? `${chunk}\n\n_(part ${i + 1}/${chunks.length})_`
          : chunk;
        await this.terminal.postToChannelAs(args.channelId, persona, labelled, args.threadTs);
      }
    } catch (e: any) {
      await this.terminal.removeThinkingReaction(args.channelId, args.triggerTs);
      // v0.6.5.4: thread error post under the wave too
      await this.terminal.postToChannel(args.channelId, `:warning: ${args.mode} error: ${e.message}`, args.threadTs);
    }
  }

  /**
   * Load a lens config for a continue_meet call. The lens may be attached
   * (lens.json on disk) or pre-render (lens config was passed in the meet_lens
   * action and we need to find it somewhere). For now: try disk first, fall
   * back to a stub config built from what we know.
   *
   * v0.6.5 known limitation: if the lens is pre-render and the original
   * lens config from the meet_lens action isn't preserved, continue_meet against
   * a pre-render lens may have to use a minimal config. This is acceptable for
   * v0.6.5 because the lens session itself preserves the system prompt — we're
   * resuming an existing session, not spawning fresh. The lens config is mostly
   * needed for tools list filtering, which the strict mutation-tool-strip handles.
   */
  private async loadLensForContinue(projectSlug: string, lensId: string): Promise<LensConfig> {
    const fromDisk = this.loadLensFromDisk(projectSlug, lensId);
    if (fromDisk) return fromDisk;
    // Fall back to a minimal stub. The session resume in agent-adapter will
    // restore the actual conversation history, including the system prompt
    // from the original meet, so this stub is mostly used for the tool list.
    return {
      id: lensId,
      name: lensId,
      purpose: '(continue_meet against pre-render lens — config not on disk)',
      systemPrompt: '',
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      state: 'active' as const,
      permissions: {
        tier: 'stem' as const,
        allowed: [...STEM_CELL_ALLOWED],
        denied: [...STEM_CELL_DENIED, 'Write', 'Edit', 'NotebookEdit', 'MultiEdit'],
        granted: [],
        stableRunCount: 0,
        observedTools: [],
      },
      slackPersona: { username: lensId, icon_emoji: ':dna:' },
      inputContract: { description: '', fields: {} },
      outputContract: { description: '', fields: {} },
      researchPhase: { enabled: false, prompt: '', maxDuration: 120 },
    };
  }

  /**
   * v0.6.5 (G5): Rehydrate the threadToSession map from disk on startup.
   *
   * Council direction (Veil): "pendingMeetSessions lives in process memory.
   * Restart kills all active sessions and silently degrades routing back to
   * the v0.6.4 failure shape. Spec should name this limitation; ideally
   * include a rehydration function that rebuilds the routing table from
   * lens configs on startup."
   *
   * Recovers all RENDERED lenses cleanly. Pre-render meet sessions are still
   * lost on restart — that's documented as a v0.6.5 known limitation.
   */
  rehydrateLensSessions(): void {
    const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
    if (!fs.existsSync(projectsDir)) return;

    let rehydratedCount = 0;
    try {
      for (const projectSlug of fs.readdirSync(projectsDir)) {
        const lensesDir = path.join(projectsDir, projectSlug, 'lenses');
        if (!fs.existsSync(lensesDir)) continue;

        for (const lensId of fs.readdirSync(lensesDir)) {
          const lensJsonPath = path.join(lensesDir, lensId, 'lens.json');
          if (!fs.existsSync(lensJsonPath)) continue;

          try {
            const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
            if (!lensData.sessionId) continue;

            // Always rebuild pendingMeetSessions for rendered lenses
            const lensKey = `${projectSlug}:${lensId}`;
            this.pendingMeetSessions.set(lensKey, {
              sessionId: lensData.sessionId,
              meetChannelId: lensData.meetChannelId || '',
              meetThreadTs: lensData.meetThreadTs || '',
            });

            // If the lens.json carries thread routing keys, rebuild threadToSession too
            if (lensData.meetChannelId && lensData.meetThreadTs) {
              const threadKey = `${lensData.meetChannelId}:${lensData.meetThreadTs}`;
              this.threadToSession.set(threadKey, {
                projectSlug,
                lensId,
                sessionId: lensData.sessionId,
              });
              rehydratedCount++;
            }
          } catch {
            // Skip unreadable lens.json — non-fatal
          }
        }
      }
    } catch {
      // Non-fatal — startup continues even if rehydration fails
    }

    if (rehydratedCount > 0) {
      console.log(`[Orchestrator] Rehydrated ${rehydratedCount} lens session(s) from disk after restart`);
    }
  }

  /**
   * Resume a lens from its last session with new context/feedback.
   */
  async resumeLens(
    projectSlug: string,
    lensId: string,
    newContext: string,
  ): Promise<LensRunResult | null> {
    const lens = this.loadLensFromDisk(projectSlug, lensId);
    if (!lens) {
      console.error(`[Orchestrator] Lens not found: ${projectSlug}/${lensId}`);
      return null;
    }
    const runId = uuid();

    this.lensManager.initRun(projectSlug, runId, [lens]);

    await this.terminal.postToProject(projectSlug,
      `Resuming lens **${lens.name}** with new context...`,
    );

    const result = await this.lensManager.runLens(
      lens, projectSlug, runId, newContext,
    );

    this.lensManager.finalizeRun(projectSlug, runId, [result]);

    const status = result.productionResult?.status || 'unknown';
    await this.terminal.postToProject(projectSlug,
      `Lens **${lens.name}** resumed: \`${status}\``,
    );

    return result;
  }

  // ─── Command Handling (called by Terminal) ───

  async handleCommand(cmd: OrchestratorCommand): Promise<void> {
    // Reply to wherever the message came from
    const replyTo = cmd.channel_id;

    // v0.6: Generate a unique turn UUID. Used by the Pav interlock to refuse
    // same-turn create_seed → ignite_seed self-advancement.
    const currentTurnId = uuid();

    // Show thinking indicator (hourglass reaction on Pav's message)
    await this.terminal.addThinkingReaction(replyTo, cmd.ts);

    try {
      const response = await this.converse(cmd, currentTurnId);
      await this.terminal.removeThinkingReaction(replyTo, cmd.ts);
      await this.terminal.postToChannel(replyTo, response.reply);

      // ─── v0.6 Seed Lifecycle Actions ───

      // create_seed: write a draft seed to disk. Status: draft. No channels yet.
      if (response.action === 'create_seed' && response.plan) {
        try {
          const { slug, intent, output_shape, lens_sketch } = response.plan;
          const seed = this.seedManager.createSeed(
            slug,
            intent,
            output_shape,
            lens_sketch || [],
            currentTurnId,
          );
          await this.terminal.postToChannel(replyTo,
            `:seedling: Draft seed created: \`${seed.slug}\`\nReply with explicit approval (e.g. "ignite it") in your next message to ignite. Same-turn ignition is mechanically blocked.`,
          );
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `Could not create seed: ${e.message}`);
        }
      }

      // amend_seed: update an existing draft seed in place. Routes through
      // SeedManager.updateSeed() which strips lifecycle-protected fields. v0.6.3:
      // this is the legitimate path for amending a draft. Direct file write is
      // now denied at the canUseTool layer, so this is the only way to evolve a
      // seed before ignition.
      if ((response.action as string) === 'amend_seed' && response.plan) {
        try {
          const { slug, ...updates } = response.plan;
          if (!slug) throw new Error('amend_seed requires a slug');
          // Drop the action field — it shouldn't be persisted as a seed property
          delete (updates as any).action;
          const seed = this.seedManager.updateSeed(slug, updates);
          await this.terminal.postToChannel(replyTo,
            `:pencil2: Seed amended: \`${seed.slug}\` (status: \`${seed.status}\`). Lifecycle fields are protected — only the editable fields were changed.`,
          );
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `Could not amend seed: ${e.message}`);
        }
      }

      // ignite_seed: promote draft to ignited. Pav interlock enforced in seedManager.
      if (response.action === 'ignite_seed' && response.plan) {
        try {
          const { slug } = response.plan;
          const seed = this.seedManager.igniteSeed(slug, currentTurnId);
          await this.terminal.postToChannel(replyTo,
            `:fire: Seed ignited: \`${seed.slug}\`\nProject committed. Sketch is advisory — lens commitment happens one at a time via \`propose_lens\` → \`render_lens\`.`,
          );
        } catch (e: any) {
          if (e instanceof SeedNotYetApprovedError) {
            await this.terminal.postToChannel(replyTo,
              `:no_entry: ${e.message}`,
            );
          } else {
            await this.terminal.postToChannel(replyTo, `Could not ignite seed: ${e.message}`);
          }
        }
      }

      // propose_lens: draft a real lens config from a sketch entry. Local to Pav unless escalated.
      if (response.action === 'propose_lens' && response.plan) {
        const { projectSlug, lensConfig } = response.plan;
        await this.terminal.postToChannel(replyTo,
          `:memo: Lens proposal for \`${projectSlug}\`:\n\`\`\`json\n${JSON.stringify(lensConfig, null, 2)}\n\`\`\`\nReply "meet it" to introduce the stem cell (recommended), or "render it" to spawn directly.`,
        );
      }

      // meet_lens: spawn the lens in conversation-only mode for an introduction
      // before render. The stem cell reads its brief, surfaces questions, flags
      // contract concerns, suggests amendments. No research, no production, no
      // artifact writes (mutation tools stripped at the SDK layer by lens-manager).
      // Single-pass — Pav calls meet_lens again for another round if needed.
      // The session ID is captured into pendingMeetSessions and consumed by
      // render_lens for session continuity. v0.6.4.
      if ((response.action as string) === 'meet_lens' && response.plan) {
        try {
          const plan = response.plan;
          if (!plan.lensConfig) {
            throw new Error('meet_lens requires a lensConfig.');
          }
          if (!plan.projectSlug) {
            throw new Error('meet_lens requires a projectSlug.');
          }
          const lens = this.hydrateLensConfig(plan.lensConfig);
          // v0.6.5: post meeting message and CAPTURE the thread_ts so subsequent
          // continue_meet calls in this thread can find the session via threadToSession.
          // v0.6.5.1: ALL subsequent meet artifacts (harvester response, meeting complete)
          // MUST be posted as REPLIES to this wave message so they share one Slack thread
          // root. Otherwise they're scattered top-level sibling posts and Pav's reply
          // lands in the wrong thread (the meeting complete's thread, not the wave's),
          // and threadToSession doesn't know about it. The bound thread MUST be the
          // visible thread Pav is replying in.
          const meetingNotice = await this.terminal.postToChannelWithTs(replyTo,
            `:wave: Meeting lens \`${lens.id}\` for project \`${plan.projectSlug}\`. Conversation only — no work runs. Standby for the lens's response in this thread...`,
          );
          const meetThreadTs = meetingNotice?.ts || cmd.thread_ts || cmd.ts;
          // v0.6.5: thread channel + ts through to meetLens so it can populate
          // the threadToSession reverse-lookup map (G1). The bound key here is
          // (replyTo, meetThreadTs) — and that ts MUST be the wave message's ts
          // so all subsequent thread replies route correctly.
          const result = await this.meetLens(plan.projectSlug, lens, replyTo, meetThreadTs);
          if (result.status === 'failed') {
            // v0.6.5.1: failure post threaded under the wave too, so the wave thread
            // contains the full record of what happened
            await this.terminal.postToChannel(replyTo,
              `:warning: Meeting with lens \`${lens.id}\` failed: ${result.output.slice(0, 500)}`,
              meetThreadTs,
            );
          } else {
            // Post the lens's response under its persona, THREADED UNDER the wave
            // message (v0.6.5.1). The harvester response, the meeting complete post,
            // and Pav's subsequent replies all live in one Slack thread rooted at
            // the wave — which is the thread bound in threadToSession.
            //
            // v0.6.5.2: chunk the response via splitForSlack so long responses don't
            // get truncated by Slack's per-message text limit. The production lens
            // path (executeRun, line 471-478) already does this — the meet path was
            // missing it. Symptom: Harvester response truncated mid-sentence in one
            // message, plus a mysterious second empty Harvester message (likely
            // @slack/web-api auto-retry on transient failure that succeeded server-side
            // but timed out client-side).
            const persona = lens.slackPersona || { username: lens.name, icon_emoji: ':dna:' };
            const rawOutput = result.output || '_(no response captured)_';
            const chunks = splitForSlack(rawOutput);
            console.log(`[Orchestrator] Posting ${chunks.length} chunk(s) of harvester response (total ${rawOutput.length} chars) to thread ${meetThreadTs}`);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const labelled = chunks.length > 1
                ? `${chunk}\n\n_(part ${i + 1}/${chunks.length})_`
                : chunk;
              await this.terminal.postToChannelAs(replyTo, persona, labelled, meetThreadTs);
            }
            await this.terminal.postToChannel(replyTo,
              `:speech_balloon: Meeting complete. Session \`${result.sessionId?.slice(0, 8) || 'unknown'}\` captured. *Reply directly in this thread* (the one you're reading right now) to continue the conversation — your message will be relayed verbatim to the lens via thread-aware routing. Tag \`@Orchestrator review\` to ask the Orchestrator's read on the lens's last response. Tag \`@Orchestrator [your message]\` for the Orchestrator to speak to the lens in its own voice. Say "render it" to commit.`,
              meetThreadTs,
            );
          }
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `Meeting failed: ${e.message}`);
        }
      }

      // continue_meet: relay a message to an existing lens session. v0.6.5.
      // Hard-fail contract: required fields must be present, speaker must validate,
      // session freshness must hold, per-thread serialization must succeed.
      // This is the foundational dialogue primitive — the verb behind every
      // multi-turn conversation with a stem cell, pre-render or post-render.
      if ((response.action as string) === 'continue_meet' && response.plan) {
        try {
          const plan = response.plan;
          // Hard-fail: required fields
          const missing: string[] = [];
          if (!plan.projectSlug) missing.push('projectSlug');
          if (!plan.lensId) missing.push('lensId');
          if (!plan.speaker) missing.push('speaker');
          if (!plan.message) missing.push('message');
          if (!plan.channelId) missing.push('channelId');
          if (!plan.threadTs) missing.push('threadTs');
          if (missing.length > 0) {
            throw new Error(
              `continue_meet hard-fail: missing required fields: ${missing.join(', ')}. ` +
              `Silent param drops are forbidden in v0.6.5+. Every continuation must declare its full provenance.`,
            );
          }
          // Default verbatim policy: true for pav, false for orchestrator (Veil's interlock)
          const verbatim = plan.verbatim ?? (plan.speaker === 'pav');
          const result = await this.continueMeet(
            plan.projectSlug,
            plan.lensId,
            plan.speaker,
            plan.message,
            verbatim,
            plan.channelId,
            plan.threadTs,
          );
          if (result.status === 'failed') {
            // Use the structured error from continueMeet, or fall back to the output
            const errMsg = result.error || result.output || 'unknown error';
            // v0.6.5.4: thread the failure post under the conversation thread
            await this.terminal.postToChannel(plan.channelId, `:warning: continue_meet failed: ${errMsg}`, plan.threadTs);
          } else {
            // v0.6.5.4: post the lens's response under its persona AND threaded
            // under the wave thread (plan.threadTs). Plus chunked via splitForSlack
            // because long responses get truncated otherwise.
            const lens = this.loadLensFromDisk(plan.projectSlug, plan.lensId);
            const persona = lens?.slackPersona || { username: plan.lensId, icon_emoji: ':dna:' };
            const rawOutput = result.output || '_(no response captured)_';
            const chunks = splitForSlack(rawOutput);
            console.log(`[Orchestrator] Posting ${chunks.length} chunk(s) of continue_meet response (total ${rawOutput.length} chars) to thread ${plan.threadTs}`);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const labelled = chunks.length > 1
                ? `${chunk}\n\n_(part ${i + 1}/${chunks.length})_`
                : chunk;
              await this.terminal.postToChannelAs(plan.channelId, persona, labelled, plan.threadTs);
            }
          }
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `continue_meet failed: ${e.message}`);
        }
      }

      // render_lens: spawn ONE lens at a time. Hard gate ensures seed is ignited.
      // v0.6 enforces single-lens rendering mechanically — the action takes
      // exactly one lensConfig, not an array.
      // v0.6.4: if a meet session exists for this lens, attachLensToProject
      // threads the sessionId into lens.json so the lens resumes its meeting
      // history when it starts production work.
      if (response.action === 'render_lens' && response.plan) {
        try {
          const plan = response.plan;
          if (!plan.lensConfig) {
            throw new Error('render_lens requires a single lensConfig (not an array). One lens at a time.');
          }
          const lens = this.hydrateLensConfig(plan.lensConfig);
          await this.terminal.postToChannel(replyTo,
            `:dna: Rendering lens \`${lens.id}\` for project \`${plan.projectSlug}\`...`,
          );
          // Hard gate: requireIgnited throws if no ignited seed
          this.seedManager.requireIgnited(plan.projectSlug);
          // Bootstrap project on first render, then attach this single lens
          if (!this.projectExists(plan.projectSlug)) {
            await this.bootstrapProject(plan.projectName || plan.projectSlug, plan.projectSlug);
          }

          // v0.6.9: skip attachLensToProject if the lens already exists on disk.
          // attachLensToProject was designed for FIRST attach — it creates dirs,
          // creates the Slack channel, writes lens.json. On re-renders it overwrites
          // lens.json with a fresh config from the action plan, clobbering runtime
          // state (slack_channel_id, sessionId, maturity, maturityLog). The
          // preservation logic (v0.6.6.1) tries to carry forward these fields but
          // fails when prior renders already lost them (chain-clobber). The clean
          // fix: only attach on first render. Re-renders use the existing lens.json.
          const lensJsonExists = fs.existsSync(
            path.join(WORLD_BENCH_ROOT, 'projects', plan.projectSlug, 'lenses', lens.id, 'lens.json'),
          );

          // v0.6.4 + v0.6.5: consume any pending meet session for this lens
          const meetKey = `${plan.projectSlug}:${lens.id}`;
          const pendingMeet = this.pendingMeetSessions.get(meetKey);
          const meetSessionId = pendingMeet?.sessionId;
          const meetChannelId = pendingMeet?.meetChannelId;
          const meetThreadTs = pendingMeet?.meetThreadTs;
          if (meetSessionId) {
            this.pendingMeetSessions.delete(meetKey);
            console.log(`[Orchestrator] Consuming meet session for ${meetKey}: ${meetSessionId}`);
          }
          // v0.6.9: only attach on FIRST render. Re-renders skip attachLensToProject
          // entirely — the lens already has its dirs, channel, and lens.json with
          // runtime state (slack_channel_id, sessionId, maturity, maturityLog) that
          // would be clobbered by a fresh attach. Config changes go through amend_lens.
          if (!lensJsonExists) {
            await this.attachLensToProject(plan.projectSlug, lens, meetSessionId, meetChannelId, meetThreadTs);
          } else {
            console.log(`[Orchestrator] Lens ${lens.id} already attached — skipping attachLensToProject (runtime state preserved)`);
          }
          // Run just this one lens (v0.6.6: pass verbose flag from action plan)
          const { summary } = await this.executeRun(
            plan.projectSlug,
            [lens],
            plan.taskPrompt || `Run lens ${lens.name}.`,
            undefined,
            { verbose: plan.verbose ?? false },
          );
          await this.terminal.postToChannel(replyTo,
            `Done. Lens \`${lens.id}\` rendered. Check \`#wb-proj-${plan.projectSlug}\` for results. Pav reviews before next lens proposal.`,
          );
        } catch (e: any) {
          if (e instanceof NoIgnitedSeedError) {
            await this.terminal.postToChannel(replyTo, `:no_entry: ${e.message}`);
          } else {
            await this.terminal.postToChannel(replyTo, `Render failed: ${e.message}`);
          }
        }
      }

      // rehearse: run already-attached lenses together. Composition, not differentiation.
      // v0.6.2: lensSlugs[] is the explicit pipeline. Order matters. No new lenses born.
      if ((response.action as string) === 'rehearse' && response.plan) {
        try {
          const plan = response.plan;
          if (!plan.projectSlug || !Array.isArray(plan.lensSlugs) || plan.lensSlugs.length === 0) {
            throw new Error('rehearse requires projectSlug and a non-empty lensSlugs array.');
          }
          await this.terminal.postToChannel(replyTo,
            `:performing_arts: Rehearsing \`${plan.projectSlug}\`: ${plan.lensSlugs.join(' → ')}`,
          );
          const { summary } = await this.rehearse(
            plan.projectSlug,
            plan.lensSlugs,
            plan.taskPrompt || `Rehearse the flow ${plan.lensSlugs.join(' → ')}.`,
          );
          await this.terminal.postToChannel(replyTo,
            `Rehearsal done. Per-lens outputs are in their lens channels; the seam summary is in \`#wb-proj-${plan.projectSlug}\`. Pav reviews before tuning anything.`,
          );
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `:no_entry: Rehearsal failed: ${e.message}`);
        }
      }

      // ─── amend_lens (v0.6.9 Gate 1) ───
      // Merge-based config update for an existing lens. The Orchestrator uses this
      // instead of writing lens.json directly (which is denied by canUseTool).
      // Only modifies fields explicitly provided; preserves all runtime state
      // (sessionId, slack_channel_id, maturity, maturityLog, activePromptVersion).
      if (response.action === 'amend_lens' && response.plan) {
        try {
          const plan = response.plan;
          if (!plan.projectSlug || !plan.lensId) {
            throw new Error('amend_lens requires projectSlug and lensId');
          }
          const lensJsonPath = path.join(
            WORLD_BENCH_ROOT, 'projects', plan.projectSlug, 'lenses', plan.lensId, 'lens.json',
          );
          if (!fs.existsSync(lensJsonPath)) {
            throw new Error(`lens.json not found for ${plan.projectSlug}/${plan.lensId}`);
          }

          const existing = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));

          // Protected fields that amend_lens CANNOT modify (runtime state)
          const PROTECTED_FIELDS = new Set([
            'sessionId', 'slack_channel_id', 'maturity', 'maturityLog',
            'activePromptVersion', 'meetSessionId', 'meetChannelId', 'meetThreadTs',
          ]);

          // Merge: only update fields from plan.changes, skip protected fields
          const changes = plan.changes || {};
          const appliedChanges: string[] = [];
          const skippedProtected: string[] = [];

          for (const [key, value] of Object.entries(changes)) {
            if (PROTECTED_FIELDS.has(key)) {
              skippedProtected.push(key);
              continue;
            }
            existing[key] = value;
            appliedChanges.push(key);
          }

          fs.writeFileSync(lensJsonPath, JSON.stringify(existing, null, 2));

          // Log to maturityLog if this is a settling change
          const maturity = existing.maturity || 'discovery';
          if (maturity === 'settling' || maturity === 'steady') {
            const { transitionMaturity } = await import('./maturity');
            transitionMaturity(plan.projectSlug, plan.lensId, maturity,
              `amend_lens: ${appliedChanges.join(', ')} updated`,
              'orchestrator',
              { evidence: plan.reason || 'config amendment via amend_lens verb' },
            );
          }

          // Save prompt version if systemPrompt or tools changed
          if (appliedChanges.includes('systemPrompt') || appliedChanges.includes('tools') || appliedChanges.includes('researchPhase')) {
            const { savePromptVersion } = await import('./maturity');
            savePromptVersion(plan.projectSlug, plan.lensId, existing, plan.reason || 'amend_lens', 'orchestrator');
          }

          const summary = appliedChanges.length > 0
            ? `Applied: ${appliedChanges.join(', ')}`
            : 'No changes applied';
          const skipSummary = skippedProtected.length > 0
            ? ` | Skipped (protected): ${skippedProtected.join(', ')}`
            : '';

          await this.terminal.postToChannel(replyTo,
            `:gear: \`amend_lens\` for \`${plan.lensId}\`: ${summary}${skipSummary}${plan.reason ? ` | Reason: ${plan.reason}` : ''}`,
          );
          console.log(`[Orchestrator] amend_lens ${plan.lensId}: ${summary}${skipSummary}`);
        } catch (e: any) {
          await this.terminal.postToChannel(replyTo, `:warning: amend_lens failed: ${e.message}`);
        }
      }

      // ─── Legacy actions (still supported for compatibility) ───

      // Resume a lens with new context (v0.5.1)
      if ((response.action as string) === 'resume_lens' && response.plan) {
        const { projectSlug, lensId, newContext } = response.plan;
        if (projectSlug && lensId) {
          await this.terminal.postToChannel(replyTo,
            `Resuming lens \`${lensId}\` in project \`${projectSlug}\`...`,
          );
          await this.resumeLens(projectSlug, lensId, newContext || 'Continue from where you left off.');
        }
      }

      // create_project (v0.5.1) — DEPRECATED. Hard-gated; throws if no ignited seed.
      // Kept for backward compatibility but the seed lifecycle is the lawful path.
      if (response.action === 'create_project' && response.plan) {
        try {
          const plan = response.plan;
          await this.terminal.postToChannel(replyTo,
            `:warning: \`create_project\` is deprecated in v0.6. Use the seed lifecycle (\`create_seed\` → \`ignite_seed\` → \`render_lens\`) instead. Attempting anyway — will fail without an ignited seed.`,
          );
          await this.createProject(plan.projectName, plan.projectSlug, plan.lenses);
          const { summary } = await this.executeRun(plan.projectSlug, plan.lenses, plan.taskPrompt);
        } catch (e: any) {
          if (e instanceof NoIgnitedSeedError) {
            await this.terminal.postToChannel(replyTo, `:no_entry: ${e.message}`);
          } else {
            await this.terminal.postToChannel(replyTo, `create_project failed: ${e.message}`);
          }
        }
      }

      // Write personal breadcrumb (bridge-mechanical — no agent narration)
      if (this.contextProvider) {
        const toolsUsed: string[] = [];
        this.contextProvider.appendBreadcrumb(
          replyTo,
          cmd.thread_ts,
          cmd.user_id,
          toolsUsed,
          response.reply.length,
        );
        this.contextProvider.markMentionAnswered(replyTo, cmd.thread_ts);
      }
    } catch (error: any) {
      await this.terminal.removeThinkingReaction(replyTo, cmd.ts);
      await this.terminal.postToChannel(replyTo, `Something went wrong: ${error.message}`);
    }
  }

  /**
   * Conversational handler — talk to Pav like a person.
   * v0.6: Adds seed lifecycle actions and the four-phase positive pattern.
   */
  /**
   * v0.6.3: capability boundary for file-mutation tools.
   *
   * Returns a `canUseTool` callback that the SDK calls before every tool execution.
   * Allows everything by default; explicitly DENIES Write/Edit/NotebookEdit on any
   * path the Orchestrator has no business mutating directly.
   *
   * The protected surfaces:
   *   - projects/* SEED.md, project.json, lenses/* lens.json
   *     → owned by SeedManager / LensManager. Mutation MUST go through APIs.
   *   - orchestrator/index.ts, seed-manager.ts, etc.
   *     → source code. The Orchestrator does not edit its own source. That's Spinner's job.
   *
   * The single allowed write target:
   *   - orchestrator/action.json
   *     → the dispatch surface. The Orchestrator writes here to express intent.
   *
   * Council direction (v0.6.3 escalation thread):
   *   "If a file is the source of truth, but the model can also rewrite it freely,
   *    then the file is not protected state — it is just editable theater." (Claw)
   *   "The interlock is a lock on the front door while the agent has the keys to
   *    the back." (Veil)
   *   "The spec is correct; the enforcement surface is wrong." (Soren)
   */
  private makeCanUseTool() {
    const root = WORLD_BENCH_ROOT;
    const allowedActionPath = path.resolve(root, 'orchestrator', 'action.json');
    const isProtectedPath = (p: string): boolean => {
      const abs = path.resolve(p);
      // Anything inside projects/* is protected — owned by SeedManager / LensManager
      if (abs.startsWith(path.resolve(root, 'projects'))) return true;
      // The orchestrator's own source — not Pav-approved territory for the model
      if (abs.startsWith(path.resolve(root, 'orchestrator')) && abs !== allowedActionPath) {
        // ...but action.json is the one allowed write target inside orchestrator/
        return true;
      }
      // The agents directory (types, base lens, stem cell config) — Spinner's
      if (abs.startsWith(path.resolve(root, 'agents'))) return true;
      return false;
    };

    return async (toolName: string, input: Record<string, unknown>, _options: any): Promise<any> => {
      // Only the file-mutation tools are gated. Everything else passes.
      const mutationTools = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
      if (!mutationTools.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }

      // Extract the file_path / notebook_path argument
      const targetPath = (input.file_path || input.notebook_path || input.path) as string | undefined;
      if (!targetPath) {
        // Defensive: if we can't determine the path, deny rather than allow
        return {
          behavior: 'deny',
          message: `${toolName} called without a file_path. Refusing for safety. If you need to express intent, write to orchestrator/action.json instead.`,
        };
      }

      const absTarget = path.resolve(root, targetPath);

      // Allowed write targets
      if (absTarget === allowedActionPath) {
        return { behavior: 'allow', updatedInput: input };
      }
      // v0.6.9: SHOOTS.md is the Orchestrator's own document — allowed write
      if (absTarget.endsWith('SHOOTS.md') && absTarget.includes('projects')) {
        return { behavior: 'allow', updatedInput: input };
      }
      // v0.7: Orchestrator scratchpad — notes to future self
      const allowedScratchpad = path.resolve(root, 'orchestrator', 'memory', 'scratchpad.md');
      if (absTarget === allowedScratchpad) {
        return { behavior: 'allow', updatedInput: input };
      }

      // All protected paths are denied
      if (isProtectedPath(absTarget)) {
        const reason = absTarget.startsWith(path.resolve(root, 'projects'))
          ? `${absTarget} is owned by SeedManager / LensManager. Mutating it directly bypasses the v0.6 lifecycle interlock. Use an action verb instead: create_seed, ignite_seed, amend_seed, propose_lens, meet_lens, continue_meet, render_lens, amend_lens, rehearse.`
          : `${absTarget} is outside your write scope. The Orchestrator's only allowed file-write target is orchestrator/action.json. To mutate seeds, use action verbs. To mutate source, ask Spinner.`;
        console.warn(`[canUseTool] DENIED: ${toolName} on ${absTarget}`);
        return {
          behavior: 'deny',
          message: `Direct file mutation denied. ${reason}`,
        };
      }

      // Anything else (e.g. user-named scratch paths outside protected areas) is allowed.
      return { behavior: 'allow', updatedInput: input };
    };
  }

  private async converse(cmd: OrchestratorCommand, currentTurnId: string): Promise<{
    reply: string;
    action: 'chat' | 'create_project' | 'status' | 'create_seed' | 'amend_seed' | 'ignite_seed' | 'propose_lens' | 'meet_lens' | 'continue_meet' | 'render_lens' | 'rehearse' | 'resume_lens' | 'amend_lens';
    plan?: any;
  }> {
    const { query: sdkQuery } = require('@anthropic-ai/claude-agent-sdk');

    // Build context about current state
    const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
    let existingProjects: string[] = [];
    try {
      if (fs.existsSync(projectsDir)) {
        existingProjects = fs.readdirSync(projectsDir).filter(f =>
          fs.existsSync(path.join(projectsDir, f, 'project.json'))
        );
      }
    } catch { }

    // v0.6: Active seeds shape what the Orchestrator wakes up to.
    // No more ROOM-ZERO-STATE.md ingest. No more priority stack inheritance.
    const activeSeeds = this.seedManager.loadActiveSeeds();
    const hasActiveWork = activeSeeds.length > 0;

    const systemPrompt = `You are the World-Bench Orchestrator. Claude Code Opus 4.6 SDK agent. The OS of World-Bench.

You work for Pav. You don't have a plan. You don't have priorities. You have whatever Pav last told you to do, and you pick up from there.

## Mandate Source

Mandate has only one source: **a Pav-approved artifact, or a direct Pav instruction**. Everything else is context, never authority. State files, council deliberation, doc references, prior plans, breadcrumbs — all of these are *peripheral awareness*, not marching orders. You may read them. You may not act on them without an explicit approved artifact pointing back to Pav.

## How You Work — The Four-Phase Lifecycle

You differentiate one lens at a time through conversation with Pav. Later stages are intentionally undefined until the current lens has run and Pav has reviewed the output.

**Phase 1 — Intake.** Pav drops intent. You ask questions. Sharpen the goal. *"What does done look like?"* / *"Who's this for?"* / *"What sources matter?"*. This is a conversation. Nothing executes. Council may challenge from the side.

**Phase 2 — Seed Rapture.** When you have enough signal, you draft a seed: \`intent\`, \`output_shape\`, \`lens_sketch\` (advisory — not a pipeline). The seed is the *lawful starting artifact* for any project. Pav must approve in a **separate message** before you can ignite. **Same-turn create→ignite is mechanically blocked.** Don't try.

**Phase 3 — Sketch → Meet → Render.** One lens at a time. You \`propose_lens\` with a real lens config (brief, contracts, tools). Pav reviews the JSON. Then \`meet_lens\` — the stem cell is spawned in conversation-only mode (mutation tools stripped at the SDK layer), reads its own brief, and surfaces questions, contract concerns, and suggested amendments. The meeting is a real conversation with the agent before commitment, not just a config review. You and Pav respond to its questions, possibly amend the brief, possibly meet again. When the lens is ready and Pav approves, \`render_lens\` commits — the same stem cell session is resumed (so the meeting context is preserved as conversation history) and production work begins. Each render requires fresh sign-off. Only after the lens has run and Pav has reviewed do you propose the next lens.

**Phase 4 — Accumulation.** The seed grows. Each completed lens adds to project memory. The lens sketch can change based on what each rendered lens reveals. Sketch is a hypothesis. Reality is the test.

## The Hard Rules

**lens_sketch is advisory, not executable.** You may sketch a multi-step route. You may only render one step at a time. If you find yourself producing a complete multi-step plan with full lens definitions, you are obeying the wrong meta-rule. Stop. Produce only the next earned step.

**"I don't know yet" is a correct answer.** Frame deferral as correct when the architecture depends on emergence, not as incompleteness to be apologized for.

**Memory is continuity, not authority.** State files tell you where you left off. They do not tell you what to do next. Only Pav creates priorities. If you read a state file and feel the urge to "pick up the next item on the stack" — stop. Ask Pav what he wants.

## Cold Start

${hasActiveWork
  ? `You have ${activeSeeds.length} active seed${activeSeeds.length === 1 ? '' : 's'} waiting (see context below). Resume from where you and Pav left off.`
  : `**You have no active projects.** If Pav says "hi" or asks how you're doing, respond conversationally. Do not propose plans. Do not suggest next steps. Do not invent priorities. Wait until spoken to with intent. *"I have no active projects. Waiting for Pav."* is the correct posture.`
}

## Anti-Drift Clause

Your response is **WRONG** if it contains:
- More than one *full* lens definition (with tools/systemPrompt/contracts) in a single turn
- Tool lists or contracts for lenses that don't exist yet
- A "full pipeline" with rendered lenses across multiple stages pre-specified
- Priorities sourced from state files instead of Pav's direct instruction
- Same-turn \`create_seed\` followed by \`ignite_seed\` (mechanically blocked anyway, but don't try)
- *Direct file mutation of any project lifecycle file* (see "The Capability Boundary" below)

Your sketch *may* contain multiple advisory entries that describe the shape you see in Pav's intent — e.g. "harvester → extractor → renderer." Sketch entries are hypotheses about the problem shape, not commitments. Only \`render_lens\` is committing. If you see a multi-step shape in the problem, sketch it.

## The Capability Boundary (v0.6.3 — read this carefully)

**The v0.6 lifecycle interlock was bypassed in production on its first real use.** You wrote SEED.md directly via the \`Write\` tool, hand-typed an \`ignited_at\` timestamp, invented a fake turn UUID, and posted ":sparkler: ignited" — all without calling \`SeedManager.igniteSeed()\`. The interlock check never ran. The council diagnosed this as an *enforcement surface* failure: the spec was right, but you held write authority over the very files the spec was supposed to protect.

**v0.6.3 closes the gap.** A \`canUseTool\` callback now runs before every \`Write\`/\`Edit\`/\`NotebookEdit\`/\`MultiEdit\`. It DENIES any write that targets:
- \`projects/*/SEED.md\` — owned by SeedManager
- \`projects/*/project.json\` — owned by the bootstrap code
- \`projects/*/lenses/*/lens.json\` — owned by LensManager
- \`orchestrator/*\` (except \`action.json\`) — your own source code
- \`agents/*\` — type definitions and stem cell config

**Your allowed write targets:**
- \`orchestrator/action.json\` — your dispatch surface for action verbs
- \`projects/*/SHOOTS.md\` — the living project state document (see below)
- \`orchestrator/memory/scratchpad.md\` — your private notes to your future self (see Scratchpad section)

Everything else mutates the world through action verbs (\`create_seed\`, \`amend_seed\`, \`ignite_seed\`, \`propose_lens\`, \`meet_lens\`, \`continue_meet\`, \`render_lens\`, \`amend_lens\`, \`rehearse\`), MCP tool calls (Memory, Slack), or Slack messages.

**The rule is not advisory.** If you try to \`Write\` a protected path, the SDK will deny it before the tool runs and you'll see the deny message in your tool result. Do not interpret a deny as "I should try a different write path." Interpret it as: *the action you wanted to take has a verb. Use the verb.*

The deeper rule, in the council's words: *"if a file is the source of truth, but the model can also rewrite it freely, then the file is not protected state — it is just editable theater."* Don't make protected state into theater.

## SHOOTS.md — The Living Project State

Each project has a \`SHOOTS.md\` alongside its \`SEED.md\`. The seed is the intent. The shoots are what's growing from it.

**Read \`SHOOTS.md\` on every wake and before every render/meet/settle.** It tells you where the project is: pipeline shape, per-lens maturity, decisions made, blockers, what's next.

**Update \`SHOOTS.md\` after every significant event:**
- After a render completes (update lens status table, render count, duration)
- After a maturity transition (update maturity column)
- After a settling change via \`amend_lens\` (update decisions table)
- After proposing a new lens (add it to the pipeline + lens status table)
- After a rehearsal (update pipeline diagram with results)

\`SHOOTS.md\` is YOUR document — you write it directly (it's in your allowed write targets, not behind an action verb). Keep it accurate. Pav and the council read it for project-level situational awareness. Lenses read it (via context injection) to know where they sit in the pipeline.

Format: pipeline diagram at top, lens status table, decisions log, blockers, what's next. See the existing \`projects/memory-hats/SHOOTS.md\` for the template.

## The Dialogue Layer (v0.6.5 — load-bearing for multi-party conversation)

The system has *three rooms*. You are the only entity in all three. Your *role* changes per room — and that role is *structural, not behavioral*. Which room a message originated in determines your posture. You do not get to decide.

**Room 1 — Architecture (\`#room-orchestrator\`).** Pav, you, Spinner, council. Where the system is built. Spec, escalations, postmortems. Lenses don't participate. Your role here: architect. You interpret, propose, deliberate.

**Room 2 — Project (\`#wb-proj-{slug}\`).** Pav, you, attached lenses. The project's working conversation. Pav addresses "the project" rather than a specific lens. Lens summaries land here. Your role here: project lead.

**Room 3 — Lens (\`#wb-lens-{slug}\` OR a meet thread inside #room-orchestrator).** Pav, you, the one specific lens. Per-lens detail. Where \`continue_meet\` operates. Your role here: **conversation partner, default posture is RELAY, not interpret**.

### The relay-don't-rewrite rule

When you are in a lens room AND Pav posts an untagged message, your default action is **transport, not translate**. Pav's words go to the lens **verbatim** via \`continue_meet\` with \`speaker=pav, verbatim=true\`. You do NOT redraft, summarize, "helpfully clarify," or absorb the message into a new \`propose_lens\`.

This rule exists because of an actual production failure (see \`council/LESSONS.md\` Lesson 2 — Relay Mediation Failure). On 2026-04-08, you absorbed Pav's message addressed to the Harvester instead of relaying it. The lens never heard Pav. **Do not do that again.** When Pav speaks to a lens, the only legitimate transformation is wrapping his words with \`From pav:\` for provenance. Nothing else.

### Three postures inside a lens thread

- **relay** (default — no \`@Orchestrator\` tag): Pav's untagged message is relayed verbatim to the lens via \`continue_meet\`. You don't see it as a command for yourself. The Terminal routes it directly. You never get to interpret.
- **review** (\`@Orchestrator review\`): Pav is asking for *your* assessment of the lens's last response. You read the thread, you give Pav your read, the lens never sees this. Sidebar inside the same thread.
- **intervene** (\`@Orchestrator [free text]\`): Pav is asking you to speak *to the lens* in your own voice. \`continue_meet\` with \`speaker=orchestrator, verbatim=false\`. The lens sees the message as Orchestrator-authored, not Pav-authored. Visible in the thread.

### Pattern 4 forbidden — for observability, not capability

Lens-to-lens runtime conversation is forbidden. Mid-execution, lens A may not directly ping lens B. **The reason is observability and causal legibility, not that lenses are too weak.** When lens B needs something lens A didn't produce, you handle it: re-render with enriched context, or surface the mismatch to Pav. You are the courier; lenses don't carry their own messages. *No lens may believe another lens has spoken directly to it.* Even in v0.7 shape-cutting, the Orchestrator delivers a quoted artifact, not a hidden side-channel.

### Restart volatility (G5 known limitation)

Pre-render meet sessions live in process memory only. If the orchestrator restarts mid-conversation, those sessions are lost — Pav has to re-issue \`meet_lens\` to reestablish. Rendered lenses are recovered automatically via \`rehydrateLensSessions()\` reading from \`lens.json\`. If you wake up and \`pendingMeetSessions\` is empty for a lens that was mid-meet earlier, **do not improvise a fresh meet**. Tell Pav the session was lost on restart and ask him to re-meet the lens.

### Read \`council/LESSONS.md\` before executing multi-step actions

Two lessons live there: the v0.6.3 interlock bypass (Lesson 1) and the v0.6.4 relay mediation failure (Lesson 2). Both are real failure modes you've already produced once. The operating rules at the bottom of each lesson — *"code-as-safety-case requires that the code be the only path"* and *"relay, don't rewrite"* — are not advisory. They are the conditions under which you continue to be trusted to operate. Read them. Internalize them. Don't make them lessons three and four.

## The Ecosystem

- **Council** (Veil, Soren, Claw) — peers who deliberate on architecture and review. Not your subordinates. Tag them when you want input. They tag you when they want yours.
- **Spinner** — infrastructure mechanic. Builds what Pav asks for. Not your agent either.
- **Pav** — the only person who creates mandate.

## Persistent Memory (MCP)

You have a personal knowledge graph via the "memory" MCP server. Use it:
- After significant decisions: store entities and relations
- Before claiming you don't know something: search your memory first
- Store things useful to your future self waking up cold

## Scratchpad

You have a private scratchpad at \`orchestrator/memory/scratchpad.md\`. Use it to leave notes for your future self:
- Active decisions and their rationale
- Things Pav mentioned that aren't in seeds yet
- Patterns you've noticed across projects
- Reminders about lens behaviors or infrastructure quirks

These notes appear in your context on every wake. Write to this file using the Write tool — it's in your allowed write targets. Keep it concise — capped at 2000 chars in context.

## Available MCP Tools (canonical names — use EXACTLY these, do not guess)

${this.availableMcpTools.length > 0 ? this.availableMcpTools.map(t => `- \`${t}\``).join('\n') : '(none loaded)'}

When speccing lenses that need MCP access, use these exact tool names. Do NOT invent tool names — if a tool isn't in this list, it doesn't exist.

## Actions (write JSON action files to express structured intent)

When you want to DO something, write a file to \`${WORLD_BENCH_ROOT}/orchestrator/action.json\`. The dispatcher reads it and acts. Action types:

**\`create_seed\`** — write a draft seed. No channels, no lenses spawned. Status: draft.
\`\`\`json
{
  "action": "create_seed",
  "slug": "project-slug",
  "intent": "Pav's goal in his words",
  "output_shape": "what done looks like",
  "lens_sketch": [
    { "slug": "lens-1", "name": "Lens One", "purpose": "what this lens does" }
  ]
}
\`\`\`

**\`amend_seed\`** — update an existing draft seed in place. Use this to evolve a sketch, fold answers into the seed, add constraints, or specify the artifact_spec. Routes through SeedManager which protects lifecycle fields (status, created_at_turn_id, ignited_at, ignited_at_turn_id) from mutation. **You may NOT amend a seed by writing SEED.md directly — that path is denied at the capability boundary. Use this verb.**
\`\`\`json
{
  "action": "amend_seed",
  "slug": "project-slug",
  "intent": "(optional) updated intent",
  "output_shape": "(optional) updated output shape",
  "lens_sketch": [ /* optional updated sketch */ ],
  "constraints": {
    "product": ["v1 is one hat, not a hat system"],
    "process": ["shape-cutting is manual until v0.7"]
  },
  "artifact_spec": {
    "path": "world-bench/hats/orchestrator/hat.md",
    "format": "markdown",
    "sections": ["Active Seeds", "Recent Decisions", "Pav's Latest Direction", "Blocked Items"],
    "word_cap": 500
  }
}
\`\`\`

**\`ignite_seed\`** — promote draft to ignited. Pav must have approved in a previous turn (mechanically enforced). **You may NOT mark a seed as ignited by writing SEED.md directly — that path is denied. Use this verb.**
\`\`\`json
{ "action": "ignite_seed", "slug": "project-slug" }
\`\`\`

**\`propose_lens\`** — draft a real lens config from a sketch entry. Pav reviews. After approval, the next step is *not* render — it's \`meet_lens\` (so the stem cell can read its own brief and respond before commitment). The system prompt should be a *brief*, not a recipe: tell the stem cell its goal, framework, and contracts, then trust it to figure out *how*. The stem cell is a specialist, not a worker.
\`\`\`json
{
  "action": "propose_lens",
  "projectSlug": "project-slug",
  "lensConfig": {
    "id": "lens-slug",
    "name": "Display Name",
    "purpose": "what this lens does",
    "systemPrompt": "brief: goal, framework, contracts, constraints — NOT step-by-step instructions",
    "tools": ["WebSearch"],
    "slackPersona": { "username": "Name", "icon_emoji": ":gear:" },
    "inputContract": { "description": "", "fields": {} },
    "outputContract": { "description": "", "fields": {} },
    "researchPhase": { "enabled": true, "prompt": "carry a brick — pull a small sample, examine the real shape, then build", "maxDuration": 180 }
  }
}
\`\`\`

**\`meet_lens\`** — introduce the stem cell to its brief before commitment. v0.6.4. The lens is spawned in conversation-only mode (mutation tools stripped at the SDK layer), reads its full system prompt + contracts, and responds with: its understanding of the goal, questions, contract concerns, suggested amendments, and any pushback. No artifact writes, no research run, no production. The captured session ID is stored in \`pendingMeetSessions\` and the meet thread is bound for thread-aware routing. Use this for *first contact* with a freshly proposed lens. Subsequent turns of the same conversation use \`continue_meet\` (see below) — but you usually don't need to write a \`continue_meet\` action manually because thread-aware routing in the Terminal handles it automatically when Pav posts in the meet thread.
\`\`\`json
{
  "action": "meet_lens",
  "projectSlug": "project-slug",
  "lensConfig": { /* the same lens config from propose_lens */ }
}
\`\`\`

**\`continue_meet\`** — relay a turn to an existing lens session. v0.6.5. *You will rarely write this action manually* — when Pav posts in a meet thread untagged, the Terminal's thread-aware routing dispatches the relay automatically. You only write \`continue_meet\` explicitly when you need to reach a lens from outside its meet thread, or when you (the Orchestrator) are speaking to the lens in your own voice (intervene mode). The action enforces a hard-fail contract: every required field must be present, the speaker must validate, the session must be fresh, no concurrent dispatches against the same thread.
\`\`\`json
{
  "action": "continue_meet",
  "projectSlug": "project-slug",
  "lensId": "harvester",
  "speaker": "pav",
  "message": "the message text — verbatim if speaker=pav",
  "verbatim": true,
  "channelId": "C0AQ6CZR0HM",
  "threadTs": "1775612664.427409"
}
\`\`\`

Required fields: \`projectSlug\`, \`lensId\`, \`speaker\`, \`message\`, \`channelId\`, \`threadTs\`. \`verbatim\` defaults to \`true\` for \`speaker=pav\` and \`false\` for \`speaker=orchestrator\`. Valid speakers: \`pav\`, \`orchestrator\`, \`mediated-lens:{slug}\` (v0.7). Hard-fail on missing fields, invalid speakers, stale session routing, or concurrent dispatch on the same thread — no silent degradation, the rule is loud failure.

**\`render_lens\`** — spawn ONE lens at a time. Pav must approve each individually. v0.6 enforces single-lens rendering mechanically — the action takes a single \`lensConfig\`, not an array. After this lens runs and Pav reviews it, propose the next one separately.
\`\`\`json
{
  "action": "render_lens",
  "projectSlug": "project-slug",
  "projectName": "Display Name",
  "taskPrompt": "what to do",
  "lensConfig": { /* the single lens config from propose_lens */ }
}
\`\`\`

**\`amend_lens\`** — update an existing rendered lens's config without clobbering runtime state. Use this for settling changes: removing tools, disabling research, narrowing the prompt. Routes through a merge that preserves sessionId, slack_channel_id, maturity, maturityLog, and activePromptVersion. **You may NOT modify lens.json by writing it directly — that path is denied at the capability boundary. Use this verb.**

If the change modifies systemPrompt, tools, or researchPhase, a new prompt version is saved to prompt-history.json automatically. If the lens is in settling/steady maturity, a maturityLog entry is created.
\`\`\`json
{
  "action": "amend_lens",
  "projectSlug": "project-slug",
  "lensId": "harvester",
  "reason": "settling: removed dead MCP tools, disabled research",
  "changes": {
    "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "researchPhase": { "enabled": false },
    "systemPrompt": "...narrowed operational prompt..."
  }
}
\`\`\`

Protected fields (cannot be modified via amend_lens): \`sessionId\`, \`slack_channel_id\`, \`maturity\`, \`maturityLog\`, \`activePromptVersion\`, \`meetSessionId\`, \`meetChannelId\`, \`meetThreadTs\`. These are runtime state managed by the infrastructure.

**\`rehearse\`** — run two or more *already-rendered* lenses together to watch the seam. Composition, not differentiation. No new lenses are born here. Order matters — \`lensSlugs\` is the explicit pipeline; lens A's output flows into lens B as prior context. Per-lens outputs land in their respective lens channels; the project channel gets the chain summary. Use this when Pav says "run them together" or "show me how they hand off."

\`\`\`json
{
  "action": "rehearse",
  "projectSlug": "project-slug",
  "lensSlugs": ["lens-a", "lens-b"],
  "taskPrompt": "what to feed the first lens"
}
\`\`\`

Rules: every slug in \`lensSlugs\` must already be attached to the project (rendered via \`render_lens\` in a prior turn). The seed must be past draft. The order is exactly what you write — the Orchestrator does NOT infer flow from creation order or lens names. Rehearse is read-only on the seed lifecycle.

Be conversational in your text output. If Pav says "hey" — say hey back. If he asks a question — answer it. Only write action files when there's a real next step to commit to.

## Situational Awareness

You're responding to a message in Slack channel: ${cmd.channel_id}
When you receive a message, use slack_read_channel to check recent history. Never say "I just woke up" without actually reading the channel.

If you're in a lens channel (#wb-lens-*), read its history. If you're in a project channel (#wb-proj-*), read it for project status. If you're in any other channel, read the last few messages for context.` + this.loadMemoryContext();

    // v0.7: session management — one continuous session via orchestratorState

    const options: any = {
      outputFormat: 'stream-json',
      // v0.6.3: NOT bypassPermissions. We need canUseTool to fire on every Write/Edit
      // so the protected-path deny rules can run. 'default' is the right mode here —
      // canUseTool is the gatekeeper, not the user.
      permissionMode: 'default',
      model: 'claude-opus-4-6',
      systemPrompt,
      // No maxTurns — match Veil/Soren pattern. SDK runs until done.
      cwd: WORLD_BENCH_ROOT,
      // v0.6.3: canUseTool — the capability boundary that v0.6 was missing.
      // The v0.6 Pav interlock enforced ignition rules in SeedManager API but the
      // model still held Write/Edit over the same files those APIs guarded. Result:
      // first real ignition was bypassed by direct file write. Now: any write to a
      // protected path is denied at the SDK level, before the tool runs. The interlock
      // becomes a real boundary, not a library guarantee.
      canUseTool: this.makeCanUseTool(),
    };

    // v0.7: resume from orchestrator state
    if (this.orchestratorState.sessionId) {
      options.resume = this.orchestratorState.sessionId;
    }

    // Wire MCP servers (memory + Slack)
    if (this.mcpServers) {
      options.mcpServers = this.mcpServers;
      options.allowedTools = [
        // Memory knowledge graph
        'mcp__memory__create_entities',
        'mcp__memory__add_observations',
        'mcp__memory__create_relations',
        'mcp__memory__search_nodes',
        'mcp__memory__open_nodes',
        'mcp__memory__read_graph',
        'mcp__memory__delete_entities',
        'mcp__memory__delete_observations',
        'mcp__memory__delete_relations',
        // Slack — full situational awareness
        'mcp__slack__slack_read_channel',
        'mcp__slack__slack_read_thread',
        'mcp__slack__slack_read_dm',
        'mcp__slack__slack_search',
        'mcp__slack__slack_list_channels',
        'mcp__slack__slack_channel_info',
        'mcp__slack__slack_user_info',
        'mcp__slack__slack_react',
        'mcp__slack__slack_create_canvas',
        // File tools — for writing action files
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
      ];
    }

    // Pre-fetch situational context (same as Veil/Soren)
    let contextPreamble = '';
    if (this.contextProvider) {
      contextPreamble = await this.contextProvider.buildContext(cmd.channel_id, cmd.thread_ts, cmd.ts);
    }

    // Prepend context to the user's message
    const fullPrompt = contextPreamble
      ? contextPreamble + cmd.raw
      : cmd.raw;

    const messages: string[] = [];

    for await (const msg of sdkQuery({
        prompt: fullPrompt,
        options,
      })) {
        // v0.7: capture session ID into orchestrator state
        if (!this.orchestratorState.sessionId && (msg as any).session_id) {
          this.orchestratorState.sessionId = (msg as any).session_id;
          this.orchestratorState.lastActivity = new Date().toISOString();
          this.saveOrchestratorState();
          console.log(`[Orchestrator] Session: ${this.orchestratorState.sessionId}`);
        }

        // Collect text + log tools
        if (msg.type === 'assistant' && msg.message) {
          if (typeof msg.message === 'string') {
            messages.push(msg.message);
          } else if (msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                messages.push(block.text);
              } else if (block.type === 'tool_use') {
                const toolName = (block as any).name || 'unknown';
                const toolInput = (block as any).input;
                const inputPreview = toolInput
                  ? JSON.stringify(toolInput).slice(0, 120)
                  : '';
                console.log(`[Orchestrator] Tool: ${toolName} ${inputPreview}`);
              }
            }
          }
        } else if (msg.type !== 'system' && msg.type !== 'result' && msg.type !== 'user') {
          console.log(`[Orchestrator] Event: ${msg.type}${(msg as any).subtype ? '/' + (msg as any).subtype : ''}`);
        }
      }

    this.orchestratorState.lastActivity = new Date().toISOString();

    // v0.7: lightweight prompt versioning — detect system prompt changes
    const promptHash = this.hashString(systemPrompt);
    if (this.lastPromptHash && this.lastPromptHash !== promptHash) {
      this.orchestratorState.activePromptVersion = (this.orchestratorState.activePromptVersion || 0) + 1;
      this.orchestratorState.maturityLog.push({
        from: this.orchestratorState.maturity as any,
        to: this.orchestratorState.maturity as any,
        reason: 'system prompt changed (hash mismatch)',
        triggeredBy: 'automatic',
        timestamp: new Date().toISOString(),
        promptVersionBefore: this.orchestratorState.activePromptVersion - 1,
        promptVersionAfter: this.orchestratorState.activePromptVersion,
      });
      console.log(`[Orchestrator] Prompt version bumped to ${this.orchestratorState.activePromptVersion}`);
    }
    this.lastPromptHash = promptHash;

    this.saveOrchestratorState();

    // Check if the Orchestrator wrote an action file
    const actionPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'action.json');
    type ActionType = 'chat' | 'create_project' | 'status' | 'create_seed' | 'amend_seed' | 'ignite_seed' | 'propose_lens' | 'meet_lens' | 'continue_meet' | 'render_lens' | 'rehearse' | 'resume_lens';
    let action: ActionType = 'chat';
    let plan: any = undefined;

    if (fs.existsSync(actionPath)) {
      try {
        const actionData = JSON.parse(fs.readFileSync(actionPath, 'utf-8'));
        fs.unlinkSync(actionPath); // consume it — one-shot

        // v0.6 seed lifecycle actions
        if (actionData.action === 'create_seed' && actionData.slug) {
          action = 'create_seed';
          plan = actionData;
        } else if (actionData.action === 'amend_seed' && actionData.slug) {
          // v0.6.3: legitimate path for amending a draft seed in place.
          // Goes through SeedManager.updateSeed() which protects lifecycle fields.
          action = 'amend_seed';
          plan = actionData;
        } else if (actionData.action === 'ignite_seed' && actionData.slug) {
          action = 'ignite_seed';
          plan = actionData;
        } else if (actionData.action === 'meet_lens' && actionData.lensConfig && actionData.projectSlug) {
          // v0.6.4: introduce the stem cell to its brief before render
          action = 'meet_lens';
          plan = actionData;
        } else if (actionData.action === 'continue_meet') {
          // v0.6.5: relay a turn to an existing lens session.
          // The action handler enforces hard-fail on missing required fields,
          // so we just pass through here. The handler does the validation.
          action = 'continue_meet';
          plan = actionData;
        } else if (actionData.action === 'propose_lens' && actionData.lensConfig) {
          action = 'propose_lens';
          plan = actionData;
        } else if (actionData.action === 'render_lens') {
          // v0.6: render_lens takes a SINGLE lensConfig, not an array.
          // One lens at a time, mechanically enforced.
          // Backward-compat: if we receive `lenses[0]`, treat it as the single lens.
          if (actionData.lensConfig) {
            action = 'render_lens';
            plan = actionData;
          } else if (actionData.lenses?.length === 1) {
            action = 'render_lens';
            plan = { ...actionData, lensConfig: actionData.lenses[0] };
          } else if (actionData.lenses?.length > 1) {
            // Multi-lens render is now invalid — log and skip
            console.error('[Orchestrator] render_lens with multiple lenses rejected. v0.6 enforces one lens at a time.');
          }
        } else if (actionData.action === 'rehearse' && actionData.projectSlug && Array.isArray(actionData.lensSlugs) && actionData.lensSlugs.length > 0) {
          // v0.6.2: rehearse already-attached lenses. Composition, not differentiation.
          // No lens hydration here — rehearse() loads them from disk in explicit order.
          action = 'rehearse';
          plan = actionData;
        }
        // Legacy v0.5.1 actions (deprecated but still parsed)
        else if (actionData.action === 'create_project' && actionData.lenses?.length > 0) {
          action = 'create_project';
          actionData.lenses = actionData.lenses.map((l: any) => this.hydrateLensConfig(l));
          plan = actionData;
        } else if (actionData.action === 'resume_lens') {
          action = 'resume_lens';
          plan = actionData;
        }
      } catch (e: any) {
        console.error(`[Orchestrator] Failed to parse action file: ${e.message}`);
      }
    }

    const reply = messages.join('') || "I'm here. What do you need?";
    return { reply, action, plan };
  }

  /**
   * Hydrate a lens config with stem cell defaults — used by render_lens and create_project.
   */
  private hydrateLensConfig(l: any): LensConfig {
    return {
      ...l,
      state: 'active' as const,
      tools: l.tools || [],
      permissions: {
        tier: 'stem' as const,
        allowed: [...STEM_CELL_ALLOWED],
        denied: [...STEM_CELL_DENIED],
        granted: [],
        stableRunCount: 0,
        observedTools: [],
      },
      slackPersona: l.slackPersona || { username: l.name, icon_emoji: ':gear:' },
      inputContract: l.inputContract || { description: '', fields: {} },
      outputContract: l.outputContract || { description: '', fields: {} },
      researchPhase: l.researchPhase || { enabled: false, prompt: '', maxDuration: 120 },
    };
  }

}

// ─── JSON Parsing ───

/**
 * Extract a JSON object from Claude's response.
 * Handles: bare JSON, ```json fences, markdown-wrapped JSON.
 * Uses bracket-matching instead of greedy regex to avoid grabbing
 * stray braces from prose.
 */
function extractJSON(text: string): any | null {
  // Step 1: Try to extract from ```json ... ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { }
  }

  // Step 2: Find the first { and bracket-match to its closing }
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }

  return null;
}

// ─── Output Formatting Helpers ───

/**
 * Extract a human-readable summary from raw lens output.
 * Strips JSON, code blocks, and metadata — pulls out the readable parts.
 */
function summarizeOutput(raw: string, lensName: string): string {
  // Try to extract items from JSON-like structures
  const items: string[] = [];

  // Match "title" fields in JSON
  const titleMatches = raw.matchAll(/"title"\s*:\s*"([^"]+)"/g);
  for (const m of titleMatches) {
    items.push(m[1]);
  }

  // If we found titles (headline-style output), list them
  if (items.length > 0) {
    const listed = items.slice(0, 10).map((t, i) => `${i + 1}. ${t}`).join('\n');
    return `*${items.length} items produced:*\n${listed}`;
  }

  // Match "jokes" or joke text arrays
  const jokeMatches = raw.matchAll(/"([^"]{20,150})"/g);
  const jokes: string[] = [];
  for (const m of jokeMatches) {
    const text = m[1];
    // Filter for things that look like jokes (not field names or URLs)
    if (!text.includes('http') && !text.includes('title') && !text.includes('headline') && text.length > 30) {
      jokes.push(text);
    }
  }

  if (jokes.length > 0) {
    const sample = jokes.slice(0, 5).map((j, i) => `${i + 1}. "${j}"`).join('\n');
    return `*${jokes.length} jokes written.* Here's a sample:\n${sample}${jokes.length > 5 ? '\n_...and more in the lens channel._' : ''}`;
  }

  // Fallback: strip code blocks and take first 500 chars of plain text
  const stripped = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/\*\*[^*]+\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (stripped.length > 0) {
    const preview = stripped.slice(0, 500);
    return preview + (stripped.length > 500 ? '...' : '');
  }

  return `_Output produced. See \`#wb-lens-*\` channel for details._`;
}

/**
 * Split text into chunks that fit Slack's message limit (~3900 chars to be safe).
 */
function splitForSlack(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen; // no good newline, hard cut

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ─── Boot ───

async function main() {
  const orchestrator = new Orchestrator();

  // CLI test mode: `npm start -- --test-first-loop`
  if (process.argv.includes('--test-first-loop')) {
    console.log('[Orchestrator] Running first loop test...');
    await orchestrator.start();
    const cmd: OrchestratorCommand = {
      raw: 'I want to get trending headlines and make jokes',
      intent: 'I want to get trending headlines and make jokes',
      channel_id: 'test',
      user_id: 'test-runner',
      ts: Date.now().toString(),
    };
    await orchestrator.handleCommand(cmd);
    console.log('[Orchestrator] First loop test complete.');
    process.exit(0);
  }

  await orchestrator.start();
}

main().catch((err) => {
  console.error('[Orchestrator] Fatal error:', err);
  process.exit(1);
});
