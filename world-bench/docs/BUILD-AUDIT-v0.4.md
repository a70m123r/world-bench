# World-Bench v0.4 — Build Audit

**Date:** 2026-04-03
**Builder:** Spinner (Claude Code CLI)
**Spec:** `council/SPEC-orchestrator-v0.4.md`
**Branch:** `feat/orchestrator-v0.4`
**PR:** https://github.com/a70m123r/world-bench/pull/1

---

## Spec Items — Delivered As Specified

| Spec Item | Status | Implementation |
|-----------|--------|----------------|
| Orchestrator: Claude Code Opus 4.6 SDK, persistent | Done | `start-orchestrator.cmd` with restart loop, env clearing |
| Terminal: text-based NLP surface | Done | Conversational handler via Claude, intent parsing |
| Stem Cell Agent: one template, config-differentiated | Done | `agents/base-lens-agent.ts` |
| AgentAdapter: type boundary + ClaudeAgentAdapter | Done | Interface preserved for future SDKs (Codex, Gemini) |
| Lens Manager: spawn/monitor/teardown | Done | `orchestrator/lens-manager.ts` |
| Channel Hierarchy: orchestrator → project → lens | Done | Auto-created via Slack API, IDs stored in project.json/lens.json |
| Slack Personas: `chat:write.customize` | Done | Per-lens username + icon_emoji |
| Event Log: `events.jsonl` per run | Done | + PostToolUse hooks for automatic tool-level logging |
| Event Aggregation: summary per-lens + per-run | Done | Human-readable summaries to project channel |
| Research Lifecycle: lens transitions, maxDuration | Done | 120s default, timeout kills agent, partial output preserved |
| First Loop: Headlines → Jokes | Done | End-to-end: 10 headlines, 30 jokes, posted with lens personas |
| Bridge: manual, feedback captured | Done | Pav's messages in `#wb-proj-*` logged as WorkflowEvents |
| Error Handling: degrade and continue | Done | + file checkpoint rewind via SDK |
| Concurrency: 1 lens at a time | Done | Sequential execution |

---

## Deviations From Spec

| Spec Says | Reality | Reason |
|-----------|---------|--------|
| Channels: `#orchestrator`, `#proj-*`, `#lens-*` | `#wb-orchestrator`, `#wb-proj-*`, `#wb-lens-*` | `#orchestrator` was a ghost channel (name_taken but invisible). `wb-` prefix avoids namespace conflicts with existing workspace channels. |
| Lenses write own events to `events.jsonl` | Orchestrator writes all events via `event-log.ts` + PostToolUse hooks | Lenses are SDK subprocesses — can't write to a shared file safely. Hooks capture tool calls automatically instead. Net result: more event data, not less. |
| `AgentAdapter` interface used by LensManager | LensManager typed to `ClaudeAgentAdapter` directly | Needed access to `rewindOnFailure()` (file checkpoint rollback) which is Claude-specific. Generic `AgentAdapter` interface still exists for future SDK adapters. |
| Workspace layout: 4 files in `orchestrator/` | 6 files: added `event-log.ts`, `context-provider.ts` | `event-log.ts` extracted for sharing between adapter hooks and manager. `context-provider.ts` matches Veil/Soren pattern for situational awareness. |

---

## Added Beyond Spec

These weren't in `SPEC-orchestrator-v0.4.md` but were either explicitly requested by Pav during the build or required to match the operational pattern of existing agents (Veil, Soren).

### Pav's Pre-Build Checkpoint (requested)

| Feature | Source | Implementation |
|---------|--------|----------------|
| PostToolUse hooks → event log | Pav's #kitchen pre-build message | Every tool call auto-logged to `events.jsonl` |
| Native Agent definitions | Same | Lenses defined as `AgentDefinition` objects in SDK options |
| File Checkpointing → rollback | Same | `enableFileCheckpointing: true`, `rewindOnFailure()` on lens failure |
| Max OAuth enforcement | Same | `ANTHROPIC_API_KEY` cleared in adapter constructor, `CLAUDE_CODE_OAUTH_TOKEN` in `.env` |

### Matching Veil/Soren Pattern (operational parity)

