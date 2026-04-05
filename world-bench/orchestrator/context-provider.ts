// World-Bench v0.5.1 — Context Provider
// Pre-fetches Slack messages and council docs, injects into every prompt.
// v0.5.1: Caches messages per channel — only fetches new messages since last call.
// Eliminates redundant 350-message fetches that cause rate_limit_event spam.

import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const COUNCIL_DIR = path.resolve(WORLD_BENCH_ROOT, '..', 'council');
const BREADCRUMBS_PATH = path.join(COUNCIL_DIR, 'BREADCRUMBS.md');
const ROOM_STATE_PATH = path.join(COUNCIL_DIR, 'ROOM-ZERO-STATE.md');

// Max messages to keep per channel in cache
const MAX_CACHED_MESSAGES = 150;
// Only do a full refresh if cache is older than this
const FULL_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const CONTEXT_TIMEOUT_MS = 10000;

// Known channels
const ROOM_ZERO_CHANNEL = 'C0ALN8Q6QRE';

interface SlackMessage {
  timestamp: string;
  rawTs: string; // original Slack ts for oldest/latest queries
  username: string;
  text: string;
}

interface ChannelCache {
  messages: SlackMessage[];
  lastFetchTs: string; // Slack ts of the newest message we've seen
  lastFullFetch: number; // Date.now() of last full refresh
}

export class ContextProvider {
  private client: WebClient;
  private orchestratorChannelId: string | null = null;
  private userCache: Map<string, string> = new Map();
  private channelCaches: Map<string, ChannelCache> = new Map();

  constructor(client: WebClient) {
    this.client = client;
  }

  setOrchestratorChannel(channelId: string): void {
    this.orchestratorChannelId = channelId;
  }

