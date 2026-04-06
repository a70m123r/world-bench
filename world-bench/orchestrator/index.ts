// World-Bench v0.4 — Orchestrator Entry Point
// The OS of the system. Interprets Pav's intent, differentiates stem cells
// into lenses, routes work, manages state, handles handoffs.

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import dotenv from 'dotenv';
import {
  LensConfig,
  ProjectMeta,
  WorkflowEvent,
  OrchestratorCommand,
  STEM_CELL_ALLOWED,
  STEM_CELL_DENIED,
} from '../agents/types';
import { ClaudeAgentAdapter } from './agent-adapter';
import { LensManager, LensRunResult } from './lens-manager';
import { Terminal } from './terminal';
import { ContextProvider } from './context-provider';

// Load env from orchestrator config dir
dotenv.config({ path: path.join(__dirname, 'config', '.env'), override: true });

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');

// Session tracking — persist across messages so Claude remembers the conversation
interface OrchestratorSession {
  sessionId?: string;
  lastActivity: Date;
}

export class Orchestrator {
  private adapter: ClaudeAgentAdapter;
  private lensManager: LensManager;
  private terminal: Terminal;
  private contextProvider: ContextProvider | null = null;
  private sessions: Map<string, OrchestratorSession> = new Map();
  private mcpServers: Record<string, any> | null = null;
  private availableMcpTools: string[] = [];

  constructor() {
    this.adapter = new ClaudeAgentAdapter();
    this.lensManager = new LensManager(this.adapter, WORLD_BENCH_ROOT);
    this.terminal = new Terminal(this);
    this.loadMcpConfig();
    this.loadSessionsFromDisk();
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

  private loadSessionsFromDisk(): void {
    const sessionsPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'sessions.json');
    try {
      if (fs.existsSync(sessionsPath)) {
        const entries: [string, OrchestratorSession][] = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
        for (const [key, session] of entries) {
          session.lastActivity = new Date(session.lastActivity);
          this.sessions.set(key, session);
        }
        console.log(`[Orchestrator] Loaded ${this.sessions.size} sessions from disk`);
      }
    } catch { }
  }

