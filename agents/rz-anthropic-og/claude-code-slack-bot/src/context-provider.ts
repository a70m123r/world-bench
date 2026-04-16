// Soren OG Bridge — Context Provider (Situational Awareness v0.1)
// Four layers per council spec:
//   1. Personal breadcrumbs (bridge-mechanical, per-agent)
//   2. Padded local slice (±3 around trigger, cap 20)
//   3. Unified timeline (merged chronological, deduped from local slice)
//   4. Mention inbox (search-based, file-backed)
//
// Principle: raw messages for the local scene, summaries for the wider map.
// Shared sludge guardrail: personal layers are per-agent.

import { App } from '@slack/bolt';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

const ROOM_ZERO_CHANNEL = 'C0ALN8Q6QRE';
const PAV_DM_CHANNEL = 'D0AKBPMJHFH';
const ROOM_ORCHESTRATOR_CHANNEL = 'C0AQ6CZR0HM';
const KITCHEN_CHANNEL = 'C0AM4JHCS58';
const CONTEXT_FETCH_TIMEOUT_MS = 10000;

// Hard caps per section (council consensus)
const LOCAL_SLICE_CAP = 20;
const UNIFIED_TIMELINE_CAP = 70;
const MENTIONS_CAP = 10;
const BREADCRUMBS_CAP = 50;
const COUNCIL_BREADCRUMBS_CHARS = 5000;
const PER_CHANNEL_FLOOR = 5;

// Council files
const COUNCIL_DIR = path.resolve(__dirname, '..', '..', 'council');
const BREADCRUMBS_PATH = path.join(COUNCIL_DIR, 'BREADCRUMBS.md');

// Soren's memory
const MEMORY_DIR = path.resolve(__dirname, '..', '..', 'memory');
const BREADCRUMBS_FILE = path.join(MEMORY_DIR, 'soren-breadcrumbs.md');
const MENTIONS_FILE = path.join(MEMORY_DIR, 'soren-mentions.json');

interface ChannelMessage {
  timestamp: string;
  rawTs: string;
  username: string;
  text: string;
  channel?: string;
  threadTs?: string;
}

interface ChannelCache {
  messages: ChannelMessage[];
  lastFetchTs: string;
}

interface MentionEntry {
  message: ChannelMessage;
  status: 'new' | 'seen' | 'answered' | 'stale';
  channel: string;
  threadTs?: string;
}

export class ContextProvider {
  private app: App;
  private logger = new Logger('ContextProvider');
  private userCache: Map<string, string> = new Map();
  private channelCaches: Map<string, ChannelCache> = new Map();
  private mentionInbox: MentionEntry[] = [];
  private botUserId: string | null = null;
  // Auto-growing watched channels — starts with known channels,
  // grows when agent gets tagged in new ones (Soren's spec note)
  private watchedChannels: Set<string> = new Set([
    ROOM_ZERO_CHANNEL,
    PAV_DM_CHANNEL,
    ROOM_ORCHESTRATOR_CHANNEL,
    KITCHEN_CHANNEL,
  ]);

  constructor(app: App) {
    this.app = app;
    this.loadMentionInbox();
  }

  setBotUserId(userId: string): void {
    this.botUserId = userId;
  }

  /**
   * Auto-track a channel when the agent is tagged there.
   * Grows the watched channels list so the unified timeline includes it.
   */
  trackChannel(channelId: string): void {
    if (!this.watchedChannels.has(channelId)) {
      this.watchedChannels.add(channelId);
      this.logger.info(`Now watching channel: ${channelId}`);
    }
  }

  // ─── Main Entry Point (same interface as before) ───