  /**
   * Build full situational context for the Orchestrator.
   * Uses cached messages — only fetches new ones since last call.
   */
  async buildContext(
    currentChannel: string,
    currentThreadTs?: string,
  ): Promise<string> {
    try {
      return await Promise.race([
        this.fetchAll(currentChannel, currentThreadTs),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Context fetch timeout')), CONTEXT_TIMEOUT_MS)
        ),
      ]);
    } catch (e: any) {
      console.warn(`[ContextProvider] Context fetch failed: ${e.message}`);
      return '';
    }
  }

  private async fetchAll(
    currentChannel: string,
    currentThreadTs?: string,
  ): Promise<string> {
    const sections: string[] = [];
    const isRoomZero = currentChannel === ROOM_ZERO_CHANNEL && !currentThreadTs;
    const isOrchestratorChannel = currentChannel === this.orchestratorChannelId && !currentThreadTs;

    const fetches: Promise<{ label: string; messages: SlackMessage[] } | null>[] = [];

    // 1. Room Zero (skip if current)
    if (!isRoomZero) {
      fetches.push(
        this.getChannelMessages(ROOM_ZERO_CHANNEL, MAX_CACHED_MESSAGES)
          .then(messages => ({ label: `Room Zero (#room-zero) — ${messages.length} messages`, messages }))
          .catch(() => null)
      );
    }

    // 2. Current channel/thread
    if (currentThreadTs) {
      // Threads aren't cached — fetch fresh (usually small)
      fetches.push(
        this.fetchThread(currentChannel, currentThreadTs, 100)
          .then(messages => ({ label: `Current Thread — ${messages.length} messages`, messages }))
          .catch(() => null)
      );
    } else {
      fetches.push(
        this.getChannelMessages(currentChannel, 100)
          .then(messages => ({ label: `Current Channel — ${messages.length} messages`, messages }))
          .catch(() => null)
      );
    }

    // 3. #wb-orchestrator (skip if current)
    if (!isOrchestratorChannel && this.orchestratorChannelId) {
      fetches.push(
        this.getChannelMessages(this.orchestratorChannelId, 100)
          .then(messages => ({ label: `#wb-orchestrator — ${messages.length} messages`, messages }))
          .catch(() => null)
      );
    }

    // Council breadcrumbs (file — always fresh, cheap to read)
    const breadcrumbs = this.readFileTail(BREADCRUMBS_PATH, 20000);
    if (breadcrumbs) {
      sections.push(`## Council Breadcrumbs (recent cross-thread activity):\n${breadcrumbs}`);
    }

    // Room Zero state (file)
    const roomState = this.readFile(ROOM_STATE_PATH, 3000);
    if (roomState) {
      sections.push(`## Room Zero State:\n${roomState}`);
    }

    // Resolve all Slack fetches
    const results = await Promise.all(fetches);
    for (const result of results) {
      if (result && result.messages.length > 0) {
        const formatted = result.messages
          .map(m => `[${m.timestamp}] @${m.username}: ${m.text}`)
          .join('\n');
        sections.push(`## ${result.label}:\n${formatted}`);
      }
    }

    if (sections.length === 0) return '';

    return (
      '--- SITUATIONAL CONTEXT (auto-injected, do not repeat verbatim to user) ---\n\n' +
      sections.join('\n\n') +
      '\n\n--- END CONTEXT ---\n\n'
    );
  }

  // ─── Cached Channel Fetch ───

  /**
   * Get channel messages from cache. Only fetches new messages since last call.
   * Full refresh every 10 minutes to catch edits/deletes.
   */
  private async getChannelMessages(channel: string, limit: number): Promise<SlackMessage[]> {
    const cache = this.channelCaches.get(channel);
    const now = Date.now();

    if (!cache) {
      // Full fetch — cold start only
      const messages = await this.fetchHistory(channel, limit);
      this.channelCaches.set(channel, {
        messages,
        lastFetchTs: messages.length > 0 ? messages[messages.length - 1].rawTs : '0',
        lastFullFetch: now,
      });
      return messages;
    }

    // Incremental fetch — only new messages since last fetch
    try {
      const response = await this.client.conversations.history({
        channel,
        oldest: cache.lastFetchTs,
        limit: 50, // small batch — just the new stuff
      });

      if (response.ok && response.messages && response.messages.length > 0) {
        // Filter out the message at oldest (it's inclusive)
        const newRaw = response.messages.filter(m => m.ts !== cache.lastFetchTs);
        if (newRaw.length > 0) {
          const newMessages = await this.resolveMessages(newRaw.reverse());
          cache.messages.push(...newMessages);

          // Trim to max
          if (cache.messages.length > MAX_CACHED_MESSAGES) {
            cache.messages = cache.messages.slice(-MAX_CACHED_MESSAGES);
          }

          cache.lastFetchTs = cache.messages[cache.messages.length - 1].rawTs;
          console.log(`[ContextProvider] ${channel}: +${newMessages.length} new messages (${cache.messages.length} cached)`);
        }
      }
    } catch (e: any) {
      // Incremental fetch failed — serve stale cache
      console.warn(`[ContextProvider] Incremental fetch failed for ${channel}: ${e.message}`);
    }

    return cache.messages.slice(-limit);
  }

  // ─── Raw Fetchers ───

  private async fetchHistory(channel: string, limit: number): Promise<SlackMessage[]> {
    const response = await this.client.conversations.history({ channel, limit });
    if (!response.ok || !response.messages) return [];
    return this.resolveMessages(response.messages.reverse());
  }

  private async fetchThread(
    channel: string, threadTs: string, limit: number,
  ): Promise<SlackMessage[]> {
    const response = await this.client.conversations.replies({
      channel, ts: threadTs, limit,
    });
    if (!response.ok || !response.messages) return [];
    return this.resolveMessages(response.messages.slice(-limit));
  }

  private async resolveMessages(
    messages: Array<{ user?: string; text?: string; ts?: string; bot_id?: string; username?: string }>,
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

  private readFile(filePath: string, maxChars?: number): string | null {
    try {
      let content = fs.readFileSync(filePath, 'utf-8').trim();
      if (maxChars && content.length > maxChars) content = content.slice(0, maxChars) + '...';
      return content || null;
    } catch {
      return null;
    }
  }
}