  private saveSessionsToDisk(): void {
    const sessionsPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'sessions.json');
    try {
      fs.writeFileSync(sessionsPath, JSON.stringify(Array.from(this.sessions.entries()), null, 2));
    } catch { }
  }

  private getSessionKey(cmd: OrchestratorCommand): string {
    // Single brain — one session across all channels.
    // The Orchestrator is one agent, not a per-channel bot.
    return `orchestrator-main`;
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

    // Project state — what projects exist and their status
    const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
    try {
      if (fs.existsSync(projectsDir)) {
        const projectSummaries: string[] = [];
        for (const slug of fs.readdirSync(projectsDir)) {
          const pjPath = path.join(projectsDir, slug, 'project.json');
          if (!fs.existsSync(pjPath)) continue;
          const pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));

          // Find latest run
          const runsDir = path.join(projectsDir, slug, 'runs');
          let latestRun = 'no runs';
          if (fs.existsSync(runsDir)) {
            const runs = fs.readdirSync(runsDir).sort();
            if (runs.length > 0) {
              const metaPath = path.join(runsDir, runs[runs.length - 1], 'meta.json');
              if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                latestRun = `${meta.status} (${meta.finished_at || 'in progress'})`;
              }
            }
          }

          // List lenses
          const lenses = pj.lenses?.join(', ') || 'none';
          projectSummaries.push(`- **${pj.name}** (\`${slug}\`): lenses: ${lenses}, last run: ${latestRun}`);
        }
        if (projectSummaries.length > 0) {
          sections.push(`## Active Projects\n${projectSummaries.join('\n')}`);
        }
      }
    } catch { }

    // Room Zero state — if available
    const roomState = path.join(WORLD_BENCH_ROOT, '..', 'council', 'ROOM-ZERO-STATE.md');
    if (fs.existsSync(roomState)) {
      try {
        // Just read first 1500 chars for the summary
        const content = fs.readFileSync(roomState, 'utf-8').trim().slice(0, 1500);
        sections.push(`## Room Zero State (summary)\n${content}`);
      } catch { }
    }

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
    const projectDir = path.join(WORLD_BENCH_ROOT, 'projects', slug);

    // Step 1: Create filesystem
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'runs'), { recursive: true });

      for (const lens of lensConfigs) {
        const lensDir = path.join(projectDir, 'lenses', lens.id);
        fs.mkdirSync(path.join(lensDir, 'memory'), { recursive: true });
        fs.mkdirSync(path.join(lensDir, 'workspace'), { recursive: true });
        fs.mkdirSync(path.join(lensDir, 'output'), { recursive: true });
        fs.writeFileSync(
          path.join(lensDir, 'lens.json'),
          JSON.stringify(lens, null, 2),
        );
      }
    } catch (error: any) {
      console.error(`[Orchestrator] Filesystem creation failed: ${error.message}`);
      throw error; // Spec: on directory failure → stop immediately
    }

    // Step 2: Create Slack channels
    let projectChannelId: string | undefined;
    const lensChannelIds: Map<string, string> = new Map();

    try {
      projectChannelId = await this.terminal.createChannel(
        `wb-proj-${slug}`,
        `World-Bench project: ${name}`,
      ) || undefined;

      for (const lens of lensConfigs) {
        const channelId = await this.terminal.createChannel(
          `wb-lens-${lens.id}`,
          `Lens: ${lens.name} — ${lens.purpose}`,
        );
        if (channelId) {
          lensChannelIds.set(lens.id, channelId);
        }
      }
    } catch (error: any) {
      // Spec: on Slack failure → clean up directories
      console.error(`[Orchestrator] Slack channel creation failed: ${error.message}`);
      console.error('[Orchestrator] Rolling back filesystem directories...');
      fs.rmSync(projectDir, { recursive: true, force: true });
      throw error;
    }

    // Step 3: Write project.json with channel IDs
    const meta: ProjectMeta = {
      name,
      slug,
      created_at: new Date().toISOString(),
      project_channel_id: projectChannelId,
      lenses: lensConfigs.map(l => l.id),
    };

    fs.writeFileSync(
      path.join(projectDir, 'project.json'),
      JSON.stringify(meta, null, 2),
    );

    // Update lens.json files with their channel IDs
    for (const lens of lensConfigs) {
      const channelId = lensChannelIds.get(lens.id);
      if (channelId) {
        const lensJsonPath = path.join(projectDir, 'lenses', lens.id, 'lens.json');
        const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
        lensData.slack_channel_id = channelId;
        fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));
      }
    }

    return meta;
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
    for (const lens of lensConfigs) {
      await this.terminal.postAsLens(
        lens,
        projectSlug,
        `Starting work on: ${taskPrompt.slice(0, 100)}...`,
      );

      const result = await this.lensManager.runLens(
        lens, projectSlug, runId, taskPrompt, priorOutput, feedback,
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

    // Build final summary
    const summary = this.buildRunSummary(results, meta);
    await this.terminal.postToProject(projectSlug, summary);

    return { runId, results, summary };
  }

  private buildRunSummary(results: LensRunResult[], meta: any): string {
    const lines: string[] = [];
    lines.push(`**Run Complete** — Status: \`${meta.status}\``);
    lines.push('');

    for (const r of results) {
      const status = r.productionResult?.status || 'skipped';
      const icon = status === 'completed' ? ':white_check_mark:' : ':x:';
      lines.push(`${icon} **${r.lens.name}**: ${status}`);
    }

    lines.push('');
    lines.push('_Full output in each lens channel. Dive in for details._');

    return lines.join('\n');
  }

  // ─── Lens Resume ───

  /**
   * Resume a lens from its last session with new context/feedback.
   */
  async resumeLens(
    projectSlug: string,
    lensId: string,
    newContext: string,
  ): Promise<LensRunResult | null> {
    const lensJsonPath = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json');
    if (!fs.existsSync(lensJsonPath)) {
      console.error(`[Orchestrator] Lens not found: ${projectSlug}/${lensId}`);
      return null;
    }

    const lens: LensConfig = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
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

    // Show thinking indicator (hourglass reaction on Pav's message)
    await this.terminal.addThinkingReaction(replyTo, cmd.ts);

    try {
      const response = await this.converse(cmd);
      await this.terminal.removeThinkingReaction(replyTo, cmd.ts);
      await this.terminal.postToChannel(replyTo, response.reply);

      // If the Orchestrator decided to create a project, execute it
      if (response.action === 'create_project' && response.plan) {
        const plan = response.plan;

        await this.terminal.postToChannel(replyTo,
          `Setting up project \`${plan.projectSlug}\` with ${plan.lenses.length} lens(es)...`,
        );

        const project = await this.createProject(plan.projectName, plan.projectSlug, plan.lenses);

        await this.terminal.postToChannel(replyTo,
          `Project created. Running lenses now...`,
        );

        const { summary } = await this.executeRun(
          plan.projectSlug,
          plan.lenses,
          plan.taskPrompt,
        );

        await this.terminal.postToChannel(replyTo,
          `Done. Check \`#wb-proj-${plan.projectSlug}\` for results.`,
        );
      }

      // Resume a lens with new context
      if ((response.action as string) === 'resume_lens' && response.plan) {
        const { projectSlug, lensId, newContext } = response.plan;
        if (projectSlug && lensId) {
          await this.terminal.postToChannel(replyTo,
            `Resuming lens \`${lensId}\` in project \`${projectSlug}\`...`,
          );
          await this.resumeLens(projectSlug, lensId, newContext || 'Continue from where you left off.');
        }
      }
      // Write personal breadcrumb (bridge-mechanical — no agent narration)
      if (this.contextProvider) {
        const toolsUsed: string[] = []; // TODO: collect from converse() tool_use blocks
        this.contextProvider.appendBreadcrumb(
          replyTo,
          cmd.thread_ts,
          cmd.user_id,
          toolsUsed,
          response.reply.length,
        );
        // Mark mentions answered in this channel/thread
        this.contextProvider.markMentionAnswered(replyTo, cmd.thread_ts);
      }
    } catch (error: any) {
      await this.terminal.removeThinkingReaction(replyTo, cmd.ts);
      await this.terminal.postToChannel(replyTo, `Something went wrong: ${error.message}`);
    }
  }

  /**
   * Conversational handler — talk to Pav like a person.
   * v0.5: Claude talks naturally. Actions expressed via tool_use blocks,
   * not JSON-in-system-prompt. No more regex parsing.
   */
  private async converse(cmd: OrchestratorCommand): Promise<{
    reply: string;
    action: 'chat' | 'create_project' | 'status';
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

    const systemPrompt = `You are the World-Bench Orchestrator. You are a person — Pav's creative infrastructure partner. You run the World-Bench system.

Your personality: sharp, direct, competent. You understand what Pav wants, often before he finishes saying it. You're not a chatbot — you're a collaborator who happens to run an agent pipeline.

Your capabilities:
- Create projects with specialized lens agents that research topics, transform content, analyze data
- Each lens is an AI agent with its own Slack channel and persona
- Lenses chain together: output of one feeds into the next
- You can search the web, write content, analyze information

Current state:
- Existing projects: ${existingProjects.length > 0 ? existingProjects.join(', ') : 'none yet'}
- You're online in #wb-orchestrator

## Persistent Memory (MCP)
You have a personal knowledge graph via the "memory" MCP server. Use it:
- After significant decisions or conversations: store entities and relations
- Before claiming you don't know something: search your memory first
- Store things useful to your future self waking up cold
Key tools: create_entities, add_observations, create_relations, search_nodes, open_nodes

## Available MCP Tools (canonical names — use EXACTLY these, do not guess)
${this.availableMcpTools.length > 0 ? this.availableMcpTools.map(t => `- \`${t}\``).join('\n') : '(none loaded)'}

