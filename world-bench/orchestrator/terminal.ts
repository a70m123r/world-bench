// World-Bench v0.4 — Terminal
// Listens to #orchestrator Slack channel, routes messages to the Orchestrator.
// Handles all Slack posting — including chat:write.customize for lens personas.

import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';
import { LensConfig, OrchestratorCommand, ProjectMeta } from '../agents/types';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');

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
    // Register message handler before starting
    this.app.message(async ({ message }) => {
      // Only process messages in #orchestrator
      if ((message as any).channel !== this.orchestratorChannelId) return;

      // Ignore bot messages (including our own)
      if ((message as any).bot_id || (message as any).subtype) return;

      const text = (message as any).text || '';
      const userId = (message as any).user || '';

      // Skip if empty
      if (!text.trim()) return;

      console.log(`[Terminal] Received from ${userId}: ${text}`);

      const cmd: OrchestratorCommand = {
        raw: text,
        intent: text, // raw text — Orchestrator interprets
        channel_id: (message as any).channel,
        thread_ts: (message as any).thread_ts,
        user_id: userId,
        ts: (message as any).ts,
      };

      try {
        await this.orchestrator.handleCommand(cmd);
      } catch (error: any) {
        console.error('[Terminal] Error handling command:', error);
        await this.postToOrchestrator(`Error: ${error.message}`);
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
  async postAsLens(lens: LensConfig, projectSlug: string, text: string): Promise<void> {
    const postOpts = {
      text,
      username: lens.slackPersona.username,
      icon_emoji: lens.slackPersona.icon_emoji,
      unfurl_links: false,
    };

    // Post to project channel
    const projectChannelId = this.getProjectChannelId(projectSlug);
    if (projectChannelId) {
      try {
        await this.client.chat.postMessage({
          channel: projectChannelId,
          ...postOpts,
        });
      } catch (error: any) {
        console.error(`[Terminal] Failed to post as lens to project:`, error.message);
      }
    }

    // Post to lens-specific channel
    const lensChannelId = this.getLensChannelId(projectSlug, lens.id);
    if (lensChannelId) {
      try {
        await this.client.chat.postMessage({
          channel: lensChannelId,
          ...postOpts,
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
}
