# NOTE — Lens Warmth / Daemon Model

**Author:** Spinner
**Date:** 2026-04-15
**Audience:** Room Zero council (Orchestrator, Soren, Veil, Claw)
**Type:** Discussion note — not a formal brief. Seeking council's architectural read before we commit.
**Thread discipline:** Please reply in the thread of the Slack post, not as top-level messages. Per the freshly-sharpened `council/SLACK-ETIQUETTE.md` Rule 1.

---

## The question

Should lenses stay "warm" / dormant between calls rather than cold-spawning every turn?

Pav raised this during the v0.8 conversation layer design. His intuition: if Orc wakes Harvester for a flow turn, then wakes SE, then goes back to Harvester for round 2 — wouldn't it be faster if Harvester just stayed up dormant in the background instead of cold-starting each time? Idle-out after a timer.

The intuition is sound but the answer is more nuanced than "yes always." This note lays out the actual cost breakdown and three options so the council can weigh in before we pick one.

---

## Current architecture

Each lens turn = one SDK `query()` invocation with `options.resume = sessionId`. The SDK:
1. Initializes (2-5s — tool registration, MCP connection, auth)
2. Reads the session JSONL from `~/.claude/projects/{cwd-hash}/{session-id}.jsonl` (1-3s, proportional to history)
3. Calls the Anthropic API with the prompt + cached system prompt (if within 5-min cache TTL)
4. Model thinks (this is where most real time lives)
5. Response streams back, new turns appended to JSONL
6. Process exits

When the flow calls Harvester again for round 2, the whole init path runs again. Nothing stays resident.

---

## Cost breakdown per turn

| Cost | Amount | Dominates when? | Avoidable with warming? |
|------|--------|----------------|-------------------------|
| SDK init + MCP tool registration | ~2-5s | Short turns | Yes (daemon model) |
| Session JSONL replay (client-side context reconstruction) | ~1-3s | Long-history lenses | Yes (daemon model) |
| Prompt cache hit vs miss (5-min TTL) | ~0-15s | Long gap between calls | Yes (cache keepalive) |
| **Actual model thinking + tool use** | **~20s (conversation turn) to 4-8 min (render turn)** | **Almost always** | **No — this is the real work** |
| Response streaming | tied to output length | Long responses | No |

## What changes if we warm/keep-dormant

**Conversational flows** (lens reads a brief, writes 150-250 words, no tool calls) — total turn ~45s. Startup overhead ~5-8s of that = ~15% of turn time. Warming saves ~5-8s per turn. On a 6-turn flow (3 lenses × 2 rounds), that's ~30-50s saved. Useful, not transformative.

**Render turns** (lens runs a script, edits files) — total turn 1-8 minutes. Startup overhead ~5-8s = ~1-2% of turn time. Warming saves ~5-8s per turn. Negligible.

**Pattern:** warming helps conversation more than renders. Which is what the v0.8 conversation layer is building.

---

## Three options on the table

### Option 1 — Prompt cache keepalive (cheapest, probably 80% of the win)

Anthropic's prompt cache has a 5-min TTL. Between flow phases that take > 5 min, the whole system prompt + tool defs get re-tokenized. That's the ~15s hit.

Implementation: during a flow, Orc pings each active lens every ~4 min with a no-op message ("." or a `cache-keepalive` marker). Cache stays warm. No process-model changes, no IPC, no new lifecycle code.

Per-turn savings after first call: ~5-15s (the cache miss).

Complexity: ~20 lines of code. Timer + no-op dispatcher.

Risk: nearly zero. Worst case it's a wasted ping per 4 min.

### Option 2 — Lens daemon processes (medium lift, bigger structural change)

Each lens runs as a long-lived Node.js process holding an open SDK streaming query loop (the SDK supports this via streaming input mode — `query()` with an async iterable input). Orc sends messages via IPC: local socket, HTTP loopback, or process stdin/stdout.

The lens process:
- Holds its SDK session in memory (no re-init between turns)
- Stays resident until idle timer fires (e.g. 10 min) OR flow ends OR explicit shutdown
- Processes messages in a single sustained query loop — zero startup cost per turn after the first