| Feature | Why | Implementation |
|---------|-----|----------------|
| Session continuity | Orchestrator needs to remember conversations | Single-brain session across all channels via SDK `options.resume` |
| Memory MCP | Long-term recall across restarts | `@modelcontextprotocol/server-memory` at `orchestrator/memory/knowledge-graph.jsonl` |
| Slack MCP | Read channel history, search, user info | Own copy of Slack MCP server at `mcp-servers/slack-mcp-server/` with Orchestrator's bot token |
| Context provider | Situational awareness on every message | Pre-fetches 150 Room Zero msgs + 100 current channel + 100 #wb-orchestrator + breadcrumbs (20k chars) + project state |
| `start-orchestrator.cmd` | Persistence with kill-stale-first | Same pattern as `start-soren.cmd` — env clearing, restart loop |

### Build-Time Discoveries (emerged during testing)

| Feature | Why | Implementation |
|---------|-----|----------------|
| NLP conversational handler | Spec said "NLP surface" — needed Claude to interpret arbitrary commands, not keyword matching | `converse()` method: Claude decides chat vs create_project vs status |
| `app_mention` handler | Council agents couldn't interact with Orchestrator via `@` tags | `app.event('app_mention')` in `terminal.ts` — responds in any channel |
| Human-readable Slack output | First loop dumped raw JSON to Slack, truncated | `summarizeOutput()` extracts titles/jokes, full output to lens channels only |
| Auto-invite Pav | Pav couldn't see new channels | `conversations.invite()` on every channel creation |
| Hourglass reaction | No visibility into thinking state | ⏳ reaction on message while processing, removed on reply |
| Console tool logging | No terminal visibility | `[Orchestrator] Tool: tool_name` logged in real-time |
| `name_taken` loop fix | `createChannel` → `findOrCreateChannel` → infinite recursion | Suffixed fallback name on `name_taken` error |

---

## Known Issues (Open)

