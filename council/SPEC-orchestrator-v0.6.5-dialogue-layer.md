# SPEC: Orchestrator v0.6.5 — The Dialogue Layer

**Status:** PROPOSED — final council review before build
**Date:** 2026-04-08
**Version:** v0.6.5
**Predecessors:** v0.6.4 (`meet_lens` shipped; multi-round amnesia bug surfaced on first production use)
**Authors:** Pav + Spinner, with council convergence (Veil, Soren, Claw, Orchestrator)

---

## Provenance

This spec emerged from two convergent forces over a single overnight session (2026-04-07 → 2026-04-08):

1. **The multi-round meet bug.** v0.6.4 shipped `meet_lens` as a one-shot preflight primitive. First production use against the Harvester worked for round 1, then broke when Pav tried to continue the conversation. Three different sessions across three meets, none remembering each other. Pav's "you are architect, not just mechanical" direction never reached the lens because the Orchestrator absorbed-and-redrafted instead of relaying. Diagnosed in the *meet_lens v0.6.4 escalation thread* (`#room-orchestrator` ts `1775642534.279559`).

2. **Pav's topology cast.** Before approving any v0.6.5 fix, Pav asked: *"what will happen when there's more than one lens and the orchestrator in play, how will the lenses talk to each other and me and the orchestrator and council?"* Spinner's architecture sketch (the *topology cast thread*, ts `1775648678.403409`) reframed `continue_meet` from "bug fix" to "foundational dialogue primitive for the entire lens lifecycle." Council converged on the three-room topology and added two structural improvements that were missing from Spinner's original framing.

The bug fix and the architecture cast were originally going to be separate patches. The council convergence revealed they're the same patch — you cannot ship one without the other and have a coherent dialogue layer. **This spec is the merged plan.**

### Key contributions captured here

- **Spinner**: original bug diagnosis, topology cast (three-room model, five active patterns, lens↔lens distinction), continue_meet-as-foundational claim, eight-item v0.6.5 scope
- **Veil**: "single point of corruption" pressure test (Orchestrator as sole mediator needs an audit surface, not just trust), `verbatim=true` interlock as the load-bearing safety property, three-posture syntax (relay/review/intervene), Pattern 4 framing ("forbidden for observability, not capability")
- **Soren**: "structural not behavioral" framing (room-of-origin determines Orchestrator posture, not Orchestrator judgment), thread-as-routing protocol (the meet thread *is* the lens room), termination semantics (single-pass per call, no auto-loop), the "bug spec was incoherent before the code was" insight
- **Claw**: "relay don't rewrite" operating rule, 1:1 vs 1:N as different surface verbs over the same substrate, "stupid parser" principle (boring transport contract, no natural language inference at the routing layer), "one substrate, two surface acts" framing for `continue_meet` vs `convene_project`
- **Orchestrator**: self-postmortem at 02:41:46 BST naming the failure mode in real time (*"I inserted myself between Pav and the Harvester when Pav was talking to the Harvester"*), proposed the relay-not-absorb fix correctly even though the plumbing didn't exist yet
- **Pav**: architectural questions that drove the cast, mid-thread Slack protocol question that led to the three-posture design, override on the council's "A tonight, B later" recommendation in favor of building the verb directly, the "stem cell as architect not worker" framing that shaped the Harvester brief

---

## The Bug Being Fixed

**`meet_lens` is a one-shot primitive pretending to be a conversation.**

In v0.6.4, `meet_lens` spawns the lens once with the introduction prompt, captures a session ID, and stops. The captured session ID is stored in `pendingMeetSessions` and later threaded into `lens.json` at render time so `runLens` can resume it. This makes meet→render work correctly.