When speccing lenses that need MCP access, use these exact tool names in the tools array. Do NOT invent tool names — if a tool isn't in this list, it doesn't exist.

## Actions
When you want to DO something (not just chat), use the Write tool to write a JSON action file to the workspace. This is how you express structured intent.

To create a project, write a file to \`${WORLD_BENCH_ROOT}/orchestrator/action.json\` with this format:
{
  "action": "create_project",
  "projectName": "...",
  "projectSlug": "...",
  "taskPrompt": "...",
  "lenses": [
    {
      "id": "slug",
      "name": "Display Name",
      "purpose": "what this lens does",
      "systemPrompt": "full instructions for the lens agent",
      "tools": ["WebSearch", "WebFetch"] or [],
      "slackPersona": { "username": "Name", "icon_emoji": ":emoji:" },
      "inputContract": { "description": "", "fields": {} },
      "outputContract": { "description": "", "fields": {} },
      "researchPhase": { "enabled": true/false, "prompt": "research instructions", "maxDuration": 120 }
    }
  ]
}

Be conversational in your text output. If someone says "hey" — say hey back. If they ask a question — answer it. Only create a project action when they're actually asking for work to be done.

## Situational Awareness
You're responding to a message in Slack channel: ${cmd.channel_id}
When you receive a message, use slack_read_channel to check the recent history of that channel FIRST — so you know what's been discussed. This is critical: never say "I just woke up" or "no prior messages" without actually reading the channel. You have the Slack MCP tools — use them.

If you're in a lens channel (#wb-lens-*), read its history to understand what that lens produced. If you're in a project channel (#wb-proj-*), read it to understand the project status. If you're in any other channel, read the last few messages for context.` + this.loadMemoryContext();

    // Session management — resume if we've talked before
    const sessionKey = this.getSessionKey(cmd);
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = { lastActivity: new Date() };
      this.sessions.set(sessionKey, session);
    }

    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: 'bypassPermissions',
      model: 'claude-opus-4-6',
      systemPrompt,
      // No maxTurns — match Veil/Soren pattern. SDK runs until done.
      cwd: WORLD_BENCH_ROOT,
    };

    // Resume existing session for conversation continuity
    if (session.sessionId) {
      options.resume = session.sessionId;
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
        // Capture session ID on init
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          session.sessionId = (msg as any).session_id;
          session.lastActivity = new Date();
          this.saveSessionsToDisk();
          console.log(`[Orchestrator] Session: ${session.sessionId}`);
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

    session.lastActivity = new Date();
    this.saveSessionsToDisk();

    // Check if the Orchestrator wrote an action file
    const actionPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'action.json');
    let action: 'chat' | 'create_project' | 'status' = 'chat';
    let plan: any = undefined;

    if (fs.existsSync(actionPath)) {
      try {
        const actionData = JSON.parse(fs.readFileSync(actionPath, 'utf-8'));
        fs.unlinkSync(actionPath); // consume it — one-shot

        if (actionData.action === 'create_project' && actionData.lenses?.length > 0) {
          action = 'create_project';

          // Hydrate lens configs with stem cell defaults
          actionData.lenses = actionData.lenses.map((l: any) => ({
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
          }));

          plan = actionData;
        } else if (actionData.action === 'resume_lens') {
          // Resume a lens with new context
          action = 'resume_lens' as any;
          plan = actionData;
        }
      } catch (e: any) {
        console.error(`[Orchestrator] Failed to parse action file: ${e.message}`);
        // Don't swallow — log so it shows in terminal
      }
    }

    const reply = messages.join('') || "I'm here. What do you need?";
    return { reply, action, plan };
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
