// World-Bench v0.6 — Context Provider (Situational Awareness v0.1)
// Four layers per council spec:
//   1. Personal breadcrumbs (per-agent, bridge-mechanical)
//   2. Padded local slice (±3 around trigger, cap 20)
//   3. Unified timeline (merged chronological, deduped from local slice)
//   4. Mention inbox (search-based, file-backed)
//
// Principle: raw messages for the local scene, summaries for the wider map.
// Shared sludge guardrail: personal layers are per-agent, never shared.

import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const COUNCIL_DIR = path.resolve(WORLD_BENCH_ROOT, '..', 'council');
const BREADCRUMBS_PATH = path.join(COUNCIL_DIR, 'BREADCRUMBS.md');

// Hard caps per section (not percentages — council consensus)
const LOCAL_SLICE_CAP = 20;
const UNIFIED_TIMELINE_CAP = 70;
const MENTIONS_CAP = 10;
const BREADCRUMBS_CAP = 50;       // lines
const COUNCIL_BREADCRUMBS_CHARS = 5000;
const PER_CHANNEL_FLOOR = 5;      // minimum messages per watched channel in timeline
const CONTEXT_TIMEOUT_MS = 10000;

const ROOM_ZERO_CHANNEL = 'C0ALN8Q6QRE';

interface SlackMessage {
  timestamp: string;
  rawTs: string;
  username: string;
  text: string;
  channel?: string;
  threadTs?: string;
}

interface ChannelCache {
  messages: SlackMessage[];
  lastFetchTs: string;
}

interface MentionEntry {
  message: SlackMessage;
  status: 'new' | 'seen' | 'answered' | 'stale';
  channel: string;
  threadTs?: string;
}

export class ContextProvider {
  private client: WebClient;
  private orchestratorChannelId: string | null = null;
  private botUserId: string | null = null;
  private userCache: Map<string, string> = new Map();
  private channelCaches: Map<string, ChannelCache> = new Map();
  private mentionInbox: MentionEntry[] = [];
  private mentionInboxPath: string;
  private breadcrumbsPath: string;

