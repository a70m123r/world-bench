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
      const threadTs = (event as any).thread_ts;

      // Strip the @mention
      const cleanText = this.botUserId
        ? text.replace(new RegExp(`<@${this.botUserId}(?:\\|[^>]*)?>`, 'g'), '').trim()
        : text.trim();

      if (!cleanText) return;

      console.log(`[Terminal] @mention from ${userId} in ${channelId}: ${cleanText} (thread=${threadTs || '(top)'})`);

      // v0.6.5.5: if the @mention is inside a bound lens thread, route it to
      // intervene/review mode via handleLensThreadOrchestratorMode, NOT through
      // handleCommand. Previous v0.6.5.x double-dispatched: app_mention ran
      // handleCommand (which posted an SDK response as a new top-level message)
      // while app.message ALSO fired intervene for the same tag. One user message
      // produced two Orchestrator actions. This fix gives app_mention exclusive
      // ownership of tagged messages (thread-bound or not) and makes app.message
      // skip tagged-in-thread cases.
      if (threadTs && this.botUserId) {
        const threadKey = `${channelId}:${threadTs}`;
        const threadBinding = this.orchestrator.threadToSession?.get?.(threadKey);
        if (threadBinding) {
          // Same review detection as app.message routing block
          const isReview = /^review\b/i.test(cleanText) && cleanText.length < 50;
          console.log(`[Terminal] ${isReview ? 'Review' : 'Intervene'} mode (via app_mention): ${userId} → ${threadBinding.lensId} in thread ${threadKey}`);
          try {
            await this.orchestrator.handleLensThreadOrchestratorMode({
              channelId,
              threadTs,
              binding: threadBinding,
              mode: isReview ? 'review' : 'intervene',
              message: cleanText,
              triggerTs: ts,
            });
          } catch (error: any) {
            console.error('[Terminal] app_mention thread-orchestrator-mode failed:', error);
            await this.postToChannel(channelId, `:warning: ${isReview ? 'Review' : 'Intervene'} failed: ${error.message}`, threadTs);
          }
          return;
        }
      }

      const cmd: OrchestratorCommand = {
        raw: cleanText,
        intent: cleanText,
        channel_id: channelId,
        thread_ts: threadTs,
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

      // v0.6.5.3: log every message that reaches the handler so we have evidence
      // when thread routing should have fired but didn't. This is the diagnostic
      // surface for the v0.6.5.x routing failures.
      const _threadTs = (message as any).thread_ts;
      console.log(`[Terminal] msg in=${channelId} thread=${_threadTs || '(top)'} user=${userId} text=${text.slice(0, 60).replace(/\n/g, ' ')}`);

      // v0.6.5.3: Thread-aware routing fires for ANY channel where a meet thread
      // is bound, NOT just the orchestrator's home channel. Previous v0.6.5.x code
      // gated this check on isHomeChannel, which silently broke routing because
      // the actual home channel (wb-orchestrator, an artifact of findOrCreateChannel)
      // is different from the channel Pav talks in (room-orchestrator). Lens meet
      // threads can live in any channel where the meet was initiated — the routing
      // must follow the threadToSession binding, not the channel identity.
      //
      // This is Soren's structural-not-behavioral rule: the routing is determined
      // by thread origin, not by which channel happens to be "home". The
      // Orchestrator doesn't get to decide whether to relay or absorb — the answer
      // is already determined by where the message came from.
      const threadTs = _threadTs;
      if (threadTs && this.botUserId) {
        const threadKey = `${channelId}:${threadTs}`;
        const threadBinding = this.orchestrator.threadToSession?.get?.(threadKey);
        if (threadBinding) {
          // G4: detect @Orchestrator mention via WIRE FORMAT (user ID), never display name
          const orcMentionPattern = `<@${this.botUserId}>`;
          const isOrcTagged = text.includes(orcMentionPattern);

          if (!isOrcTagged) {
            // RELAY MODE: untagged message in lens thread → forward verbatim to lens
            console.log(`[Terminal] Relay mode: ${userId} → ${threadBinding.lensId} in thread ${threadKey}`);
            try {
              await this.orchestrator.handleLensThreadRelay({
                channelId,
                threadTs,
                binding: threadBinding,
                speaker: userId === PAV_USER_ID ? 'pav' : 'orchestrator',
                message: text,
                triggerTs: (message as any).ts,
              });
            } catch (error: any) {
              console.error('[Terminal] Lens thread relay failed:', error);
              await this.postToChannel(channelId, `:warning: Relay to ${threadBinding.lensId} failed: ${error.message}`, threadTs);
            }
            return;
          }

          // v0.6.5.5: TAGGED in lens thread — defer to app_mention handler.
          // Previous v0.6.5.x code fired intervene/review mode here, but app_mention
          // ALSO fires for @mentions independently, producing double-dispatch:
          // one intervene relay + one SDK-turn top-level response for the same user
          // message. app_mention is now the exclusive owner of tagged messages
          // (including tagged-in-bound-thread cases) and handles the intervene/review
          // routing itself.
          console.log(`[Terminal] Tagged in bound thread ${threadKey}, deferring to app_mention (no double-dispatch)`);
          return;
        }
        // No binding for this thread — log it so we know
        console.log(`[Terminal] thread ${threadKey} has no binding, falling through`);
      }

      // Home channel only — all (non-thread-routed) messages handled.
      // @mentions in other channels are handled by app_mention event (no double-dispatch).
      const isHomeChannel = channelId === this.orchestratorChannelId;

      if (isHomeChannel) {
        // Normal home-channel handling (no lens thread routing matched)
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

      // v0.6.8: Route 3: Messages in #wb-lens-* channels → continue_meet with that lens.
      // The lens channel IS the meeting room. Any message from Pav (or Orchestrator)
      // in a lens channel triggers continue_meet with that lens's session. This is the
      // "lens-channel-as-meeting-room" pattern from the maturity lifecycle spec.
      const lensBinding = this.getLensForChannel(channelId);
      if (lensBinding) {
        const isOrcTagged = this.botUserId && text.includes(`<@${this.botUserId}>`);
        if (isOrcTagged) {
          // Tagged in lens channel — defer to app_mention (same as thread routing)
          console.log(`[Terminal] Tagged in lens channel ${channelId}, deferring to app_mention`);
          return;
        }

        console.log(`[Terminal] Lens channel relay: ${userId} → ${lensBinding.lensId} in ${channelId}`);
        try {
          await this.orchestrator.handleLensThreadRelay({
            channelId,
            threadTs: (message as any).thread_ts || (message as any).ts,
            binding: {
              projectSlug: lensBinding.projectSlug,
              lensId: lensBinding.lensId,
              sessionId: lensBinding.sessionId,
            },
            speaker: userId === PAV_USER_ID ? 'pav' : 'orchestrator',
            message: text,
            triggerTs: (message as any).ts,
          });
        } catch (error: any) {
          console.error('[Terminal] Lens channel relay failed:', error);
          await this.postToChannel(channelId, `:warning: Relay to ${lensBinding.lensId} failed: ${error.message}`);
        }
        return;
      }

      // Route 4: Messages in #wb-proj-* channels → feedback capture
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
      this.orchestrator.initContextProvider(this.client, this.orchestratorChannelId, this.botUserId!);
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

  async postToChannel(channelId: string, text: string, thread_ts?: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: false,
        ...(thread_ts ? { thread_ts } : {}),
      });
    } catch (error: any) {
      console.error(`[Terminal] Failed to post to ${channelId}:`, error.message);
    }
  }

  /**
   * v0.6.5: Post and return the resulting message metadata (ts, channel).
   * Used by meet_lens to capture the meet thread root ts so subsequent
   * continue_meet routing can find the lens session by thread.
   */
  async postToChannelWithTs(channelId: string, text: string): Promise<{ ts?: string; channel?: string } | null> {
    try {
      const res = await this.client.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: false,
      });
      return { ts: res.ts as string | undefined, channel: res.channel as string | undefined };
    } catch (error: any) {
      console.error(`[Terminal] postToChannelWithTs failed for ${channelId}:`, error.message);
      return null;
    }
  }

  /**
   * v0.6.4: Post to an arbitrary channel with a persona override (username + icon).
   * Used by meet_lens to post the stem cell's response as the lens persona before
   * the project channel exists. Different from postAsLens, which posts to the
   * project channel by slug — this targets a channelId directly so it works even
   * when the project hasn't been bootstrapped yet.
   *
   * v0.6.5.1: optional thread_ts so the response can be threaded as a reply
   * (used by meet_lens action handler so the harvester response and meeting
   * complete post are nested under the wave message — the message bound in
   * threadToSession — instead of being scattered top-level posts).
   */
  async postToChannelAs(
    channelId: string,
    persona: { username: string; icon_emoji: string },
    text: string,
    thread_ts?: string,
  ): Promise<void> {
    // v0.6.5.2: instrument so we can see when this gets called and detect any
    // duplicate calls. The Harvester double-post incident in v0.6.5.1 may have
    // been an @slack/web-api auto-retry — log so we have evidence next time.
    console.log(`[Terminal] postToChannelAs: persona=${persona.username} channel=${channelId} thread=${thread_ts || '(top-level)'} bytes=${text.length}`);
    try {
      const res = await this.client.chat.postMessage({
        channel: channelId,
        text,
        username: persona.username,
        icon_emoji: persona.icon_emoji,
        unfurl_links: false,
        ...(thread_ts ? { thread_ts } : {}),
      });
      console.log(`[Terminal] postToChannelAs ok: ts=${res.ts}`);
    } catch (error: any) {
      console.error(`[Terminal] Failed to post as ${persona.username} to ${channelId}:`, error.message);
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
   * v0.6.8: Reverse-lookup for lens channels. Given a Slack channel ID, find
   * which project + lens owns it. Returns the binding needed for continue_meet.
   * Scans all projects → all lenses → checks lens.json.slack_channel_id.
   */
  private getLensForChannel(channelId: string): { projectSlug: string; lensId: string; sessionId: string } | null {
    try {
      const projectsDir = path.join(WORLD_BENCH_ROOT, 'projects');
      if (!fs.existsSync(projectsDir)) return null;

      for (const slug of fs.readdirSync(projectsDir)) {
        const lensesDir = path.join(projectsDir, slug, 'lenses');
        if (!fs.existsSync(lensesDir)) continue;

        for (const lensId of fs.readdirSync(lensesDir)) {
          const lensJsonPath = path.join(lensesDir, lensId, 'lens.json');
          if (!fs.existsSync(lensJsonPath)) continue;

          try {
            const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
            if (data.slack_channel_id === channelId && data.sessionId) {
              return { projectSlug: slug, lensId, sessionId: data.sessionId };
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { }
    return null;
  }

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