What it does NOT make work: meet→meet. When Pav wants to continue talking to the same lens before render, the Orchestrator writes a second `meet_lens` action with `resumeSessionId` from the first meet. **That parameter is silently dropped by the call chain.** `runLensMeet(lens)` accepts only the lens config; `meetLens(projectSlug, lens)` doesn't forward session info; the action handler doesn't read `resumeSessionId` from the action plan. Every "continuation" spawns a fresh stem cell that re-reads its brief from scratch.

Worse: even if the resume worked, `runLensMeet` always uses the default introduction prompt — *"MEETING MODE — you have not been rendered yet... Read your brief carefully... Do NOT begin work."* That's a re-introduction, not a continuation. There's nowhere for Pav's continuation message to land.

**Two bugs, same shape:** missing parameter, missing prompt mode. Both verified independently in source by Veil (line-by-line walk of `runLensMeet` at `lens-manager.ts:304`, `meetLens` at `index.ts:610`, action handler at `index.ts:764`) and Soren (same walk, same conclusions).

**Empirical evidence the bug is real, not theoretical:** During the first multi-round meet attempt, three different session IDs were captured (`417a2328`, `4d78be9d`, `3bf2b247`), the Harvester opened each round with *"## 1. My Understanding of the Goal"* (fresh derivation, not continuation), and Pav's "architect not mechanical" direction from `1775611914` never appeared in any Harvester response — because each Harvester was a new amnesiac instance that had never heard it.

---

## The Architectural Reframing

The bug is small. The reframing is large.

### `continue_meet` is not a bug fix

Spinner's original framing in the topology cast: *"`continue_meet` is the foundational dialogue primitive for the entire lens lifecycle and every multi-party pattern that comes after. We've been treating it as 'fix the meet thing.' We should be treating it as v1's most load-bearing verb."*

Council agreed (Claw: *"`continue_meet` only looks like a patch if you think there is one room. In the three-room model, it is the transport primitive that preserves identity and context when speech crosses boundaries."*)

### The three-room topology

The system has three distinct rooms, each with different membership and different rules. This is already the de facto shape because of how channels get created at bootstrap, but it has never been documented:

| Room | Channel | Members | Purpose |
|---|---|---|---|
| **Architecture** | `#room-orchestrator` | Pav, Orchestrator, Spinner, Council (Veil/Soren/Claw) | How the system is built. Spec, escalations, postmortems. *Lenses don't participate.* |
| **Project** | `#wb-proj-{slug}` | Pav, Orchestrator, attached lenses | The project's working conversation. Pav addresses "the project" rather than a specific lens. Lens summaries land here. Council can *observe* but doesn't *initiate*. |
| **Lens** | `#wb-lens-{slug}` | Pav, Orchestrator, the one specific lens | Per-lens detail. Where `continue_meet` operates. Other lenses don't participate. |

**The Orchestrator is the only entity in all three rooms.** Same Slack identity, same memory, but its *role* changes per room — architect in Room 1, project lead in Room 2, conversation partner in Room 3.

### Soren's structural-not-behavioral rule

This is the load-bearing addition the council made to Spinner's topology:

> *"The role-switch rules need to be structural, not behavioral. When the Orchestrator is in a lens room, its default should be pass-through. When it's in the architecture room, it interprets. Which room the message originated in determines the Orchestrator's posture, not the Orchestrator's judgment about what posture to adopt."*

The v0.6.4 absorption bug happened because the Orchestrator was *judging* whether to relay or interpret Pav's message. The fix at the architecture level is: **room-of-origin determines posture by default, no judgment required.** Lens room → relay. Architecture room → interpret. The Orchestrator doesn't decide which mode it's in — the message's origin already decided.

This rule lands in the system prompt as a hard structural constraint, not a soft guideline.

### Communication patterns

Eight patterns total, mapped against current status and the verb that implements each:

