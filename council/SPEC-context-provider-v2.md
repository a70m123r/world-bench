# Context Provider v2 — Platform-Agnostic, Configurable, Thread-Aware, Swappable

## Context

The v0.1 context provider is missing thread replies in the unified timeline. `conversations.history()` only returns top-level messages — thread replies are invisible unless you're currently in that thread. Pav's direction: 50 messages total, smart padding (±2 around mentions + first/last), configurable so agents can tune it, traceable, and a path to auto-summary/archiving. Must be platform-agnostic — Slack is one source layer, not the architecture.

## Alignment with World-Bench Architecture

World-Bench already follows a platform-agnostic core + platform-specific adapters pattern:

| Layer | Platform-agnostic | Platform-specific |
|-------|------------------|-------------------|
| **Lens system** | `types.ts`, `base-lens-agent.ts`, `lens-manager.ts` | — |
| **Agent execution** | `AgentAdapter` interface | `ClaudeAgentAdapter` (Claude SDK) |
| **Slack surface** | `index.ts` (brain) | `terminal.ts` (Slack Socket Mode) |
| **MCP tools** | — | `mcp-servers/slack-mcp-server/` |
| **Context (v0.1)** | ❌ Coupled to Slack | Everything in one file |
| **Context (v2)** | `Message`, `MessageStore`, `ContextAssembler` | `SlackAdapter` |

v2 aligns the context system with the existing pattern. The `SourceAdapter` interface plays the same role as `AgentAdapter` — platform boundary. When Slack hits its limits and World-Bench gets a custom UI (spec: "when Slack hits its limits"), the context system just needs a new adapter. The assembler, store, config, and message types stay the same.

## Problem

1. **Thread replies invisible** — unified timeline shows top-level only
2. **Hardcoded everything** — caps, channels, padding are constants, not config
3. **Not swappable** — can't try different strategies without rewriting
4. **No subject tagging** — messages are flat text, not grouped by topic/thread
5. **No summary/archive path** — raw messages only, no compression for old content
6. **Coupled to Slack** — message types, channel IDs, API calls all Slack-specific. No path to other platforms or custom UI.

## Design

### Architecture: Three Layers

```
┌─────────────────────────────────┐
│     Context Assembler           │  Platform-agnostic. Builds ContextPacket
│     (configurable, swappable)   │  from normalized messages.
├─────────────────────────────────┤
│     Message Store               │  Platform-agnostic. Caches normalized
│     (cached, queryable)         │  messages. Handles incremental updates.
├─────────────────────────────────┤
│     Source Adapters             │  Platform-specific. Slack adapter,
│     (Slack, future: UI, etc.)   │  future Discord/custom UI adapters.
└─────────────────────────────────┘
```

**Source Adapters** convert platform-specific messages into a normalized `Message` type. Slack is the first adapter. Discord, custom UI, email would be future adapters.

**Message Store** holds normalized messages in memory + on disk. Handles caching, incremental fetch, deduplication. Platform-agnostic — it only sees `Message` objects.

**Context Assembler** reads from the store and builds a `ContextPacket` per Pav's rules (50 messages, smart padding, mention tracking). Swappable — different assemblers for different strategies.

### Normalized Message Type (platform-agnostic)

```typescript
interface Message {
  id: string;                    // unique, platform-specific ID (Slack ts, etc.)
  timestamp: number;             // unix epoch ms
  source: string;                // "slack", "discord", "ui", etc.
  channel: string;               // normalized channel name
  channelId: string;             // platform-specific channel ID
  threadId?: string;             // thread root ID (platform-specific)
  author: string;                // display name
  authorId: string;              // platform-specific user ID
  text: string;                  // message content
  isThreadReply: boolean;
  isMention: boolean;            // mentions this agent
  replyCount?: number;           // number of thread replies (if top-level)
  tags?: string[];               // subject tags (future: auto-generated)
}
```

### Source Adapter Interface

```typescript
interface SourceAdapter {
  platform: string;              // "slack", "discord", etc.
  fetchChannelHistory(channelId: string, limit: number, since?: string): Promise<Message[]>;
  fetchThreadReplies(channelId: string, threadId: string, limit: number): Promise<Message[]>;
  resolveAuthor(authorId: string): Promise<string>;
}
```

Slack adapter wraps `conversations.history`, `conversations.replies`, `users.info`. Future adapters wrap their own APIs.

### ContextConfig object

```typescript
interface ContextConfig {
  // Message budget
  totalMessageCap: number;       // default: 50 (Pav's direction)

  // Local slice (current thread/channel)
  localSlicePadding: number;     // ±N around trigger, default: 2
  localSliceIncludeFirstLast: boolean; // always include root + latest
  localSliceAgentMessages: number;     // agent's own recent messages, default: 3

  // Unified timeline
  timelinePerChannelFloor: number;     // min messages per channel, default: 3
  timelineThreadReplyCap: number;      // max replies fetched per thread, default: 3
  timelineThreadsToExpand: number;     // max threads to expand in timeline, default: 5

  // Mention inbox
  mentionsCap: number;           // default: 10
  mentionStalenessHours: number; // default: 24

  // Personal breadcrumbs
  breadcrumbsCap: number;        // default: 50 lines

  // Council breadcrumbs
  councilBreadcrumbsChars: number; // default: 5000

  // Watched channels (auto-grows when agent is tagged somewhere new)
  watchedChannels: string[];

  // Timeout
  contextTimeoutMs: number;      // default: 10000

  // Assembler strategy
  assembler: 'default' | 'summary' | 'topic'; // default: 'default'

  // Archive (stub for future)
  archiveAfterHours?: number;    // messages older than N hours get summarized
}
```

