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
} from '../agents/types';
import { ClaudeAgentAdapter } from './agent-adapter';
import { LensManager, LensRunResult } from './lens-manager';
import { Terminal } from './terminal';

// Load env from orchestrator config dir
dotenv.config({ path: path.join(__dirname, 'config', '.env'), override: true });

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');

export class Orchestrator {
  private adapter: ClaudeAgentAdapter;
  private lensManager: LensManager;
  private terminal: Terminal;

  constructor() {
    this.adapter = new ClaudeAgentAdapter();
    this.lensManager = new LensManager(this.adapter, WORLD_BENCH_ROOT);
    this.terminal = new Terminal(this);
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

      // Post per-lens summary to project channel
      const status = result.productionResult?.status || 'unknown';
      const outputPreview = (result.productionResult?.output || '').slice(0, 500);

      await this.terminal.postAsLens(
        lens,
        projectSlug,
        `**${lens.name}** finished: \`${status}\`\n\n${outputPreview}${outputPreview.length >= 500 ? '...' : ''}`,
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

      if (status === 'completed' && r.productionResult?.output) {
        const preview = r.productionResult.output.slice(0, 300);
        lines.push(`> ${preview}${preview.length >= 300 ? '...' : ''}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Command Handling (called by Terminal) ───

  async handleCommand(cmd: OrchestratorCommand): Promise<void> {
    // For now: use Claude to interpret intent and generate lens configs.
    // This is where the NLP layer lives — the Orchestrator uses its own
    // Claude instance to parse Pav's natural language into structured actions.

    const intent = cmd.intent.toLowerCase();

    if (intent.includes('headline') && intent.includes('joke')) {
      // First loop test case
      await this.runFirstLoop(cmd);
    } else {
      // Generic: acknowledge and explain what we can do
      await this.terminal.postToOrchestrator(
        `Received: "${cmd.raw}"\n\nI can interpret this and create lenses. For now, try the first loop test: "get trending headlines and make jokes"`,
      );
    }
  }

  // ─── First Loop Test ───

  private async runFirstLoop(cmd: OrchestratorCommand): Promise<void> {
    await this.terminal.postToOrchestrator(
      'Genesis: Creating project `headline-jokes` with two lenses...',
    );

    const headlineLens: LensConfig = {
      id: 'headline-reader',
      name: 'Headline Reader',
      purpose: 'Find trending headlines from current news',
      systemPrompt: 'You are a news research specialist. Find the most interesting, trending, and joke-worthy headlines from today\'s news. Focus on headlines that have comedic potential — irony, absurdity, unexpected juxtaposition.',
      tools: ['WebSearch', 'WebFetch'],
      state: 'active',
      slackPersona: {
        username: 'Headline Reader',
        icon_emoji: ':newspaper:',
      },
      inputContract: {
        description: 'No input required — searches the web independently',
        fields: {},
      },
      outputContract: {
        description: 'A list of trending headlines with brief context',
        fields: {
          headlines: 'Array of headline objects with title, source, and why it\'s funny',
        },
      },
      researchPhase: {
        enabled: true,
        prompt: 'Search for today\'s trending news headlines. Focus on stories with comedic potential.',
        maxDuration: 120,
      },
    };

    const jokeLens: LensConfig = {
      id: 'joke-writer',
      name: 'Joke Writer',
      purpose: 'Write jokes based on trending headlines',
      systemPrompt: 'You are a comedy writer. Your job is to take trending headlines and write sharp, original jokes about them. Think late-night monologue style — punchy, topical, clever. Aim for variety: one-liners, callbacks, absurdist takes.',
      tools: [],
      state: 'active',
      slackPersona: {
        username: 'Joke Writer',
        icon_emoji: ':laughing:',
      },
      inputContract: {
        description: 'Trending headlines with context from Headline Reader',
        fields: {
          headlines: 'Array of headlines with comedic context',
        },
      },
      outputContract: {
        description: 'A set of jokes, each tied to a specific headline',
        fields: {
          jokes: 'Array of joke objects with headline reference and joke text',
        },
      },
      researchPhase: {
        enabled: true,
        prompt: 'Research current comedy landscape — what topics are trending in comedy, what angles are fresh vs. played out.',
        maxDuration: 60,
      },
    };

    try {
      // Genesis: create project + channels
      const project = await this.createProject(
        'Headline Jokes',
        'headline-jokes',
        [headlineLens, jokeLens],
      );

      await this.terminal.postToOrchestrator(
        `Project created: \`headline-jokes\`\nChannels: \`#proj-headline-jokes\`, \`#lens-headline-reader\`, \`#lens-joke-writer\``,
      );

      // Execute the run: headline reader → joke writer (sequential, chained)
      const { summary } = await this.executeRun(
        'headline-jokes',
        [headlineLens, jokeLens],
        'Find trending headlines and write jokes about them',
      );

      await this.terminal.postToOrchestrator(
        `First loop complete. Check \`#proj-headline-jokes\` for results.`,
      );
    } catch (error: any) {
      await this.terminal.postToOrchestrator(
        `First loop failed: ${error.message}`,
      );
    }
  }
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