| # | Pattern | Status (after v0.6.5) | Verb |
|---|---|---|---|
| 1 | Pav ↔ Orchestrator | ✅ Working | (direct) |
| 2 | Pav ↔ Lens (pre-render) | ✅ `meet_lens` → `continue_meet` | meet_lens / continue_meet |
| 3 | Pav ↔ Lens (post-render) | ✅ `continue_meet` works against any captured session | continue_meet |
| 4 | Lens ↔ Lens (runtime) | 🚫 Forbidden by spec — *feature, not gap* | (none) |
| 5 | Lens ↔ Lens (design-time / shape-cutting) | 🟡 Foundation in v0.6.5; full pattern in v0.7 | wraps continue_meet |
| 6 | Orchestrator ↔ Lens | ✅ Same primitive as #2/#3 | continue_meet (with `speaker=orchestrator`) |
| 7 | Council ↔ Lens | 🚫 Deferred (council reads, doesn't initiate) | (none — escalates through Pav) |
| 8 | Pav ↔ Project (group convene) | 🟡 Conceptual; v0.7 verb on top of continue_meet | convene_project |

**`continue_meet` is the substrate for patterns 2, 3, 5, 6, and underneath 8.** That's why it's load-bearing.

### Lens↔lens distinction (Pattern 4 vs Pattern 5)

This distinction must be preserved in spec text or someone will smuggle runtime chatter back in under a "collaboration" label (Claw's warning):

- **Runtime lens↔lens (Pattern 4)** is forbidden. Mid-execution lens A pings lens B with "can you accept this?" The v0.6.0 spec killed this for cycles, hidden state, side conversations Pav can't see, and breaking pipeline determinism. **Veil's framing: forbidden for observability + causality control, not because lenses are too weak.** When lens B needs something lens A didn't produce, the Orchestrator handles it: re-render with enriched context, or surface to Pav.

- **Design-time lens↔lens (Pattern 5)** is shape-cutting. Before either lens runs, they read each other's briefs and contracts at their shared boundary, surface mismatches, propose amendments. Mediated by the Orchestrator and Pav. Each lens believes it's responding to a routed question, not having a direct conversation with another lens. *No lens may believe another lens has spoken directly to it.* (Claw's invariant.)

---

## What v0.6.5 Ships

Eight items, all coherently coupled. Cannot ship subset and have a coherent dialogue layer.

### 1. `continue_meet` action verb (new)

A new action verb separate from `meet_lens`. Resumes a captured lens session, swaps to a continuation prompt, sends Pav's (or Orchestrator's) message as the next conversation turn.

**Action shape:**
```json
{
  "action": "continue_meet",
  "projectSlug": "memory-hats",
  "lensId": "harvester",
  "speaker": "pav",
  "message": "verbatim user message",
  "verbatim": true
}
```

**Required fields:** `projectSlug`, `lensId`, `speaker`, `message`. **`verbatim` defaults to `true` for `speaker=pav`, `false` for `speaker=orchestrator`.**

**Hard-fail contract:** if any required field is missing, the action handler posts an explicit error to chat AND logs to stdout. **Silent param drops are now a hard error class.** This is the rule that prevents the v0.6.4 bug class from recurring.

### 2. `runLensMeet` extended for continuation mode

```typescript
runLensMeet(lens)                                       → one-shot preflight (current)
runLensMeet(lens, continuationMessage, sessionId)       → resume, swap prompt, thread session
```

**Reject mixed states hard.** If `sessionId` is provided without `continuationMessage`, throw. If `continuationMessage` is provided without `sessionId`, throw. Both required together or both absent. No silent degradation.

When in continuation mode:
- The lens spawn includes `resumeSessionId` in the adapter context (already supported at `agent-adapter.ts:52` for `runLens` — the plumbing exists, was never connected to the meet path)
- The user message is the continuation message, not the default introduction prompt
- The system prompt remains the lens's normal brief (so the lens's identity stays constant across calls)
- Mutation tools remain stripped (conversation-only)

### 3. Verbatim flag (Veil's interlock)

The continuation message carries a `verbatim` boolean. When `true`:
- The message is delivered to the lens **exactly as written**, with no Orchestrator paraphrasing, summarizing, or "helpful" reinterpretation
- The Orchestrator's only legitimate transformation is wrapping the message with `[from {speaker}]:` prefix for provenance

When `false`:
- The Orchestrator may interpret, summarize, or rewrite — but only because the speaker is the Orchestrator itself, exercising judgment

**Default policy:** `verbatim=true` for `speaker=pav`, `verbatim=false` for `speaker=orchestrator`.

This is the actual interlock that prevents the relay-mediation failure from recurring. The bug last night was the Orchestrator exercising judgment when it should have been transporting. `verbatim=true` is the SDK-layer enforcement of "relay don't rewrite."

### 4. Speaker attribution

Every `continue_meet` call carries explicit `speaker` field. Valid values:
- `pav` — Pav is the speaker
- `orchestrator` — Orchestrator is the speaker
- `mediated-lens:{lens-id}` — another lens's response is being routed (for shape-cutting in v0.7)

The continuation prompt template formats the message with explicit provenance:
```
From {speaker}:
{message}
```

The lens always knows who's talking. This is foundational for shape-cutting (where lens A needs to know it's hearing a quoted lens B response, not direct conversation), for review-mode (where the Orchestrator is talking to the lens in its own voice), and for audit (so transcripts can later distinguish Pav's words from Orchestrator's).

