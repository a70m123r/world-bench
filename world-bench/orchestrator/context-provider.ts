// World-Bench v0.4 — Context Provider
// Pre-fetches Slack messages and council docs, injects into every prompt.
// Same pattern as Veil/Soren's context-provider.ts.

import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const COUNCIL_DIR = path.resolve(WORLD_BENCH_ROOT, '..', 'council');
const BREADCRUMBS_PATH = path.join(COUNCIL_DIR, 'BREADCRUMBS.md');
const ROOM_STATE_PATH = path.join(COUNCIL_DIR, 'ROOM-ZERO-STATE.md');

// Hard limits — same depth as Veil/Soren
const ROOM_ZERO_MESSAGES = 150;
const CURRENT_CHANNEL_MESSAGES = 100;
const ORCHESTRATOR_CHANNEL_MESSAGES = 100;
const BREADCRUMBS_TAIL_CHARS = 20000;
const CONTEXT_TIMEOUT_MS = 10000;

// Known channels
const ROOM_ZERO_CHANNEL = 'C0ALN8Q6QRE';

interface SlackMessage {
  timestamp: string;
  username: string;
  text: string;
}

export class ContextProvider {
  private client: WebClient;
  private orchestratorChannelId: string | null = null;
  private userCache: Map<string, string> = new Map();

  constructor(client: WebClient) {
    this.client = client;
  }

  setOrchestratorChannel(channelId: string): void {
    this.orchestratorChannelId = channelId;
  }

  /**
   * Build full situational context for the Orchestrator.
   * Injected before every Claude call — no tool calls needed.
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
    } catch {
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

    // 1. Room Zero — 150 messages (skip if we're already there)
    if (!isRoomZero) {
      fetches.push(
        this.fetchHistory(ROOM_ZERO_CHANNEL, ROOM_ZERO_MESSAGES)
          .then(messages => ({ label: `Room Zero (#room-zero) — Last ${ROOM_ZERO_MESSAGES} messages`, messages }))
          .catch(() => null)
      );
    }

    // 2. Current channel/thread — 100 messages
    fetches.push(
      this.fetchConversation(currentChannel, currentThreadTs, CURRENT_CHANNEL_MESSAGES)
        .then(messages => ({ label: `Current Channel/Thread — Last ${CURRENT_CHANNEL_MESSAGES} messages`, messages }))
        .catch(() => null)
    );

    // 3. #wb-orchestrator — 100 messages (skip if we're already there)
    if (!isOrchestratorChannel && this.orchestratorChannelId) {
      fetches.push(
        this.fetchHistory(this.orchestratorChannelId, ORCHESTRATOR_CHANNEL_MESSAGES)
          .then(messages => ({ label: `#wb-orchestrator — Last ${ORCHESTRATOR_CHANNEL_MESSAGES} messages`, messages }))
          .catch(() => null)
      );
    }

    // Council breadcrumbs
    const breadcrumbs = this.readFileTail(BREADCRUMBS_PATH, BREADCRUMBS_TAIL_CHARS);
    if (breadcrumbs) {
      sections.push(`## Council Breadcrumbs (recent cross-thread activity):\n${breadcrumbs}`);
    }

    // Room Zero state
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

  private async fetchHistory(channel: string, limit: number): Promise<SlackMessage[]> {
    const response = await this.client.conversations.history({ channel, limit });
    if (!response.ok || !response.messages) return [];
    return this.resolveMessages(response.messages.reverse());
  }

  private async fetchConversation(
    channel: string, threadTs: string | undefined, limit: number,
  ): Promise<SlackMessage[]> {
    if (threadTs) {
      const response = await this.client.conversations.replies({
        channel, ts: threadTs, limit,
      });
      if (!response.ok || !response.messages) return [];
      return this.resolveMessages(response.messages.slice(-limit));
    }
    return this.fetchHistory(channel, limit);
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
