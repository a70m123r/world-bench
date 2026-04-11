# Shoots — memory-hats

> The seed is the intent. The shoots are what's growing from it.
> Updated by the Orchestrator after renders, meets, settling changes, and decisions.
> Read by Pav, the council, and lenses for situational awareness.

**Project:** Memory Hats
**Seed:** `SEED.md` — build a filtered, role-specific working view over shared memory
**Phase:** Pipeline build — first lens rendered, settling toward steady state

---

## Pipeline

```
Harvester → Signal Extractor → Hat Renderer
   ✓            ○                  ○
settling      not started       not started
```

---

## Lens Status

| Lens | Maturity | Renders | Last Run | Duration | Output | Next Action |
|------|----------|---------|----------|----------|--------|-------------|
| **Harvester** | `settling` | 7 clean | `c690749b` (2026-04-11 02:05) | 57s | 691 msgs, 921KB | 1 more clean render → `steady` |
| **Signal Extractor** | — | 0 | — | — | — | Propose lens, meet, render |
| **Hat Renderer** | — | 0 | — | — | — | Blocked on Signal Extractor |

---

## Decisions Made

| Date | Decision | By | Evidence |
|------|----------|-----|---------|
| 2026-04-09 02:18 | Flat array with `threadTs` pointers, not nested | Harvester + Orchestrator | Meet session, Pav approved |
| 2026-04-09 02:29 | TS implementation, not Python | Orchestrator relay to Harvester | Harvester accepted |
| 2026-04-09 02:29 | Include bots (flagged), reactions, subtypes | Orchestrator relay | Harvester accepted |
| 2026-04-09 02:29 | Full rebuild every run, no incremental state | Orchestrator relay | Aligned with seed constraint |
| 2026-04-11 00:32 | Removed MCP tools from Harvester config | Orchestrator (autonomous settling) | Tools 404'd on 3 renders |
| 2026-04-11 00:32 | Disabled research phase | Orchestrator (autonomous settling) | Research completed, `harvest.py` exists |
| 2026-04-11 01:00 | Maturity lifecycle adopted (4 phases) | Council unanimous | `SPEC-lens-maturity-lifecycle.md` |
| 2026-04-11 01:38 | Lens-as-gate settling, versioned prompts, maturityLog | Pav + council | Spec v2, council unanimous |
| 2026-04-11 18:06 | Two-layer architecture (Slack=rendering, substrate=truth) | Council unanimous | `AUDIT-v0.6.8-state-and-vision.md` |
| 2026-04-11 18:06 | Orchestrator mediates all lens↔lens interaction | Council unanimous | No peer-to-peer until 4+ settled lenses |
| 2026-04-11 18:06 | `EscalateToChannel` tool for lens self-escalation | Council unanimous | Not hook-based |

---

## Harvester — Detailed State

**Config (settled, prompt v2):**
- Tools: `Read, Write, Edit, Bash, Glob, Grep`
- Research: disabled
- Implementation: `harvest.py` — curl-based Slack API harvester
- Channel: `#wb-lens-harvester` (`C0ARUMPDYSY`)

**Render History:**
| # | Run ID | Date | Duration | Status | Notes |
|---|--------|------|----------|--------|-------|
| 1 | `c1919670` | Apr 9 02:55 | 18s | failed | Stale session resume (v0.6.5.7 fixed) |
| 2 | `09ac10dd` | Apr 9 03:18 | 90s | failed | maxTurns=10 + plugin Slack OAuth loop (v0.6.5.8 fixed) |
| 3 | `aea6b064` | Apr 10 07:00 | 4m45s | completed | First success. Wrote `harvest.py`. 626 msgs. |
| 4 | `d75bedb6` | Apr 10 23:46 | 1m29s | completed | Reused script, wasted turns on MCP search |
| 5 | `5a9f13db` | Apr 11 00:31 | 1m44s | completed | Orchestrator settled config (removed MCP, disabled research) |
| 6 | `e60b23b9` | Apr 11 00:33 | 1m05s | completed | Clean — zero wasted turns on settled config |
| 7 | `c690749b` | Apr 11 02:05 | 57s | completed | Clean — fastest render, 691 msgs |

**Output Contract:**
```json
{
  "messages": [{ "ts", "thread_ts", "user_id", "username", "text", "is_thread_parent", "reply_count", "reactions", "bot_id", "subtype" }],
  "metadata": { "channel_id", "channel_name", "message_count", "thread_count", "harvested_at", "oldest_message_ts", "latest_message_ts", "errors" }
}
```

---

## Signal Extractor — Not Started

**From seed sketch:**
> Reads raw message dump, strips tool noise, tags entries by type (decision, action, task, direction, observation). Extracts entities and relationships. Outputs structured signal.

**Input:** Harvester's `harvest.json`
**Output:** Tagged + structured signal for the Hat Renderer
**Depends on:** Harvester at `settling` or `steady`

---

## Hat Renderer — Not Started

**From seed sketch:**
> Takes structured signal, assembles the Orchestrator's hat artifact in structured markdown (Active Seeds, Recent Decisions, Pav's Latest Direction, Blocked Items).

**Input:** Signal Extractor's output
**Output:** `world-bench/hats/orchestrator/hat.md`
**Depends on:** Signal Extractor rendered + settling

---

## Blockers

_None currently. Harvester is stable. Signal Extractor can be proposed._

---

## Infrastructure Changes (v0.6.5 → v0.6.9)

| Version | What | Impact on this project |
|---------|------|----------------------|
| v0.6.5.1–.8 | Dialogue layer debug series (8 patches) | Meet + render cycle now works end-to-end |
| v0.6.6 | Lens channel streaming + post-run audit | Lens channel gets start post + escalations + audit |
| v0.6.6.1 | Channel ID preservation on re-attach | `slack_channel_id` survives re-renders |
| v0.6.7 | Maturity lifecycle | 4-phase tracking, maturityLog, prompt versioning |
| v0.6.8/.8.1 | Lens channel as meeting room | Pav can chat with lenses in their channel |
| v0.6.9 | Gate 0+1+2: sessionId capture, `amend_lens`, context injection | Lenses have identity continuity + state protection + situational awareness |

---

## What's Next

1. **Render Harvester once more** → verify sessionId capture + context injection + `amend_lens`
2. **Advance Harvester to `steady`** → if render is clean (2+ consecutive clean renders met)
3. **Propose Signal Extractor** → Orchestrator drafts lens config based on Harvester's output contract
4. **Meet Signal Extractor** → in `#wb-lens-signal-extractor`, Pav shapes the brief
5. **Render Signal Extractor** → first cut, using `harvest.json` as input
6. **Pipeline rehearsal** → `rehearse` with Harvester → Signal Extractor, watch the seam
7. **Propose Hat Renderer** → once Signal Extractor is settling
8. **Full pipeline render** → `rehearse` all three, produce `hat.md`

---

_Last updated: 2026-04-11 by Spinner. Orchestrator should update after each render/meet/settle._