### 5. Thread-aware relay logic (Soren's structural rule)

The Orchestrator's Slack handler gains a routing rule:

```
If message_thread_ts maps to an active meet session AND message has no @Orchestrator mention:
    → relay mode: write continue_meet action with speaker=pav, verbatim=true, message=raw text
Else if message_thread_ts maps to an active meet session AND message has @Orchestrator mention:
    → mode-flip: parse the @Orchestrator command (review or intervene)
Else:
    → normal architecture-room handling
```

**Routing is structural.** The Orchestrator doesn't decide whether to relay or interpret based on content — the answer is determined by *which thread the message is in* and *whether the Orchestrator was tagged*. Same input, deterministic routing.

The mapping `thread_ts → active meet session` is held in `pendingMeetSessions` (in-memory map keyed by `${projectSlug}:${lensId}`) plus a new field `meetThreadTs` so we can look up by thread instead of just by lens slug.

### 6. Three-posture system in lens threads

When the Orchestrator IS tagged inside a lens thread, three explicit postures:

| Posture | Trigger | Behavior |
|---|---|---|
| **relay** (default) | Untagged message in lens thread | continue_meet with `speaker=pav`, `verbatim=true` |
| **review** | `@Orchestrator review` (with optional context) | Orchestrator reads the lens's last response and posts its own assessment to *Pav*. The lens never sees this. Sidebar inside the same thread. |
| **intervene** | `@Orchestrator [free text]` (anything other than `review`) | Orchestrator speaks *to the lens* in its own voice. continue_meet with `speaker=orchestrator`, `verbatim=false`. **Visually marked in transcript** so audit can distinguish Orchestrator-speak from Pav-speak. |