Config file: `memory/{agent}-context-config.json`. Loaded on startup, saved when `trackChannel()` adds a new channel.

### Core Change: Thread-Aware Timeline

The unified timeline fetch adds a second pass:

1. Fetch top-level messages from all watched channels (existing — cached, incremental)
2. Identify messages with `reply_count > 0` (Slack includes this in history responses)
3. For the N most recent threaded messages, fetch thread replies (`conversations.replies`)
4. For threads where the agent is mentioned: include ±2 messages around the mention + first message + last message
5. For other threads: include just last 2 replies (enough to know what's happening)
6. Tag each message with `{ channel, threadRootTs, isThreadReply }` so Claude knows the structure
7. Merge everything chronologically, cap at config.totalMessageCap

### Smart Padding for Thread Mentions

When a thread contains a mention of the agent:
- Thread root (first message)
- ±2 messages around the mention
- Latest reply
- Tagged with `[mentioned]` in output

When a thread doesn't mention the agent:
- Last 2 replies only
- Tagged with `[thread: {root preview}]`

### Message Format (traceable, taggable)

Each message gets metadata that's visible in the context injection:

```
[09:15] #room-orchestrator @Soren: v0.5.1 audit posted...
[09:16] #room-orchestrator (thread: v0.5.1 audit) @Veil: [mentioned] confirmed all claims...
[09:17] #room-orchestrator (thread: v0.5.1 audit) @Pav: latest reply...
```

The `(thread: ...)` tag gives Claude thread grouping. The `[mentioned]` tag highlights why this message was included.

### Swappable Architecture

The context provider exposes a `ContextAssembler` interface:

```typescript
interface ContextAssembler {
  assemble(trigger: TriggerContext): Promise<ContextPacket>;
}
```

The current implementation becomes `DefaultContextAssembler`. Future alternatives:
- `SummaryContextAssembler` — uses a small model to compress old messages
- `TopicContextAssembler` — groups by detected topic instead of chronological

Swapping is a one-line config change: `assembler: "default" | "summary" | "topic"`.

### Auto-Summary/Archive Path

Not building the summarizer now, but the architecture supports it:
- `ContextConfig.archiveAfterHours: number` — messages older than N hours get summarized
- Summaries stored in `memory/{agent}-thread-summaries.json`
- Context assembler reads summaries for old threads, raw messages for recent ones
- The breadcrumb writer already creates a per-turn trail — that's the input for future auto-summary

## Files

### New (shared library — used by all agents)

| File | Purpose |
|------|---------|
| `world-bench/lib/context/types.ts` | `Message`, `ContextConfig`, `ContextPacket`, `SourceAdapter`, `ContextAssembler` interfaces |
| `world-bench/lib/context/message-store.ts` | Platform-agnostic cached message store with incremental updates |
| `world-bench/lib/context/slack-adapter.ts` | Slack `SourceAdapter` — wraps conversations.history/replies/users.info |
| `world-bench/lib/context/default-assembler.ts` | Default `ContextAssembler` — local slice + timeline + mentions + breadcrumbs |
| `world-bench/lib/context/index.ts` | Factory: creates a context provider from config + adapter |

### Modified (thin wrappers that import the shared lib)

| File | Changes |
|------|---------|
| `world-bench/orchestrator/context-provider.ts` | Thin wrapper: imports shared lib, passes WebClient to SlackAdapter |
| `agents/rz-anthropic-og/.../context-provider.ts` | Thin wrapper: imports shared lib, passes App.client to SlackAdapter |
| `agents/rz-anthropic/.../context-provider.ts` | Same for Veil (after canary) |

### Why shared lib?

Three agents currently copy-paste the same context provider. Every fix requires three edits. A shared library at `world-bench/lib/context/` means one codebase, three thin wrappers. Platform adapters are swappable — add a Discord adapter or custom UI adapter later without touching the core.

## What Changes from v0.1

| v0.1 | v2 |
|------|-----|
| Coupled to Slack API | Platform-agnostic core + Slack adapter |
| 70 message timeline cap | 50 total (Pav's direction) |
| Top-level messages only | Thread replies included with smart padding |
| Hardcoded constants | ContextConfig object, persisted to disk |
| One implementation | Swappable ContextAssembler interface |
| Flat message list | Tagged with channel + thread + mention status |
| No thread grouping | Thread root preview in output |
| No archive path | Config stub for archiveAfterHours + summary store |
| Three copy-pasted files | One shared lib, three thin wrappers |

## Build Order

1. Define types: `Message`, `ContextConfig`, `SourceAdapter`, `ContextAssembler`, `ContextPacket`
2. Build `SlackAdapter` (extract Slack-specific code from current context-provider)
3. Build `MessageStore` (extract caching logic — incremental fetch, per-channel cache)
4. Build `DefaultContextAssembler` (local slice + thread-aware timeline + mention inbox + breadcrumbs)
5. Build factory `index.ts` (wires adapter + store + assembler from config)
6. Thin wrapper for Orchestrator
7. Test on Orchestrator — verify thread replies visible
8. Thin wrapper for Soren (canary)
9. Test canary — Soren sees threads from `#room-orchestrator`
10. Port to Veil after canary passes

## Verification

1. TypeScript compiles clean (shared lib + all three wrappers)
2. Boot Orchestrator — context includes thread replies from `#room-orchestrator`
3. Tag Soren in a thread in `#room-orchestrator` — he sees thread content in next response
4. Config file created at `memory/{agent}-context-config.json` on first run
5. Change `totalMessageCap` in config file — takes effect on next message, no restart
6. Add a new channel to `watchedChannels` — picked up on next message