  async buildContextPreamble(
    currentChannel: string,
    currentThreadTs?: string,
    triggerTs?: string,
  ): Promise<string> {
    try {
      return await Promise.race([
        this.assemblePacket(currentChannel, currentThreadTs, triggerTs),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Context fetch timeout')), CONTEXT_FETCH_TIMEOUT_MS)
        ),
      ]);
    } catch (error) {
      this.logger.warn('Context fetch failed or timed out', error);
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

    // 2. Unified timeline (all watched channels, excludes current)
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

    // 5. Council breadcrumbs (shared)
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
  ): Promise<ChannelMessage[]> {
    const messages: ChannelMessage[] = [];

    if (threadTs) {
      try {
        const thread = await this.app.client.conversations.replies({
          channel, ts: threadTs, limit: 100,
        });
        if (thread.ok && thread.messages) {
          const all = await this.resolveMessages(thread.messages, channel);

          if (all.length > 0) messages.push(all[0]); // root

          const triggerIdx = triggerTs
            ? all.findIndex(m => m.rawTs === triggerTs)
            : all.length - 1;

          if (triggerIdx > 0) {
            const start = Math.max(1, triggerIdx - 3);
            const end = Math.min(all.length, triggerIdx + 4);
            for (let i = start; i < end; i++) {
              if (!messages.find(m => m.rawTs === all[i].rawTs)) {
                messages.push(all[i]);
              }
            }
          }

          const latest = all[all.length - 1];
          if (!messages.find(m => m.rawTs === latest.rawTs)) {
            messages.push(latest);
          }
        }
      } catch { }

      // 1 channel message before thread root
      try {
        const before = await this.app.client.conversations.history({
          channel, latest: threadTs, limit: 2, inclusive: false,
        });
        if (before.ok && before.messages && before.messages.length > 0) {
          const resolved = await this.resolveMessages(before.messages.slice(0, 1), channel);
          messages.unshift(...resolved);
        }
      } catch { }

    } else {
      try {
        const history = await this.app.client.conversations.history({
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
            messages.push(...all.slice(-7));
          }
        }
      } catch { }
    }

    messages.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));
    return messages.slice(-LOCAL_SLICE_CAP);
  }

  // ─── 2. Unified Timeline ───

  private async buildUnifiedTimeline(excludeChannel: string): Promise<ChannelMessage[]> {
    const channels = [...this.watchedChannels]
      .filter(c => c !== excludeChannel);

    const allMessages: ChannelMessage[] = [];

    for (const channel of channels) {
      const msgs = await this.getChannelMessages(channel, Math.max(PER_CHANNEL_FLOOR, 30));
      const chName = channel === ROOM_ZERO_CHANNEL ? 'room-zero'
        : channel === PAV_DM_CHANNEL ? 'pav-dm'
        : channel === ROOM_ORCHESTRATOR_CHANNEL ? 'room-orchestrator'
        : channel === KITCHEN_CHANNEL ? 'kitchen'
        : channel;
      for (const m of msgs) { m.channel = chName; }
      allMessages.push(...msgs);
    }

    allMessages.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));

    // Per-channel floor
    const result: ChannelMessage[] = [];
    for (const ch of channels) {
      const chName = ch === ROOM_ZERO_CHANNEL ? 'room-zero'
        : ch === PAV_DM_CHANNEL ? 'pav-dm' : ch;
      const chMsgs = allMessages.filter(m => m.channel === chName).slice(-PER_CHANNEL_FLOOR);
      result.push(...chMsgs);
    }

    const remaining = UNIFIED_TIMELINE_CAP - result.length;
    if (remaining > 0) {
      const alreadyAdded = new Set(result.map(m => m.rawTs));
      const extras = allMessages.filter(m => !alreadyAdded.has(m.rawTs)).slice(-remaining);
      result.push(...extras);
    }

    result.sort((a, b) => parseFloat(a.rawTs) - parseFloat(b.rawTs));
    return result.slice(-UNIFIED_TIMELINE_CAP);
  }

  // ─── 3. Mention Inbox ───

  private async refreshMentionInbox(): Promise<void> {
    if (!this.botUserId) return;

    // search.messages requires a user token (xoxp-), not bot token (xoxb-).
    // Bot tokens get auth errors. Instead, scan cached channel messages
    // for @mentions of this agent.
    try {
      const mentionPattern = `<@${this.botUserId}>`;
      const lastChecked = this.mentionInbox.length > 0
        ? this.mentionInbox[this.mentionInbox.length - 1].message.rawTs
        : '0';

      for (const [, cache] of this.channelCaches) {
        for (const msg of cache.messages) {
          if (parseFloat(msg.rawTs) <= parseFloat(lastChecked)) continue;
          if (!msg.text.includes(mentionPattern)) continue;
          if (this.mentionInbox.find(m => m.message.rawTs === msg.rawTs)) continue;

          this.mentionInbox.push({
            message: msg,
            status: 'new',
            channel: msg.channel || '?',
            threadTs: msg.threadTs,
          });
        }
      }

      // Cap and expire
      if (this.mentionInbox.length > 100) {
        this.mentionInbox = this.mentionInbox.slice(-100);
      }

      const staleThreshold = Date.now() / 1000 - 86400;
      for (const entry of this.mentionInbox) {
        if (entry.status === 'new' && parseFloat(entry.message.rawTs) < staleThreshold) {
          entry.status = 'stale';
        }
      }

      this.saveMentionInbox();
    } catch (e: any) {
      this.logger.warn('Mention scan failed', { error: e.message });
    }
  }

  markMentionAnswered(channel: string, threadTs?: string): void {
    for (const entry of this.mentionInbox) {
      if (entry.status === 'new' || entry.status === 'seen') {
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
      if (fs.existsSync(MENTIONS_FILE)) {
        this.mentionInbox = JSON.parse(fs.readFileSync(MENTIONS_FILE, 'utf-8'));
      }
    } catch { }
  }

  private saveMentionInbox(): void {
    try {
      fs.mkdirSync(path.dirname(MENTIONS_FILE), { recursive: true });
      fs.writeFileSync(MENTIONS_FILE, JSON.stringify(this.mentionInbox, null, 2));
    } catch (e: any) {
      this.logger.warn('Failed to save mention inbox', { error: e.message });
    }
  }

  // ─── 4. Personal Breadcrumbs ───

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
      fs.mkdirSync(path.dirname(BREADCRUMBS_FILE), { recursive: true });
      fs.appendFileSync(BREADCRUMBS_FILE, line);

      const content = fs.readFileSync(BREADCRUMBS_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > 100) {
        fs.writeFileSync(BREADCRUMBS_FILE, lines.slice(-100).join('\n') + '\n');
      }
    } catch (e: any) {
      this.logger.warn('Failed to write breadcrumb', { error: e.message });
    }
  }

  private readPersonalBreadcrumbs(): string | null {
    try {
      if (!fs.existsSync(BREADCRUMBS_FILE)) return null;
      const content = fs.readFileSync(BREADCRUMBS_FILE, 'utf-8').trim();
      if (!content) return null;
      return content.split('\n').slice(-BREADCRUMBS_CAP).join('\n');
    } catch {
      return null;
    }
  }

  // ─── Channel Cache ───

  private async getChannelMessages(channel: string, limit: number): Promise<ChannelMessage[]> {
    const cache = this.channelCaches.get(channel);

    if (!cache) {
      const messages = await this.fetchHistory(channel, limit);
      this.channelCaches.set(channel, {
        messages,
        lastFetchTs: messages.length > 0 ? messages[messages.length - 1].rawTs : '0',
      });
      return messages;
    }

    try {
      const response = await this.app.client.conversations.history({
        channel, oldest: cache.lastFetchTs, limit: 50,
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
      this.logger.warn(`Incremental fetch failed for ${channel}`, { error: e.message });
    }

    return cache.messages.slice(-limit);
  }

  // ─── Raw Fetchers ───

  private async fetchHistory(channel: string, limit: number): Promise<ChannelMessage[]> {
    const response = await this.app.client.conversations.history({ channel, limit });
    if (!response.ok || !response.messages) return [];
    return this.resolveMessages(response.messages.reverse(), channel);
  }

  private async resolveMessages(
    messages: Array<{ user?: string; text?: string; ts?: string; bot_id?: string; username?: string; thread_ts?: string }>,
    channel?: string,
  ): Promise<ChannelMessage[]> {
    const resolved: ChannelMessage[] = [];

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
      const response = await this.app.client.users.info({ user: userId });
      const displayName =
        (response.user as any)?.profile?.display_name ||
        (response.user as any)?.real_name ||
        (response.user as any)?.name ||
        userId;
      this.userCache.set(userId, displayName);
      return displayName;
    } catch (error) {
      this.logger.warn('Failed to resolve username', { userId, error });
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