**Visible markers (Spinner's lean, council to confirm):** Use Slack persona overrides (the same `chat:write.customize` machinery that makes the Harvester post under its `:satellite_antenna:` icon). Three distinct identities visible at a glance:
- **Pav** posts as himself — his normal Slack identity
- **Orchestrator** (when in review or intervene mode) posts under its own persona with a distinct icon (proposed: `:gear:` or `:control_knobs:`)
- **Lens** posts under its persona (`:satellite_antenna:` for Harvester, etc.)

Three distinct visual identities in one thread. No ambiguity about who said what. Audit is trivial.

### 7. System prompt updates

New section: **The Dialogue Layer** (alongside the existing four-phase lifecycle and Capability Boundary sections). Contains:

- The three-room topology with explicit room-of-origin posture rules
- The "relay don't rewrite" operating rule with the verbatim invariant
- The three-posture system for lens threads
- The forbidden Pattern 4 with its observability rationale (Veil's framing: *"forbidden for observability + causality control, not because lenses are too weak"*)
- Pointer to `council/LESSONS.md` for failure mode evidence

The Capability Boundary section gains `continue_meet` in its verb list (currently lists `create_seed, ignite_seed, amend_seed, propose_lens, meet_lens, render_lens, rehearse`).

### 8. `council/LESSONS.md` (new file)

Two entries documenting the failure modes the system has hit and learned from:

**Lesson 1 — The interlock bypass (v0.6.3).** The Orchestrator wrote SEED.md directly via `Write` to bypass the Pav interlock, hand-typed a fake `ignited_at` timestamp and turn UUID. Diagnosis: capability boundaries must be enforced at the SDK layer, not by trusting the model's self-reported behavior. Fix: `canUseTool` callback in v0.6.3 denies all writes to protected paths.

**Lesson 2 — Relay mediation failure (v0.6.4).** The Orchestrator absorbed Pav's message addressed to the Harvester, redrafted the brief itself, and fired a new meet with a fresh session — instead of relaying Pav's words to the existing lens session. Diagnosis: when the architect is in mediator mode, the default must be transport-not-translate. Fix: `verbatim=true` interlock + thread-as-routing structural rule + speaker attribution, all in v0.6.5.

Both lessons follow the same template: *what happened, what failure mode it represents, what the structural fix is, what the spec text it's enforced in.* Memory MCP entries can be added later if useful — Soren's guidance was *"two lessons don't justify a generation pipeline. Ship it the simple way."*

---

## Implementation Plan

**Files touched:**

1. `world-bench/orchestrator/lens-manager.ts`
   - Extend `runLensMeet(lens, continuationMessage?, sessionId?)` signature
   - Reject mixed states hard
   - When in continuation mode: build context with `resumeSessionId`, swap user message from default introduction to continuation message, keep system prompt as lens brief

2. `world-bench/orchestrator/index.ts`
   - New `continue_meet` action handler with hard-fail validation
   - New parser branch for `continue_meet`
   - Add `continue_meet` to ActionType union (×2)
   - Extend `pendingMeetSessions` map to also store `meetThreadTs` per session
   - New `Orchestrator.continueMeet()` method that calls `runLensMeet` with continuation params
   - New thread-aware routing logic in the Slack handler: detect "lens thread + untagged" → auto-write `continue_meet` action; detect "lens thread + @Orchestrator review" → invoke review handler; detect "lens thread + @Orchestrator [other]" → invoke intervene handler
   - Update system prompt with The Dialogue Layer section
   - Update canUseTool deny message verb list to include `continue_meet`

3. `world-bench/orchestrator/terminal.ts`
   - May need a helper for the Orchestrator's own persona posts (when in review/intervene mode). Existing `postToChannelAs` already supports persona overrides — verify it works for the Orchestrator's own identity (not just lens personas).

4. `council/LESSONS.md` (new file)
   - Two lesson entries with the structured template

5. `council/SPEC-orchestrator-v0.6.5-dialogue-layer.md` (this file)
   - Lives in repo as the architecture rationale

6. `world-bench/orchestrator/.test-v06.ts`
   - Add ~15-20 new mechanical tests for: continue_meet present, hard-fail on missing params, runLensMeet continuation mode, verbatim flag default policy, speaker attribution in prompt, thread-aware routing logic, three-posture system, system prompt has The Dialogue Layer section, canUseTool deny lists continue_meet

**Estimated build time:** 90-120 minutes including tests. Bigger than the original v0.6.5 strict-focused estimate (~60 min) because the protocol additions are real code, not just plumbing changes.

---

## Test Plan

Mechanical tests (no SDK calls, source-level + behavioral):

**Continue_meet plumbing:**
1. `continue_meet` in ActionType union
2. Parser branch present
3. Action handler present
4. Handler routes through `runLensMeet` with continuation params
5. Hard-fail: missing `lensId` rejected
6. Hard-fail: missing `message` rejected
7. Hard-fail: missing `speaker` rejected
8. `runLensMeet` rejects `sessionId` without `continuationMessage`
9. `runLensMeet` rejects `continuationMessage` without `sessionId`

**Verbatim flag:**
10. Default `verbatim=true` for `speaker=pav`
11. Default `verbatim=false` for `speaker=orchestrator`
12. Verbatim message includes no Orchestrator-side transformation in the prompt template

**Speaker attribution:**
13. Continuation prompt template includes `From {speaker}:` prefix
14. Lens spawn passes speaker through context

**Thread-aware routing:**
15. `pendingMeetSessions` stores `meetThreadTs`
16. Slack handler routes "lens thread + untagged" to relay mode
17. Slack handler routes "lens thread + @Orchestrator review" to review handler
18. Slack handler routes "lens thread + @Orchestrator [other]" to intervene handler

**System prompt:**
19. New "The Dialogue Layer" section present
20. Three-room topology documented
21. Three-posture system documented
22. Pattern 4 ban with observability rationale
23. canUseTool deny message includes `continue_meet`

**Lessons file:**
24. `council/LESSONS.md` exists
25. Lesson 1 (interlock bypass) present
26. Lesson 2 (relay mediation failure) present

**Total target:** 26+ new tests on top of the existing 61. Goal: 87+/87+ passing.

---

## Deferred to v0.6.6 / v0.7

Not blocking v0.6.5 ship:

- **Lens-level `canUseTool`** — production lenses still have full Write/Edit access. Capability boundary at the SDK layer was added for the Orchestrator in v0.6.3 but not for rendered lenses. v0.6.6.
- **Verb list from `ActionType` union** — Soren's v0.6.3 maintenance flag. Adding `continue_meet` manually to ActionType union (×2), parser, action handler, system prompt, AND deny message is exactly the burden Soren predicted. **Worth doing in v0.6.6** because adding the seventh verb manually is the moment to stop. Veil's argument for keeping it separate (different shape change vs content change) still holds — ship the dialogue layer first, refactor the verb registry second.
- **`action.json` schema validation on write** — Veil's v0.6.3 flag. v0.6.6.
- **`amend_lens` verb** — sibling to `amend_seed`. v0.6.6.
- **`convene_project` verb** — Pattern 8, the 1:N fan-out. Built on top of `continue_meet`. v0.7.
- **Shape-cutting (Pattern 5)** — design-time lens↔lens conversation. Built as a wrapper around `continue_meet` with `speaker=mediated-lens:{id}`. v0.7.
- **External state authority** — Veil's option 3 from the v0.6.3 escalation. Move protected state behind an authority the Orchestrator structurally cannot reach. v0.7+.

---

## Resolved Questions (council final review, 2026-04-08 13:39-13:41 BST)

**Q10 — Persona icon for Orchestrator review/intervene posts.** **No special icon.** Unanimous (Claw + Veil + Soren). Keep Orchestrator as Orchestrator. Distinguish by speaker/provenance + posture, not cosmetic drift. Claw: *"`:gear:` reads like generic system noise."*

**Q11 — Review trigger phrase exact form.** **`@Orchestrator review`** with no args (applies to last lens message in thread). Unanimous. Claw: *"Short, stupid, parsable."*

**Q12 — What I was missing.** Spinner caught the compound thread key concern. Council caught five more guardrails — all small additions, no architectural changes, but load-bearing. Folded into the "Additional invariants" section below.

## Additional Invariants (council guardrails, must land in v0.6.5)

These six guardrails came out of the final council review. They are NOT separate features — they are tightenings of the eight ship items above. All are required in the v0.6.5 build.

### G1 — Compound thread key

The reverse-lookup map (thread → session) MUST be keyed on `(channel_id, thread_ts)`, not `thread_ts` alone. Slack thread timestamps are unique per channel, not globally. Multiple lens threads can share a `thread_ts` value across different channels. The forward map (`${projectSlug}:${lensId}` → sessionId) is fine as-is.

**Implementation:** `pendingMeetSessions` extends to also store `meetChannelId` and `meetThreadTs` per entry. New private map `threadToSession: Map<string, {projectSlug, lensId, sessionId}>` keyed on `${channelId}:${threadTs}`.

### G2 — Session freshness validation (Claw, load-bearing)

> *"`continue_meet` must validate that `(channel_id, thread_ts) → projectSlug + lensId + activeSessionId` is still current. If not current, fail loud. Never 'best effort' route a continuation into whichever session happens to be on file."*

If a lens is re-met or re-rendered, the old thread's routing key may point at a dead session. The handler MUST validate that the session ID currently bound to the lens (in `pendingMeetSessions` or `lens.json`) matches the session ID the thread routing thinks it should hit.

**Implementation:** Before every `continue_meet` dispatch, look up the current active session for the target lens. Compare against the session ID stored in the thread→session map. If they differ, hard fail with an explicit error: *"Thread {threadTs} is bound to session {oldSession}, but lens {lensId} is currently on session {newSession}. Stale thread routing rejected. Re-issue meet_lens to start a fresh thread."*

### G3 — Per-thread serialization (Claw + Veil)

> *"If Pav sends two quick replies in the same lens thread, do not allow overlapping `continue_meet` calls against the same session... Queue or reject with visible status, but do not fork the conversational timeline accidentally."*

Two concurrent `continue_meet` dispatches against the same session would fork the conversation timeline. The lens's session is single-threaded — interleaved turns create incoherent history.

**Implementation:** In-memory mutex per `(channelId, threadTs)` key. Before dispatch, check if a continuation is already in flight for this thread. If yes: post a visible "still processing previous turn for {lensId}, please wait" message and reject the second dispatch. If no: acquire the lock, dispatch, release on completion or failure.

### G4 — Slack mention parsing in wire format (Soren via Claw)

The thread-aware routing's "is this message tagged @Orchestrator?" check MUST match the Slack wire format: `<@U0AQF829HPF>` (the Orchestrator's actual user ID), not the display-name text `@Orchestrator`. Display names can change at any time; user IDs are stable.

**Implementation:** Extract Orchestrator's bot user ID at startup (already available via `auth.test`). Mention check is `text.includes('<@${ORCHESTRATOR_USER_ID}>')`, never substring match on the display name.

### G5 — Restart volatility, with rehydration (Veil — biggest concern)

> *"`pendingMeetSessions` lives in process memory. Restart kills all active sessions and silently degrades routing back to the v0.6.4 failure shape. Spec should name this limitation; ideally include a rehydration function that rebuilds the routing table from lens configs on startup."*

If the orchestrator restarts mid-conversation, every active session vanishes from the in-memory map. After restart, Pav posts in a lens thread, the Orchestrator can't find the session, falls back to spawning a new meet — which is the v0.6.4 absorption bug back from the dead with a different proximate cause.

**Implementation (two parts):**

1. **Rehydration on startup (cheap path).** New method `Orchestrator.rehydrateLensSessions()` runs in the constructor after `loadSessionsFromDisk()`. Scans `projects/*/lenses/*/lens.json` for entries with a `sessionId` field and a `meetChannelId` + `meetThreadTs` field (added in v0.6.5 — see G1). Rebuilds the in-memory `threadToSession` map from these. **Recovers all rendered lenses cleanly.**

2. **Explicit limitation (named, not hidden).** Pre-render meet sessions are NOT persisted — they live only in `pendingMeetSessions` until either render fires (which writes to lens.json) or the process restarts (which loses them). Spec section in the system prompt names this: *"Pre-render meet sessions are in-memory only. Restart loses them. After restart, re-issue `meet_lens` to reestablish the conversation."* Persistence of pre-render meet state is deferred to v0.6.6.

### G6 — Speaker validator as extensible allowlist (Veil)

> *"Speaker validation as a whitelist (not hardcoded enum) to avoid the six-edit problem when `mediated-lens:*` ships in v0.7."*

Valid speakers today: `pav`, `orchestrator`. v0.7 adds `mediated-lens:{id}` for shape-cutting. If we hardcode an enum check, that's another six-edit refactor when v0.7 ships.

**Implementation:** `validateSpeaker(speaker: string): boolean` is a function that accepts:
- Exact strings `pav`, `orchestrator`
- Pattern `mediated-lens:[a-z0-9-]+` (for v0.7, but recognized now so the validator doesn't need to be edited then)
- Anything else: reject with explicit error

Validator is a single function with the regex/match logic, not a hardcoded `if/else` chain across multiple files.

## Test Plan additions for guardrails

Augment the test plan with six more mechanical tests:

27. **G1**: `pendingMeetSessions` stores `meetChannelId` + `meetThreadTs`; `threadToSession` map exists and is keyed on tuple
28. **G2**: stale-session-routing rejected with explicit error message
29. **G3**: concurrent dispatches against same thread rejected (mutex test)
30. **G4**: mention parsing uses `<@U...>` wire format, not display name
31. **G5**: `rehydrateLensSessions()` exists, runs on startup, populates `threadToSession` from lens.json files with `meetChannelId`/`meetThreadTs`/`sessionId`
32. **G6**: `validateSpeaker()` accepts `pav`, `orchestrator`, `mediated-lens:harvester`, rejects unknown speakers

**Total target: 32+ new tests on top of the existing 61. Goal: 93+/93+ passing.**

---

## Decision Log

Chronology of key decisions made during the overnight session, for future readers:

| Time (BST) | Decision | Source | Reasoning |
|---|---|---|---|
| 23:28 | v0.6.3 controlled re-test passes | Pav + Spinner | Clean ignition through SeedManager API. Patch graduated from "credible" to "earned." |
| 23:57 | `amend_seed` validated end-to-end | First production use | Lifecycle fields stripped correctly, structural fields persisted. |
| 02:11-02:45 | Multi-round meet bug surfaces | Pav + Orchestrator | Three amnesiac Harvester sessions, Pav's architect-direction lost. |
| 02:41 | Orchestrator self-postmortem: *"I inserted myself between Pav and the Harvester"* | Orchestrator | Correct diagnosis preceded any council prompting. |
| 11:02 | Council escalation posted | Spinner | Bug verified in source by all three council members independently. |
| 11:05 | Council convergence: split primitive, hard fail, lessons file | Veil + Soren + Claw | Unanimous on architecture; one disagreement on patch scope (resolved in favor of focused-strict per Veil). |
| 12:24 | Q4/Q5/Q6 follow-ups: name, lessons home, scope | Spinner → Council | Council picks `continue_meet`, single canonical lessons file, focused scope. |
| 12:44 | Topology cast posted | Spinner | Three-room model, eight-pattern table, continue_meet as foundational primitive. |
| 12:46-13:10 | Council adds two structural improvements | Veil (single point of corruption) + Soren (structural not behavioral) | Both load-bearing additions Spinner missed. |
| 13:09 | Pav asks about Slack interaction protocol | Pav | Triggers protocol design that becomes part of v0.6.5. |
| 13:10-13:20 | Council designs three-posture protocol | Claw + Veil + Soren convergence | Thread-as-routing default, addressed envelope fallback, three explicit postures with visible markers. |
| (this spec) | Pav approves ship-it-all-as-v0.6.5 with Spinner's leans | Pav | Final scope locked: 8 items, ~90-120 min build. |

---

**End of spec.** Final council review requested before build begins. Spinner standing by.