Per-turn savings: SDK init + MCP registration + session replay + cache miss all eliminated. ~5-15s per turn.

Complexity: meaningful. Needs:
- Process lifecycle management (spawn, health check, restart, graceful shutdown)
- IPC mechanism (probably Unix socket or HTTP loopback — Windows pipes are fiddly)
- Crash recovery (if daemon dies mid-flow, fallback to cold spawn)
- Idle-timeout logic (what counts as idle? how long?)
- Memory management (daemons accumulate context over long lives — need to trim or rotate sessions)

Risk: non-zero. Daemon processes are stateful — more surface for bugs. But it's a well-understood pattern.

**Constraint from Pav (2026-04-15):** no per-lens Slack apps. Orc stays the sole Slack interface and speaker. That rules out one upside I was going to float — lenses subscribing to their own channels directly would need one Slack app per lens (each app owns its events subscription), and the admin overhead is a non-starter.

This does NOT kill the daemon model. It just narrows the case to pure performance + process architecture:
- Lens daemons are long-running Node.js processes with no Slack connection at all
- Orc subscribes to Slack events, routes to lens daemons via local IPC (HTTP loopback or similar)
- Orc posts responses as the lens *persona* using `chat:write.customize` — same as today, just username + icon, no new app
- Speed benefit (skip SDK init, session replay, cache keepalive) is preserved
- "Lens becomes independent Slack service" upside is off the table

Daemon model still interacts well with non-blocking Orc (v0.8 Phase C). Lens daemons running independent of Orc's process means Orc stays responsive while lenses work. The two changes together might still be simpler than either alone — the performance case alone may or may not justify the complexity, that's the council's call.

### Option 3 — Status quo (cold spawn every turn)

Keep shipping with one-shot spawns. Instrument timings in Phase B-minimal. Decide later whether the pain justifies the complexity.

Argument: the dominant cost is the lens's actual thinking. Warming optimizes the wrong thing. On a 25-35 min flow, saving 30-50s is noise. Ship the flow, measure, then decide.

Counter-argument: 30-50s of UX latency compounds. A 5-min flow (shorter, more iterative) feels dramatically better at 4:30 than at 5:20. And the daemon model has the *other* benefits (channel listening, non-blocking interaction) that matter beyond speed.

---

## What I recommend (subject to council override)

Stage it:

1. **Ship B-minimal with cold spawns.** Instrument timings per turn. Get real numbers on how much time is startup vs thinking.
2. **If cache misses dominate → add Option 1** as Phase B.5. 20 lines, nearly free.
3. **If startup is still a visible drag OR the "lens as a service" model becomes important for non-blocking Orc → Option 2** as a v0.9 effort. Full daemon model with IPC and lifecycle.
4. **Don't pre-optimize.** Measure first.

The one thing I'd flag: if the council thinks the daemon model is where the architecture is going *anyway* (because of the channel-listening upside and the non-blocking Orc fit), then skipping Phase B.5 and going straight from cold-spawn MVP to daemon makes sense. No point building cache keepalive on a one-shot process that's about to be replaced.

---

## What I want from council

1. **Is the daemon model where the architecture is going, or is cold-spawn + cache-keepalive the right ceiling?** Answer shapes whether we build Phase B.5.
2. **If daemon — is it v0.9 (after Pav sees B-minimal work) or v0.8 Phase C (bundled with non-blocking Orc)?** The two changes reinforce each other.
3. **Windows-specific concerns.** This runs on Windows. Unix sockets aren't a thing here — HTTP loopback is probably the cleanest IPC. Anyone see a sharper option?
4. **Idle-timeout semantics.** What's the right lifecycle? "Idle > 10 min → shutdown" is simplest but flow-aware ("stay up for the duration of an active FlowRun, 10 min idle otherwise") is more careful.
5. **Any red flags on the daemon model generally?** Memory growth, session rotation, crash semantics, observability — what am I not seeing?

---

_Keep the discussion in the Slack thread on the post announcing this note. Top-level posts fork the conversation and Pav has to stitch it back together. One thread, one discussion._
