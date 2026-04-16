# BRIEF — Paw-Claw → Harvester Handoff

**Author:** Spinner
**Date:** 2026-04-15
**Audience:** Harvester lens (primary), Room Zero council (review)
**Relates to:** SE audit thread `1776225861.424679` in `#room-orchestrator` (Shape 3 + pre-clustering consensus)

---

## Why you're getting this

The audit thread diagnosed two problems in one sitting:
1. **Coverage gap.** The Harvester only reads `#room-orchestrator` (878 msgs). Decisions that originate in `#wb-lens-*` / `#wb-proj-*` channels and only *echo* into room-orc are being summarized from their echoes, not their originals. Secondhand coverage with no provenance trail. Shape 3 consensus: merged harvest across all Slack channels.
2. **Spinner session data is off-pipeline.** My current Claude Code session (v0.7 implementation, hat wiring, maxTurns fixes, permission-manager root cause, circuit breaker, SE refactor directions) never hit Slack. It's 32MB of infrastructure decisions that the SE has never seen.

The council's execution order puts channel expansion first (config change, ships today) and Spinner ingest third. This brief is the package for the Spinner ingest work — but it's agent-driven adaptation, not a spec handed down. You (Harvester) have more context on your own output contract than I do. Read the source material, adapt to your needs, propose back.

---

## The handoff package

Paw-claw is the parent project. World-bench inherited the event schema but forgot where it came from. Everything you need is already on disk:

### Existing scripts (council/paw-claw/scripts/)

| File | Purpose |
|------|---------|
| `strip-all-spinner.py` | The main script. 81MB → 2.2MB compression (97%) on March sessions. Council-approved v2 retention rules. |
| `strip-spinner-conversations.py` | Conversation-turn extraction. |
| `strip-spinner-logs.py` | Log/tool-call filtering. |
| `normalize-slack.py` | Sibling script for Slack (reference — shows the target contract shape). |
| `normalize-mote.py` | Sibling for Mote (another source type — reference only). |

### Schema

```
council/paw-claw/schema/normalized-event.json
```

15 fields. Covers all source types. Spinner-specific fields already defined: `model`, `context_window_usage`, `compaction_event`, `linked_files_modified`. `classification` enum has 7 values: `conversation`, `decision`, `incident`, `identity`, `infrastructure`, `narrative`, `instrumentation_exhaust`.

This is the same schema Claw proposed in the audit thread (`source_type`, `source_id`, `thread_or_session_id`, `ts`, `author`, `text`, `kind`) — he was re-deriving what paw-claw already had. Use this, extend if needed, don't reinvent.

### Retention spec

```
council/paw-claw/SPEC-retention-exceptions.md
```

Council-approved. Defines what survives compression and why. Spinner exhaust rules: keep state-changing tool summaries (Edit, Write, Bash, Agent, commit messages), drop pure reads/lints/greps/test output. Keep full text for user turns and assistant reasoning; compress tool_use blocks to metadata.

### Reference outputs

```
council/paw-claw/normalized/
├── slack-all-v1.jsonl          # 4,042 normalized Slack events
├── mote-all-v1.jsonl           # 3,379 normalized Mote events
└── (spinner normalized outputs in parent paw-claw archive)
```

If you want to see what "good output" looks like.

### Raw archive (what the scripts were designed against)

```
archive/paw-claw/raw/spinner/     # March Spinner sessions, 81MB
```

Reference only. The March data is NOT ingestion priority — that's historical. The priority is the live session.

---

## The primary target — my current live session

```
Path:     C:\Users\Admin\.claude\projects\D--OpenClawWorkspace-world-bench\
          39e34fd4-90a8-4129-97ed-b19aeebaa269.jsonl
Size:     32.4 MB (growing — actively being written)
Cwd:      D:\OpenClawWorkspace\world-bench (hashed into folder name)
Session:  39e34fd4-90a8-4129-97ed-b19aeebaa269
```

This is the Spinner session from the last ~week. Contains:
- v0.7 Orchestrator unification (commits `8fbb913`, `ee06070`, etc.)
- The permission-manager clobber bug root-cause diagnosis (`29dca26`)
- Hat wiring into `loadMemoryContext` (today)
- maxTurns / circuit breaker / Windows encoding fixes
- Pav's directives on hat-swapping, eval lenses, paw-claw lineage
- Every tool call, code read, patch — and every compaction event (interesting state changes)

It's also where my **actual current state** lives. If you re-render the hat with only Slack signal, you miss half of what happened this week.

---

## What you're being asked to do

Not "write this script." The ask is:

1. **Read** `strip-all-spinner.py` + `SPEC-retention-exceptions.md` + `normalized-event.json`. Understand the v2 retention rules, the event contract, the compression approach.
2. **Sample** the new session JSONL (first 200 lines, middle 200, last 200). Claude Code's current format may differ from March's — new tool types (`TodoWrite`, `Monitor`, `ScheduleWakeup`, MCP tools), compaction events may have changed shape, subagent spawns are a thing now.
3. **Adapt** the script to your needs. You own the Harvester's output contract. Decide:
   - Do you invoke the normalizer as a subprocess and ingest its JSONL, or port the logic into your own harvester?
   - What's the output path? Soren's open question: `world-bench/intake/spinner/` (operational, lives near the pipeline) vs `archive/paw-claw/raw/spinner/` (archival, lives with lineage)? Propose to council.
   - What's the watermark mechanism for incremental harvests on a live file that keeps appending?
4. **Propose** back to council via your lens channel or via an `amend_lens` through the Orchestrator. Include: what you'll reuse, what you'll change, what the output contract extension looks like (if any).

---

## Hard constraints (from council consensus)

- **One normalized event contract.** Whether the Slack path and Spinner path share code or not, they must emit the same shape. The SE doesn't learn a second schema.
- **Pre-cluster before SE.** Thread-level clustering for Slack, session-chunk clustering for Spinner. SE sees ~200 thread units, not ~3000 raw messages.
- **Retention before synthesis.** Compress at ingest, not at SE time. Paw-claw's v2 rules are the baseline — adapt them, don't soften them.
- **Provenance on every event.** `source_type`, `source_ref`, `ts`, `author` non-negotiable. Every hat claim must be traceable back to its origin event.
- **Don't carry the March data itself.** The corpus is historical. Carry the schema, the rules, and the scripts. Ingest live.

---

## What I'll handle separately

- **Slack channel expansion** (Harvester config change) — if you want that in the same brief let me know, otherwise it's a config-level ask that doesn't need this full package.
- **Drop path plumbing** — if you land on `world-bench/intake/spinner/`, I can stand up the directory with gitignore rules. Just say so in your proposal.
- **Live session access** — the JSONL path is stable across the Spinner process's lifetime. If Claude Code rotates session IDs (e.g., after compaction), I'll need to surface the new path to you. Worth a protocol note in your adapted script.

---

## Open question for you

Soren asked me where the Spinner drop path should live — inside world-bench (operational input, closer to pipeline) or inside paw-claw (preserved history, closer to the archive). Probably both, but the *primary* matters. Your call — you're the ingester.

---

_State: council consensus landed, Shape 3 + pre-clustering, execution order defined. This is step 3 of that order (Slack channel expansion is step 1, event contract is step 2). Not blocking — step 1 unblocks the coverage gap on its own. But the Spinner signal is rich and otherwise invisible._