  constructor(client: WebClient) {
    this.client = client;
    this.mentionInboxPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'memory', 'orchestrator-mentions.json');
    this.breadcrumbsPath = path.join(WORLD_BENCH_ROOT, 'orchestrator', 'memory', 'orchestrator-breadcrumbs.md');
    this.loadMentionInbox();
  }

  setOrchestratorChannel(channelId: string): void {
    this.orchestratorChannelId = channelId;
  }

  setBotUserId(userId: string): void {
    this.botUserId = userId;
  }

  // ─── Main Entry Point ───

  async buildContext(
    currentChannel: string,
    currentThreadTs?: string,
    triggerTs?: string,
  ): Promise<string> {
    try {
      return await Promise.race([
        this.assemblePacket(currentChannel, currentThreadTs, triggerTs),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Context fetch timeout')), CONTEXT_TIMEOUT_MS)
        ),
      ]);
    } catch (e: any) {
      console.warn(`[ContextProvider] Context fetch failed: ${e.message}`);
      return '';
    }
  }

  // ─── Packet Assembly ───

  private async assemblePacket(
    currentChannel: string,
    currentThreadTs?: string,
    triggerTs?: string,
  ): Promise<string> {
    const sections: string[] = [];

    // 1. Padded local slice (highest priority — owns current channel/thread)
    const localSlice = await this.buildLocalSlice(currentChannel, currentThreadTs, triggerTs);
    if (localSlice.length > 0) {
      const formatted = localSlice.map(m => `[${m.timestamp}] @${m.username}: ${m.text}`).join('\n');
      sections.push(`## Local Context (current conversation):\n${formatted}`);
    }

    // 2. Unified timeline (all channels merged, excludes current channel)
    const timeline = await this.buildUnifiedTimeline(currentChannel);
    if (timeline.length > 0) {
      const formatted = timeline.map(m =>
        `[${m.timestamp}] #${m.channel || '?'} @${m.username}: ${m.text}`
      ).join('\n');
      sections.push(`## Recent Activity (across channels):\n${formatted}`);
    }

    // 3. Mention inbox
    await this.refreshMentionInbox();
    const unresolvedMentions = this.mentionInbox
      .filter(m => m.status === 'new' || m.status === 'seen')
      .slice(-MENTIONS_CAP);
    if (unresolvedMentions.length > 0) {
      const formatted = unresolvedMentions.map(m =>
        `[${m.message.timestamp}] #${m.channel} [${m.status}] @${m.message.username}: ${m.message.text}`
      ).join('\n');
      sections.push(`## Unresolved Mentions (${unresolvedMentions.length}):\n${formatted}`);
    }

    // 4. Personal breadcrumbs
    const breadcrumbs = this.readPersonalBreadcrumbs();
    if (breadcrumbs) {
      sections.push(`## My Recent Activity:\n${breadcrumbs}`);
    }

    // 5. Council breadcrumbs (shared — last 5000 chars)
    const councilBreadcrumbs = this.readFileTail(BREADCRUMBS_PATH, COUNCIL_BREADCRUMBS_CHARS);
    if (councilBreadcrumbs) {
      sections.push(`## Council Breadcrumbs:\n${councilBreadcrumbs}`);
    }

    if (sections.length === 0) return '';

    return (
      '--- SITUATIONAL CONTEXT (auto-injected, do not repeat verbatim) ---\n\n' +
      sections.join('\n\n') +
      '\n\n--- END CONTEXT ---\n\n'
    );
  }

  // ─── 1. Padded Local Slice ───

  private async buildLocalSlice(
    channel: string,
    threadTs?: string,
    triggerTs?: string,
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];

    if (threadTs) {
      // Thread reply: root + ±3 around trigger + latest reply + agent's last 3
      try {
        const thread = await this.client.conversations.replies({
          channel, ts: threadTs, limit: 100,
        });
        if (thread.ok && thread.messages) {
          const all = await this.resolveMessages(thread.messages, channel);

          // Thread root
          if (all.length > 0) messages.push(all[0]);

          // Find trigger position
          const triggerIdx = triggerTs
            ? all.findIndex(m => m.rawTs === triggerTs)
            : all.length - 1;

          if (triggerIdx > 0) {
            // ±3 around trigger
            const start = Math.max(1, triggerIdx - 3); // skip root (already added)
            const end = Math.min(all.length, triggerIdx + 4);
            for (let i = start; i < end; i++) {
              if (!messages.find(m => m.rawTs === all[i].rawTs)) {
                messages.push(all[i]);
              }
            }
          }

          // Latest reply (if not already included)
          const latest = all[all.length - 1];
          if (!messages.find(m => m.rawTs === latest.rawTs)) {
            messages.push(latest);
          }

          // Agent's last 3 in this thread
          if (this.botUserId) {
            const myMsgs = all.filter(m => m.username === 'Orchestrator' || m.rawTs === triggerTs);
            for (const m of myMsgs.slice(-3)) {
              if (!messages.find(x => x.rawTs === m.rawTs)) {
                messages.push(m);
              }
            }
          }
        }
      } catch { }

      // 1 channel message before thread root for context
      try {
        const before = await this.client.conversations.history({
          channel, latest: threadTs, limit: 2, inclusive: false,
        });
        if (before.ok && before.messages && before.messages.length > 0) {
          const resolved = await this.resolveMessages(before.messages.slice(0, 1), channel);
          messages.unshift(...resolved);
        }
      } catch { }

    } else {
      // Top-level channel message: ±3 around trigger + agent's last 3
      try {
        const history = await this.client.conversations.history({
          channel, limit: 20,
        });
        if (history.ok && history.messages) {
          const all = await this.resolveMessages(history.messages.reverse(), channel);

          const triggerIdx = triggerTs
            ? all.findIndex(m => m.rawTs === triggerTs)
            : all.length - 1;

          if (triggerIdx >= 0) {
            const start = Math.max(0, triggerIdx - 3);
            const end = Math.min(all.length, triggerIdx + 2);
            for (let i = start; i < end; i++) {
              messages.push(all[i]);
            }
          } else {
            // Trigger not found — take last 7
            messages.push(...all.slice(-7));
          }

          // Agent's last 3 in this channel (protect from budget squeeze — Veil's note)
          const myMsgs = all.filter(m => m.username === 'Orchestrator');
          for (const m of myMsgs.slice(-3)) {
            if (!messages.find(x => x.rawTs === m.rawTs)) {
              messages.push(m);
            }
          }
        }
      } catch { }
    }

    // Sort chronologically and cap
    messages.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));
    return messages.slice(-LOCAL_SLICE_CAP);
  }

  // ─── 2. Unified Timeline ───

  private async buildUnifiedTimeline(excludeChannel: string): Promise<SlackMessage[]> {
    // Watched channels (excluding the current one — local slice owns it)
    const channels = [ROOM_ZERO_CHANNEL];
    if (this.orchestratorChannelId && this.orchestratorChannelId !== excludeChannel) {
      channels.push(this.orchestratorChannelId);
    }
    // Remove duplicates and exclude current channel
    const watchedChannels = [...new Set(channels)].filter(c => c !== excludeChannel);

    const allMessages: SlackMessage[] = [];

    for (const channel of watchedChannels) {
      const msgs = await this.getChannelMessages(channel, Math.max(PER_CHANNEL_FLOOR, 30));
      // Tag each message with its channel name
      for (const m of msgs) {
        m.channel = channel === ROOM_ZERO_CHANNEL ? 'room-zero'
          : channel === this.orchestratorChannelId ? 'wb-orchestrator'
          : channel;
      }
      allMessages.push(...msgs);
    }

    // Sort chronologically, cap
    allMessages.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));

    // Ensure per-channel floor
    const result: SlackMessage[] = [];
    const perChannel = new Map<string, number>();

    // First pass: guarantee floor per channel
    for (const ch of watchedChannels) {
      const chName = ch === ROOM_ZERO_CHANNEL ? 'room-zero'
        : ch === this.orchestratorChannelId ? 'wb-orchestrator' : ch;
      const chMsgs = allMessages.filter(m => m.channel === chName).slice(-PER_CHANNEL_FLOOR);
      result.push(...chMsgs);
      perChannel.set(chName, chMsgs.length);
    }

    // Second pass: fill remaining slots chronologically
    const remaining = UNIFIED_TIMELINE_CAP - result.length;
    if (remaining > 0) {
      const alreadyAdded = new Set(result.map(m => m.rawTs));
      const extras = allMessages
        .filter(m => !alreadyAdded.has(m.rawTs))
        .slice(-remaining);
      result.push(...extras);
    }

    result.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));
    return result.slice(-UNIFIED_TIMELINE_CAP);
  }

  // ─── 3. Mention Inbox ───

  private async refreshMentionInbox(): Promise<void> {
    if (!this.botUserId) return;

    try {
      // Search for recent mentions
      const lastChecked = this.mentionInbox.length > 0
        ? this.mentionInbox[this.mentionInbox.length - 1].message.rawTs
        : '0';

      const result = await this.client.search.messages({
        query: `<@${this.botUserId}>`,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 20,
      });

      if (result.ok && result.messages?.matches) {
        for (const match of result.messages.matches.reverse()) {
          const ts = (match as any).ts;
          if (!ts || parseFloat(ts) <= parseFloat(lastChecked)) continue;
          // Skip if already in inbox
          if (this.mentionInbox.find(m => m.message.rawTs === ts)) continue;

          const username = await this.resolveUsername((match as any).user || '');
          const channel = (match as any).channel?.id || (match as any).channel?.name || '?';

          this.mentionInbox.push({
            message: {
              timestamp: new Date(parseFloat(ts) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
              rawTs: ts,
              username,
              text: ((match as any).text || '').replace(/\n/g, ' ').substring(0, 300),
            },
            status: 'new',
            channel,
            threadTs: (match as any).thread_ts,
          });
        }

        // Cap inbox
        if (this.mentionInbox.length > 100) {
          this.mentionInbox = this.mentionInbox.slice(-100);
        }

        // Mark stale (24h+)
        const staleThreshold = Date.now() / 1000 - 86400;
        for (const entry of this.mentionInbox) {
          if (entry.status === 'new' && parseFloat(entry.message.rawTs) < staleThreshold) {
            entry.status = 'stale';
          }
        }

        this.saveMentionInbox();
      }
    } catch (e: any) {
      console.warn(`[ContextProvider] Mention search failed: ${e.message}`);
    }
  }

  /**
   * Mark mentions as answered when the Orchestrator replies in that channel/thread.
   */
  markMentionAnswered(channel: string, threadTs?: string): void {
    for (const entry of this.mentionInbox) {
      if (entry.status === 'new' || entry.status === 'seen') {
        // Only mark answered if reply is in the same thread/channel (Claw's note)
        if (threadTs && entry.threadTs === threadTs) {
          entry.status = 'answered';
        } else if (!threadTs && entry.channel === channel && !entry.threadTs) {
          entry.status = 'answered';
        }
      }
    }
    this.saveMentionInbox();
  }

  private loadMentionInbox(): void {
    try {
      if (fs.existsSync(this.mentionInboxPath)) {
        this.mentionInbox = JSON.parse(fs.readFileSync(this.mentionInboxPath, 'utf-8'));
      }
    } catch { }
  }

  private saveMentionInbox(): void {
    try {
      fs.mkdirSync(path.dirname(this.mentionInboxPath), { recursive: true });
      fs.writeFileSync(this.mentionInboxPath, JSON.stringify(this.mentionInbox, null, 2));
    } catch (e: any) {
      console.error(`[ContextProvider] Failed to save mention inbox: ${e.message}`);
    }
  }

  // ─── 4. Personal Breadcrumbs ───

  /**
   * Append a breadcrumb entry. Called by the bridge after each response.
   * Bridge writes the mechanical skeleton — no agent narration needed.
   */
  appendBreadcrumb(
    channel: string,
    threadTs: string | undefined,
    triggerUser: string,
    toolsUsed: string[],
    responseLength: number,
  ): void {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const threadTag = threadTs ? ` (thread)` : '';
    const toolsTag = toolsUsed.length > 0 ? ` | tools: ${toolsUsed.join(', ')}` : '';
    const line = `[${ts}] #${channel}${threadTag} | from: ${triggerUser} | ${responseLength} chars${toolsTag}\n`;

    try {
      fs.mkdirSync(path.dirname(this.breadcrumbsPath), { recursive: true });
      fs.appendFileSync(this.breadcrumbsPath, line);

      // Rolling window — trim to last 100 lines
      const content = fs.readFileSync(this.breadcrumbsPath, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > 100) {
        fs.writeFileSync(this.breadcrumbsPath, lines.slice(-100).join('\n') + '\n');
      }
    } catch (e: any) {
      console.error(`[ContextProvider] Failed to write breadcrumb: ${e.message}`);
    }
  }

  private readPersonalBreadcrumbs(): string | null {
    try {
      if (!fs.existsSync(this.breadcrumbsPath)) return null;
      const content = fs.readFileSync(this.breadcrumbsPath, 'utf-8').trim();
      if (!content) return null;
      const lines = content.split('\n');
      return lines.slice(-BREADCRUMBS_CAP).join('\n');
    } catch {
      return null;
    }
  }

  // ─── Channel Cache (incremental fetch) ───

  private async getChannelMessages(channel: string, limit: number): Promise<SlackMessage[]> {
    const cache = this.channelCaches.get(channel);

    if (!cache) {
      const messages = await this.fetchHistory(channel, limit);
      this.channelCaches.set(channel, {
        messages,
        lastFetchTs: messages.length > 0 ? messages[messages.length - 1].rawTs : '0',
      });
      return messages;
    }

    // Incremental fetch
    try {
      const response = await this.client.conversations.history({
        channel,
        oldest: cache.lastFetchTs,
        limit: 50,
      });

      if (response.ok && response.messages && response.messages.length > 0) {
        const newRaw = response.messages.filter(m => m.ts !== cache.lastFetchTs);
        if (newRaw.length > 0) {
          const newMessages = await this.resolveMessages(newRaw.reverse(), channel);
          cache.messages.push(...newMessages);
          if (cache.messages.length > 200) {
            cache.messages = cache.messages.slice(-200);
          }
          cache.lastFetchTs = cache.messages[cache.messages.length - 1].rawTs;
        }
      }
    } catch (e: any) {
      console.warn(`[ContextProvider] Incremental fetch failed for ${channel}: ${e.message}`);
    }

    return cache.messages.slice(-limit);
  }

  // ─── Raw Fetchers ───

  private async fetchHistory(channel: string, limit: number): Promise<SlackMessage[]> {
    const response = await this.client.conversations.history({ channel, limit });
    if (!response.ok || !response.messages) return [];
    return this.resolveMessages(response.messages.reverse(), channel);
  }

  private async resolveMessages(
    messages: Array<{ user?: string; text?: string; ts?: string; bot_id?: string; username?: string; thread_ts?: string }>,
    channel?: string,
  ): Promise<SlackMessage[]> {
    const resolved: SlackMessage[] = [];

    for (const msg of messages) {
      if (!msg.ts || !msg.text) continue;

      let username = 'unknown';
      if (msg.user) {
        username = await this.resolveUsername(msg.user);
      } else if (msg.username) {
        username = msg.username;
      } else if (msg.bot_id) {
        username = 'bot';
      }

      const date = new Date(parseFloat(msg.ts) * 1000);
      const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      resolved.push({
        timestamp: timeStr,
        rawTs: msg.ts,
        username,
        text: msg.text.replace(/\n/g, ' ').substring(0, 500),
        channel,
        threadTs: msg.thread_ts,
      });
    }

    return resolved;
  }

  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const response = await this.client.users.info({ user: userId });
      const name =
        (response.user as any)?.profile?.display_name ||
        (response.user as any)?.real_name ||
        (response.user as any)?.name ||
        userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  private readFileTail(filePath: string, maxChars: number): string | null {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) return null;
      const start = Math.max(0, stat.size - maxChars);
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, maxChars));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);
      let content = buffer.toString('utf-8');
      if (start > 0) {
        const firstEntry = content.indexOf('\n## [');
        if (firstEntry >= 0) content = content.substring(firstEntry + 1);
      }
      return content.trim() || null;
    } catch {
      return null;
    }
  }
}
