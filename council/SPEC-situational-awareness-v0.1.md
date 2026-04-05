# Situational Awareness v0.1 — Build Plan

**Author:** Spinner, incorporating Pav's direction + Claw's architecture + Soren/Veil's scoping
**Status:** DRAFT — awaiting council approval before build
**Scope:** v0.1 — fast wins only. Claw's full 5-layer spec is the target architecture; this builds the first two layers.

---

## Problem

Every agent fetches 350 raw messages from 3 channels on every message. No caching (fixed for Orchestrator, porting to bridges). No cross-channel awareness. No memory of what the agent itself has been doing. Thread tags are invisible unless the agent is already in that thread.

## Principle

**Raw messages for the local scene. Summaries for the wider map.** (Claw)

---

## What v0.1 Builds

Four things, in priority order. All ship together.

### 1. Personal Breadcrumbs (per-agent)

Each agent maintains its own chronological trail. Not shared council breadcrumbs — personal. What *I* did, what *I* saw, who *I* talked to.

**Format:** Append-only file, one line per turn.
```
[2026-04-05 06:40] #room-orchestrator | Pav asked for self-diagnostic | ran filesystem + Slack checks, reported gaps
[2026-04-05 06:45] #wb-orchestrator | Pav asked about audit | read BUILD-AUDIT-v0.4.md, summarized for Slack
```

**Implementation:**
- After each response, append one line to `memory/{agent}-breadcrumbs.md`
- Format: `[timestamp] channel | who asked + what | what I did`
- Rolling window: last 100 entries. Older entries archived or dropped.
- No model needed — raw mechanical log. The agent writes the line, not a summarizer.
- Context provider reads last 50 entries on every turn.

**Per agent:**
| Agent | File |
|-------|------|
| Orchestrator | `world-bench/orchestrator/memory/orchestrator-breadcrumbs.md` |
| Veil | `agents/rz-anthropic/memory/veil-breadcrumbs.md` |
| Soren | `agents/rz-anthropic-og/memory/soren-breadcrumbs.md` |
| Claw | OpenClaw equivalent (Claw specs this) |

### 2. Unified Timeline (replaces channel buckets)

Replace three separate channel fetches (150 + 100 + 100) with one merged, chronologically sorted feed. 100 messages total across all watched channels. Agent sees "what happened most recently, regardless of where" — not three separate buckets.

**Implementation:**
- Fetch from all watched channels (cached — incremental after cold start)
- Merge all messages into one array
- Sort by timestamp
- Cap at 100
- Inject as a single `## Recent Activity (unified timeline)` section

**Watched channels per agent:**
| Agent | Channels |
|-------|----------|
| Orchestrator | #room-zero, #wb-orchestrator, current channel |
| Veil | #room-zero, current channel, Pav DM |
| Soren | #room-zero, current channel, Pav DM |
| Claw | Per OpenClaw config |

### 3. Mention Inbox (search-based)

On each turn, search for messages mentioning the agent since the last check. One API call. Cache results. This closes the "tagged in a thread I can't see" gap.

**Implementation:**
- `slack_search` (or `conversations.history` with mention filter) for messages containing `<@AGENT_USER_ID>`
- Filter to messages newer than last checked timestamp
- Cache hits — don't re-fetch seen mentions
- Inject as `## Recent Mentions` section (last 10 unresolved)
- Mark as "seen" when agent responds in that thread

**Status tracking:**
```
new → seen (agent read it) → answered (agent replied in thread) → stale (24h+)
```

### 4. Padded Local Slice (replace full thread fetch)

Instead of fetching 100 messages from the current channel, fetch a tight slice around the triggering message.

**For a channel message:**
- Trigger message
- Previous 3 channel messages
- Latest thread reply (if message has a thread)
- Agent's last 3 messages in this channel

**For a thread reply:**
- Trigger message
- Thread root
- Previous 3 thread replies
- Latest thread reply
- 1 channel message before thread root (for context)

**Hard cap: 20 raw messages per local slice.**

---

## What v0.1 Does NOT Build

| Feature | Why | When |
|---------|-----|------|
| Activity index (ChannelActivity, ThreadActivity) | Overbuilt — 4 agents, 6 channels | v0.2 when channels multiply |
| Confidence/staleness scoring | Premature — breadcrumbs are timestamped | v0.2 |
| Model-compressed summaries | Adds latency + failure point | v0.2 when context budget hits limits |
| Hot-thread index with summaries | Needs summarizer model | v0.2 |
| Mention scoring/suppression | Low volume doesn't need scoring | v0.2 |
| Thread-centric memory store | Good architecture, not needed yet | v0.3 |

---

## Context Budget (per turn)

| Section | Budget | Source |
|---------|--------|--------|
| Local slice (raw messages) | 50% | Padded slice around trigger |
| Mention inbox | 20% | Recent unresolved mentions |
| Personal breadcrumbs | 20% | Last 50 entries |
| Council breadcrumbs | 10% | Last 5000 chars of shared breadcrumbs |

Total hard cap: 200 messages equivalent across all sections.

---

## Implementation Split

| Component | Who Builds | Where |
|-----------|-----------|-------|
| Orchestrator context-provider.ts | Spinner | `world-bench/orchestrator/context-provider.ts` |
| Orchestrator breadcrumb writer | Spinner | `world-bench/orchestrator/index.ts` (post-response hook) |
| Veil context-provider.ts | Spinner | `agents/rz-anthropic/claude-code-slack-bot/src/context-provider.ts` |
| Veil breadcrumb writer | Spinner | `agents/rz-anthropic/claude-code-slack-bot/src/slack-handler.ts` |
| Soren context-provider.ts | Spinner | `agents/rz-anthropic-og/claude-code-slack-bot/src/context-provider.ts` |
| Soren breadcrumb writer | Spinner | `agents/rz-anthropic-og/claude-code-slack-bot/src/slack-handler.ts` |
| Claw (OpenClaw) | Claw specs, Spinner or Claw builds | OpenClaw plugin/config |

---

## Build Order

1. Personal breadcrumbs — add writer to Orchestrator first, verify, then port to Veil/Soren
2. Unified timeline — refactor context-provider to merge + sort instead of bucket
3. Mention inbox — add search-based mention fetch + status tracking
4. Padded local slice — replace full channel fetch with tight slice
5. Test across all three agents
6. Claw specs OpenClaw equivalent

---

## Shared Sludge Guardrail (non-negotiable)

- Council breadcrumbs: shared (everyone reads the same file)
- Personal breadcrumbs: per-agent (each agent writes their own)
- Mention inbox: per-agent (each agent's mentions are different)
- Unified timeline: per-agent (each agent watches different channels)

If all agents read the same compressed context, they converge into the same voice. Personal layers prevent this.

---

## Open Questions

1. **Breadcrumb writer:** Should the agent write the breadcrumb line (it knows what it did), or should the bridge write it mechanically (timestamp + channel + message length)?
2. **Mention inbox persistence:** File on disk, or in-memory cache that rebuilds from Slack search on restart?
3. **Claw's OpenClaw split:** Does OpenClaw have a context injection mechanism, or does Claw need a custom plugin?

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1-draft | 2026-04-05 | Spinner | Initial build plan. Scoped from Claw's 5-layer spec + Soren/Veil review. |
