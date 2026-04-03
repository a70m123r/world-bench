// World-Bench v0.4 — Terminal
// Listens to #orchestrator Slack channel, routes messages to the Orchestrator.
// Handles all Slack posting — including chat:write.customize for lens personas.

import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';
import { LensConfig, OrchestratorCommand, ProjectMeta } from '../agents/types';
import { createEvent, appendEvent } from './event-log';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const PAV_USER_ID = process.env.PAV_USER_ID || 'U0AL61DRV6D';

export class Terminal {
  private app: App;
  private client: WebClient;
  private orchestrator: any; // circular ref avoidance — typed at call site
  private orchestratorChannelId: string | null = null;
  private botUserId: string | null = null;

  constructor(orchestrator: any) {
    this.orchestrator = orchestrator;

    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });

    this.client = this.app.client;
  }

  async start(): Promise<void> {
    // Register app_mention handler — fires when ANY user or bot tags @Orchestrator
    this.app.event('app_mention', async ({ event }) => {
      const channelId = event.channel;
      const text = event.text || '';
      const userId = event.user || '';
      const ts = event.ts;

      // Strip the @mention
      const cleanText = this.botUserId
        ? text.replace(new RegExp(`<@${this.botUserId}(?:\\|[^>]*)?>`, 'g'), '').trim()
        : text.trim();

      if (!cleanText) return;

      console.log(`[Terminal] @mention from ${userId} in ${channelId}: ${cleanText}`);

      const cmd: OrchestratorCommand = {
        raw: cleanText,
        intent: cleanText,
        channel_id: channelId,
        thread_ts: (event as any).thread_ts,
        user_id: userId,
        ts,
      };

      try {
        await this.orchestrator.handleCommand(cmd);
      } catch (error: any) {
        console.error('[Terminal] Error handling @mention:', error);
        await this.postToChannel(channelId, `Something went wrong: ${error.message}`);
      }
    });

    // Register message handler — fires on regular messages (home channel + feedback)
    this.app.message(async ({ message }) => {
      const channelId = (message as any).channel;

      // Ignore bot messages (including our own)
      if ((message as any).bot_id || (message as any).subtype) return;

      const text = (message as any).text || '';
      const userId = (message as any).user || '';
      if (!text.trim()) return;

      // Home channel only — all messages handled.
      // @mentions in other channels are handled by app_mention event (no double-dispatch).
      const isHomeChannel = channelId === this.orchestratorChannelId;

      if (isHomeChannel) {
        // Skip messages that are just @mentions — app_mention handler has those
        const isJustMention = this.botUserId && text.includes(`<@${this.botUserId}>`);
        const cleanText = isJustMention
          ? text.replace(new RegExp(`<@${this.botUserId}(?:\\|[^>]*)?>`, 'g'), '').trim()
          : text;

        if (!cleanText) return;

        console.log(`[Terminal] Command from ${userId} in ${channelId}: ${cleanText}`);

        const cmd: OrchestratorCommand = {
          raw: cleanText,
          intent: cleanText,
          channel_id: channelId,
          thread_ts: (message as any).thread_ts,
          user_id: userId,
          ts: (message as any).ts,
        };

        try {
          await this.orchestrator.handleCommand(cmd);
        } catch (error: any) {
          console.error('[Terminal] Error handling command:', error);
          await this.postToChannel(channelId, `Something went wrong: ${error.message}`);
        }
        return;
      }

      // Route 3: Messages in #wb-proj-* channels → feedback capture
      const projectSlug = this.getProjectSlugForChannel(channelId);
      if (projectSlug) {
        console.log(`[Terminal] Feedback in proj-${projectSlug} from ${userId}: ${text.slice(0, 80)}`);
        this.captureFeedback(projectSlug, userId, text);
      }
    });

    // Start socket mode first
    await this.app.start();
    console.log('[Terminal] Slack app started (socket mode).');

    // Get bot user ID
    const auth = await this.client.auth.test();
    this.botUserId = auth.user_id as string;
    console.log(`[Terminal] Bot user: ${this.botUserId}`);

    // Find or create #wb-orchestrator channel
    this.orchestratorChannelId = await this.findOrCreateChannel('wb-orchestrator', 'World-Bench Orchestrator command surface');
    console.log(`[Terminal] Orchestrator channel: ${this.orchestratorChannelId}`);

    // Initialize context provider with Slack client
    if (this.orchestratorChannelId) {
      this.orchestrator.initContextProvider(this.client, this.orchestratorChannelId);
    }

    // Announce presence
    if (this.orchestratorChannelId) {
      await this.postToOrchestrator('World-Bench Orchestrator v0.4 online. Ready for commands.');
    }
  }

  // ─── Channel Management ───

  async findOrCreateChannel(name: string, purpose?: string): Promise<string | null> {
    try {
      // Search for existing channel
      const result = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
      });

      const existing = result.channels?.find(c => c.name === name);
      if (existing?.id) {
        // Join if not already a member (may fail if missing channels:join scope)
        if (!existing.is_member) {
          try { await this.client.conversations.join({ channel: existing.id }); } catch (e: any) {
            console.warn(`[Terminal] Could not join #${name}: ${e.data?.error || e.message}`);
          }
        }
        return existing.id;
      }

      // Create new channel
      return await this.createChannel(name, purpose);
    } catch (error: any) {
      console.error(`[Terminal] Channel lookup failed for ${name}:`, error.message);
      return null;
    }
  }

  async createChannel(name: string, purpose?: string): Promise<string | null> {
    try {
      const result = await this.client.conversations.create({
        name,
        is_private: false,
      });

      const channelId = result.channel?.id;
      if (!channelId) return null;

      if (purpose) {
        try {
          await this.client.conversations.setPurpose({ channel: channelId, purpose });
        } catch { /* non-critical */ }
      }

      // Auto-invite Pav to every channel the Orchestrator creates
      try {
        await this.client.conversations.invite({ channel: channelId, users: PAV_USER_ID });
      } catch (e: any) {
        if (e.data?.error !== 'already_in_channel') {
          console.warn(`[Terminal] Could not invite Pav to #${name}: ${e.data?.error || e.message}`);
        }
      }

      console.log(`[Terminal] Created channel #${name} (${channelId})`);
      return channelId;
    } catch (error: any) {
      if (error.data?.error === 'name_taken') {
        // Channel exists but we can't see it (archived or private).
        // Try to unarchive it, or fall back to a suffixed name.
        console.warn(`[Terminal] Channel #${name} exists but is not visible. Trying suffixed name.`);
        const suffixed = `${name}-${Date.now().toString(36).slice(-4)}`;
        return this.createChannel(suffixed, purpose);
      }
      console.error(`[Terminal] Failed to create channel #${name}:`, error.message);
      throw error;
    }
  }

  // ─── Posting ───

  async addThinkingReaction(channelId: string, ts: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: channelId,
        timestamp: ts,
        name: 'hourglass_flowing_sand',
      });
    } catch { }
  }

  async removeThinkingReaction(channelId: string, ts: string): Promise<void> {
    try {
      await this.client.reactions.remove({
        channel: channelId,
        timestamp: ts,
        name: 'hourglass_flowing_sand',
      });
    } catch { }
  }

  async postToChannel(channelId: string, text: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: false,
      });
    } catch (error: any) {
      console.error(`[Terminal] Failed to post to ${channelId}:`, error.message);
    }
  }

  async postToOrchestrator(text: string): Promise<void> {
    if (!this.orchestratorChannelId) return;
    try {
      await this.client.chat.postMessage({
        channel: this.orchestratorChannelId,
        text,
        unfurl_links: false,
      });
    } catch (error: any) {
      console.error('[Terminal] Failed to post to #orchestrator:', error.message);
    }
  }

  async postToProject(projectSlug: string, text: string): Promise<void> {
    const channelId = this.getProjectChannelId(projectSlug);
    if (!channelId) {
      console.error(`[Terminal] No channel found for project: ${projectSlug}`);
      return;
    }

    try {
      await this.client.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: false,
      });
    } catch (error: any) {
      console.error(`[Terminal] Failed to post to project channel:`, error.message);
    }
  }

  /**
   * Post as a lens persona using chat:write.customize.
   * Posts to the lens's own channel AND to the project channel.
   */
  /**
   * Post as a lens persona to the PROJECT channel only.
   * Used for human-readable summaries.
   */
  async postAsLens(lens: LensConfig, projectSlug: string, text: string): Promise<void> {
    const projectChannelId = this.getProjectChannelId(projectSlug);
    if (projectChannelId) {
      try {
        await this.client.chat.postMessage({
          channel: projectChannelId,
          text,
          username: lens.slackPersona.username,
          icon_emoji: lens.slackPersona.icon_emoji,
          unfurl_links: false,
        });
      } catch (error: any) {
        console.error(`[Terminal] Failed to post as lens to project:`, error.message);
      }
    }
  }

  /**
   * Post as a lens persona to the LENS channel only.
   * Used for full output / detailed logs.
   */
  async postToLensChannel(
    projectSlug: string, lensId: string, lens: LensConfig, text: string,
  ): Promise<void> {
    const lensChannelId = this.getLensChannelId(projectSlug, lensId);
    if (lensChannelId) {
      try {
        await this.client.chat.postMessage({
          channel: lensChannelId,
          text,
          username: lens.slackPersona.username,
          icon_emoji: lens.slackPersona.icon_emoji,
          unfurl_links: false,
        });
      } catch (error: any) {
        console.error(`[Terminal] Failed to post to lens channel:`, error.message);
      }
    }
  }

  // ─── Channel ID Lookups ───

  private getProjectChannelId(projectSlug: string): string | null {
    try {
      const projectJsonPath = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'project.json');
      if (!fs.existsSync(projectJsonPath)) return null;
      const meta: ProjectMeta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      return meta.project_channel_id || null;
    } catch {
      return null;
    }
  }

  private getLensChannelId(projectSlug: string, lensId: string): string | null {
    try {
      const lensJsonPath = path.join(
        WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
      );
      if (!fs.existsSync(lensJsonPath)) return null;
      const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
      return data.slack_channel_id || null;
    } catch {
      return null;
    }
  }

  // ─── Feedback Capture ───

  /**
   * Reverse-lookup: given a Slack channel ID, find which project it belongs to.
   */
  private getProjectSlugForChannel(channelId: string): string | null {
    try {
      const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
      if (!fs.existsSync(projectsDir)) return null;

      for (const slug of fs.readdirSync(projectsDir)) {
        const projectJsonPath = path.join(projectsDir, slug, 'project.json');
        if (!fs.existsSync(projectJsonPath)) continue;
        const meta: ProjectMeta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
        if (meta.project_channel_id === channelId) return slug;
      }
    } catch { }
    return null;
  }

  /**
   * Capture Pav's message in a project channel as a feedback WorkflowEvent.
   * Logged to the most recent run's events.jsonl.
   */
  private captureFeedback(projectSlug: string, userId: string, text: string): void {
    try {
      // Find the most recent run
      const runsDir = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'runs');
      if (!fs.existsSync(runsDir)) return;

      const runs = fs.readdirSync(runsDir).sort();
      if (runs.length === 0) return;

      const latestRunId = runs[runs.length - 1];
      const actor = userId === PAV_USER_ID ? 'pav' : `user:${userId}`;

      const event = createEvent(
        latestRunId, actor, 'message', text,
        { source: 'slack_feedback', channel_type: 'project' },
      );

      appendEvent(projectSlug, latestRunId, event);
      console.log(`[Terminal] Feedback captured for run ${latestRunId.slice(0, 8)}`);
    } catch (e: any) {
      console.warn(`[Terminal] Failed to capture feedback: ${e.message}`);
    }
  }
}