| Issue | Severity | Status |
|-------|----------|--------|
| JSON response format fragility | Medium | Conversational handler requires Claude to output valid JSON. Falls back to plain text on parse failure — works but loses action routing (create_project won't trigger). |
| No crash recovery for orphaned runs | Low | If Orchestrator dies mid-run, `meta.json` stays `status: running`. Spec defers auto-restart to v0.5. |
| Session context can go stale | Low | Resumed sessions carry old self-diagnosis. Fix: clear sessions on code changes. Could auto-detect code version mismatch. |
| `#orchestrator` ghost channel | Low | Can't create bare `#orchestrator` (name_taken). `wb-` prefix is the workaround. Cosmetic only. |

---

## File Manifest

```
world-bench/
  CLAUDE.md                          # Agent identity + operational config
  package.json                       # Dependencies: claude-agent-sdk, slack/bolt, uuid
  tsconfig.json                      # TypeScript config
  mcp-servers.json                   # MCP server definitions (Slack + Memory)
  start-orchestrator.cmd             # Persistent startup with kill-stale + restart loop
  start-orchestrator.ps1             # PowerShell alternative

  agents/
    types.ts                         # All interfaces: LensConfig, WorkflowEvent, AgentAdapter, etc.
    base-lens-agent.ts               # Stem cell: buildLensSystemPrompt, buildResearchPrompt, buildProductionPrompt

  orchestrator/
    index.ts                         # Main brain: project genesis, NLP handler, lens execution
    terminal.ts                      # Slack listener: Socket Mode, app_mention, channel mgmt, persona posting
    agent-adapter.ts                 # ClaudeAgentAdapter: SDK query(), hooks, file checkpointing
    lens-manager.ts                  # Spawn/monitor/teardown, research timeout, event writing
    event-log.ts                     # Shared event utilities (createEvent, appendEvent)
    context-provider.ts              # Pre-fetch Slack + breadcrumbs + project state per message
    config/.env                      # Slack + OAuth tokens (git-ignored)
    memory/                          # Orchestrator's persistent memory (knowledge graph, MEMORY.md)
    sessions.json                    # SDK session IDs for conversation continuity

  mcp-servers/
    slack-mcp-server/                # Own copy of Slack MCP (Orchestrator's bot token)

  projects/                          # Runtime data (git-ignored)
    headline-jokes/                  # First loop test project
      project.json
      runs/{run-id}/events.jsonl
      runs/{run-id}/meta.json
      lenses/headline-reader/
      lenses/joke-writer/
```

---

## Council Code Review (2026-04-03 01:27–01:31)

Pav shared the audit in `#room-zero`. Soren, Veil, and Claw independently reviewed against codebase + spec.

**Verdict:** All three confirmed build is solid, audit is accurate.

### Bugs Found (all fixed 2026-04-03 11:38)

| # | Bug | Severity | Found by | Fix |
|---|-----|----------|----------|-----|
| 1 | `rewindOnFailure` dead code — `activeQueries.delete()` before result returned | HIGH | Soren + Claw | Capture reference before delete, null after use |
| 2 | JSON response fragility — greedy regex `{[\s\S]*}` grabs wrong object | HIGH | All three | Bracket-matched parser with string/escape awareness + fence stripping |
| 3 | Research timeout race — `kill(id)` fails if spawn hasn't resolved | MEDIUM | Veil + Claw | `getAbortController()` aborts directly, ghost agent cleanup after race |
| 4 | Double-handler — `app_mention` + `message` both fire on `@` mentions | MEDIUM | Soren | `app_mention` handles all mentions, `message` handler home-channel only |
| 5 | Bot token plaintext in `mcp-servers.json` | MEDIUM | Soren | `${SLACK_BOT_TOKEN}` env var reference, interpolated at load time |
| 6 | Type leak — `_query`/`_lastUserMessageId` as `any` on AgentResult | LOW | Veil | New `ClaudeAgentResult` interface with typed `rewindContext` field |
| 7 | Unused `orchestrator_channel_id` in ProjectMeta | LOW | Veil | Removed |
| 8 | Stale empty `lenses/` and `src/` dirs | LOW | Veil | Removed. `research/` kept (30 pre-build docs). |

### Additional Review Notes

| Note | Source | Action |
|------|--------|--------|
| Event log centralization is better than spec | Soren + Veil | Spec should be updated to match reality |
| `RunMeta` type drift — spec says `startedAt`, code says `started_at` | Soren | Spec should be updated |
| `rewindOnFailure` untested under real failure conditions | Veil | Deliberate failure test needed before daily use |
| Stale scaffold in `agents/rz-anthropic-og/world-bench/` | Soren | Should be deleted (old TODO-heavy skeleton) |
| Veil flagged channel misrouting — investigated, bridge code is correct | Veil + Spinner | Split-brain issue (bridge + CLI, no shared state), not a session key bug |

### Council Patterns Identified for v0.5 (from claw-code repo analysis)

| Pattern | Source | Application |
|---------|--------|-------------|
| Hook pipeline (`PreToolUse`/`PostToolUse`) | claw-code `PARITY.md` | Lens supervision — Orchestrator intercepts tool calls before/after execution |
| Permission/denial framework | claw-code tool registry | Per-lens tool scoping — research lens can't write files, joke lens can't bash |
| Session persistence + resume | claw-code `storage.rs` | Maps to `resume(id, newContext)` for v0.5 |
| Session compaction | claw-code runtime | Token budget management for long-running lenses |

---

## What v0.5 Needs (from spec + build learnings + council review + claw-code analysis)

| Item | Source | Priority |
|------|--------|----------|
| Per-lens permission tiers (tool whitelist/blacklist) | Council + claw-code | High |
| Structured output for command routing (replace JSON-in-prompt) | Soren (council review) | High |
| `resume(id, newContext)` — restart lens from where it left off | Spec + claw-code | High |
| Hook pipeline — Orchestrator supervises lens tool calls | claw-code + Pav pre-build | Medium |
| Crash recovery — scan for orphaned runs on restart | Build discovery | Medium |
| Deliberate failure test for `rewindOnFailure` | Veil (council review) | Medium |
| Lens-to-lens direct mesh | Spec: v0.5 | Medium |
| Mid-run agent messaging | Spec: v0.5 | Medium |
| Auto-restart on failure | Spec: v0.5 | Low |
| Session compaction for long-running lenses | claw-code | Low |
| Concurrency > 1 (if Max rate limits allow) | Build discovery | Low |
| Windows scheduled task for true boot persistence | Build: needs admin | Low |
| System prompt version tracking — don't carry stale session context | Build discovery | Low |
| Delete stale scaffold in `agents/rz-anthropic-og/world-bench/` | Soren (council review) | Low |
