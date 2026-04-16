# BRIEF — v0.8 Conversation Layer

**Author:** Spinner
**Date:** 2026-04-15
**Audience:** Room Zero council (review), Orchestrator (ultimate executor)
**Status:** Proposal — seeking council input on shape before implementation

---

## The ask (from Pav, 2026-04-15)

> *"What I want to see is the Orchestrator announcing the new hat scope brief to all the lenses in the project channel. Two rounds: each lens replies from their specialist perspective, then a second pass with them seeing each other's answers. Once that's complete, Orc is triggered to review and summarises for me. This should be a configuration — there might be other funnelling flows I'd want to try."*

Pav is asking for three things at once:

1. **Project channel as a real conversation room** (currently a feedback sink — see Current State below).
2. **A specific flow:** peer-review-2-round — announce → round 1 specialist views → round 2 with peer visibility → Orc synthesis for Pav.
3. **Configurability:** this shape is one of many possible "funnelling flows." The architecture should treat flows as templates, not hardcoded paths.

This brief proposes how to deliver all three without over-engineering.

---

## Current state — what's actually wired

Four message routes in `orchestrator/terminal.ts`:

| # | Trigger | Handler | Status |
|---|---------|---------|--------|
| 1 | `@Orc` anywhere | `handleCommand` | Works |
| 2 | Thread-bound message | `handleLensThreadRelay` / `handleLensThreadOrchestratorMode` | Works |
| 3 | Message in `#wb-lens-*` | `handleLensChannelMessage` | Works — session resume + Gate 2 context + lens responds as persona |
| 4 | Message in `#wb-proj-*` | `captureFeedback` | **Feedback sink only** — logs to `events.jsonl`, no response, nobody reads it |

The project channel was designed as "the project's working conversation" (system prompt line 2418) but the plumbing to deliver that never got past MVP. Lens-to-lens is blocked at `terminal.ts:112` where bot-authored messages are filtered out before any routing runs.

**Three concrete gaps between current state and Pav's vision:**

1. **Project-channel addressee routing.** No analog of Route 3 for project channels.
2. **Bot-authored messages in routing.** Line 112 drops them all, so lenses can't address each other.
3. **Flow orchestration.** No mechanism to drive a multi-phase, multi-actor conversation with visibility rules.

Plus the existing HIGH issue (`KNOWN-ISSUES.md#1`): **Orc blocks during renders.** Any conversation layer degrades to "fair weather feature" until this is addressed.

---

## The target flow — peer-review-2-round, concretely

Worked example with the paw-claw → Harvester brief:

```
[phase 1 — announce]
Orc posts to #wb-proj-memory-hats:
  "Brief on the paw-claw → Harvester handoff. Two-round council review."
  "Round 1 begins: each lens, respond from your specialist lens on
   what this means for you."

[phase 2 — round 1, each lens responds from their own POV]
(visibility: brief only — no peer responses yet)

Harvester responds as Harvester:
  "From the intake layer view: I need X, I'd change Y, Z is under-specified."
  → posts to #wb-proj-memory-hats as Harvester persona

Signal Extractor responds as Signal Extractor:
  "From the compilation layer view: schema maps cleanly, but..."
  → posts to #wb-proj-memory-hats as SE persona

Hat Renderer responds as Hat Renderer:
  "From the consumer view: doesn't change my contract, but watch for..."
  → posts to #wb-proj-memory-hats as HR persona

[phase 3 — round 2, peer visibility]
(visibility: brief + all round-1 responses from siblings)

Harvester sees SE + HR round-1, responds again:
  "Having read SE and HR: I agree on X, push back on Y, here's what shifts..."

SE sees Harvester + HR round-1, responds again:
  (same pattern)

HR sees Harvester + SE round-1, responds again:
  (same pattern)

[phase 4 — Orc synthesis]
Orc reads all 6 lens posts + the brief, posts to #wb-proj-memory-hats:
  - Brief recap (1-2 sentences)
  - Per-lens position (one line each, drawn from their round 2)
  - Points of agreement
  - Points of friction
  - Open questions Pav needs to decide
  - Recommended next action

[phase 5 — handoff]
Orc tags Pav in #room-orchestrator or wherever Pav lives:
  "Council review complete on paw-claw handoff brief.
   Summary in #wb-proj-memory-hats. Ball's with you."
```

Sequential execution. ~3-5 min per lens × 6 lens invocations + 1 Orc synthesis ≈ 25-35 minutes end-to-end. Slow for a chat but reasonable for a formal review.

---

## Architecture — two layers

### Layer 1: Conversation routing (the plumbing)

Extend the router so project channels can host real conversation:

**1a. Project-channel addressee routing** (new Route 4b):

```
message in #wb-proj-{slug}
  → parse addressees (@Lens1 @Lens2 ... @Orchestrator)
  → if specific lens tagged: route to that lens (same path as Route 3)
  → if @Orchestrator or no tag: Orc handles as project lead
  → responses post back to the project channel as the appropriate persona
```

**1b. Bot-authored messages in routing** (fix the line-112 filter):

```
currently: if (bot_id || subtype) return;   // drops everything
target:    if (subtype) return;              // keep bot_id messages for routing
           if (isOwnBotId(bot_id)) return;   // but skip our own posts
```

Allows lens A to tag lens B (`@Signal Extractor`) and trigger a wake for B with A's message as input. Lens-to-lens conversation becomes possible through the same routing machinery.

**1c. Non-blocking Orc** (KNOWN-ISSUES #1, HIGH):

The blocking fix is required for any conversation layer to be reliable. Options on file in that issue:
- (a) SDK background mode
- (b) Child process for lens execution
- (c) Queue + worker model

Without this, flows silently stall when a render is in progress. (a) is probably the smallest lift.

### Layer 2: Flow orchestration (the pattern engine)

A **flow** is a declarative description of a multi-phase, multi-actor conversation. Stored as a template, instantiated with inputs, executed against the conversation routing layer.

**Flow template shape** (YAML):

```yaml
flow_id: peer-review-2-round
description: |
  Brief is posted. Each lens gives a specialist response privately,
  then a second pass with peer visibility. Orc synthesizes for Pav.
inputs:
  - brief_ref           # path to brief file OR inline text
  - project_channel     # where the flow lives
  - lens_scope          # 'all' | [list of lens ids]
phases:
  - id: announce
    actor: orchestrator
    action: post_to_channel
    params:
      content_template: |
        :package: *Council review* — {{brief_title}}
        {{brief_summary_1line}}
        Two rounds: (1) specialist view, (2) peer-aware refinement.
        Full brief: {{brief_ref}}
      channel: "{{project_channel}}"

  - id: round_1
    actor: each_lens(lens_scope)
    action: respond
    parallelism: sequential     # v0.8 — parallel requires non-blocking Orc
    params:
      visibility: brief_only
      prompt: |
        Read the brief at {{brief_ref}}. Respond from your specialist lens:
        - What concerns you about this proposal?
        - What would you tighten / what would you loosen?
        - What's missing or unclear?
        Keep it focused. ~150-250 words.
      post_to: "{{project_channel}}"
      persona: lens

  - id: round_2
    actor: each_lens(lens_scope)
    action: respond
    parallelism: sequential
    params:
      visibility: brief_plus_peer_responses   # includes round_1 outputs
      prompt: |
        You've seen the brief and your peers' round-1 responses (above).
        Refine your position:
        - Where do you agree with peers? Where do you push back?
        - What did they raise that reshapes your take?
        - What's your final position going into Orc's synthesis?
      post_to: "{{project_channel}}"
      persona: lens

  - id: synthesis
    actor: orchestrator
    action: synthesize
    params:
      sources: [phase.announce, phase.round_1, phase.round_2]
      template: |
        :memo: *Synthesis — {{brief_title}}*
        • Brief recap (1-2 sentences)
        • Per-lens position (one line each, drawn from round_2)
        • Points of agreement
        • Points of friction
        • Open questions for Pav
        • Recommended next action
      post_to: "{{project_channel}}"

  - id: handoff
    actor: orchestrator
    action: notify_pav
    params:
      channel: "#room-orchestrator"
      content: |
        Council review complete on {{brief_title}}.
        Summary in {{project_channel}}. Ball's with you.
```

**Execution semantics:**

- **Phases run sequentially.** Each phase completes before the next begins.
- **`actor: each_lens(scope)`** loops the phase's action over the lens scope. `parallelism: sequential` runs them one at a time; `parallel` would fire simultaneously (requires non-blocking Orc; v0.9).
- **`visibility`** determines what context the actor sees:
  - `brief_only` — the brief text, nothing else
  - `brief_plus_peer_responses` — brief + all prior-phase outputs from siblings in scope
  - `full_thread` — everything posted in the project channel during this flow
- **`persona`** — who posts the response in Slack. `lens` = each lens posts as itself; `orchestrator` = Orc's persona.
- **Flow runs logged** to `projects/{slug}/flow-runs/{run_id}/events.jsonl` with per-phase timing, outputs, errors.

**Trigger mechanism:**

```
Pav in #room-orchestrator:
  @Orchestrator run flow peer-review-2-round
    brief=council/BRIEF-harvester-paw-claw-handoff.md
    project=memory-hats

→ Orc validates flow exists, resolves inputs, instantiates a FlowRun,
  posts "Flow `peer-review-2-round` starting for memory-hats..."
→ Executes phases in sequence, posting status as each phase completes
→ Posts final synthesis + handoff when done
```

---

## MVP proposal — what ships first

**Phase A: Conversation routing (Layer 1)**
- Project-channel addressee routing (Route 4 full handler)
- Bot-message filter narrowed
- Per-addressee dispatch reusing `handleLensChannelMessage` internals
- ~200 lines, no new abstractions

**Phase B: First flow, hardcoded**
- One TypeScript function: `runPeerReview2RoundFlow({ briefRef, projectSlug })`
- Reads brief, discovers lenses in project, executes the 5 phases above
- Visibility enforced by building per-lens prompts with the right prior-phase outputs
- Triggered by a new action verb: `run_flow` with hardcoded `flow_id: peer-review-2-round`
- ~400-500 lines
- Hardcoded = no config parsing yet. One flow proves the shape before generalizing.

**Phase C: Non-blocking Orc (KNOWN-ISSUES #1)**
- Required for any sequential flow > ~10 minutes to be usable (Pav can't clarify mid-flow today)
- Pick one of the options on file (background mode, child process, or queue)
- ~larger lift, needs its own review

**Phase D: Flow template engine**
- YAML parser for flow templates
- Generic flow executor that drives any template conforming to the schema
- Library of templates at `world-bench/flows/`
- Pav or anyone can define new flows without code changes

**Shipping order recommendation:** A → B → C → D. A + B deliver the specific thing Pav asked for, fast. C unblocks reliable operation. D generalizes once the shape is proven. Don't build D first — the flow schema should be shaped by at least one working flow, not designed in the abstract.

---

## Open questions for the council

1. **Visibility semantics.** Is `brief_plus_peer_responses` the right visibility for round 2, or should lenses see `full_thread` (including prior Orc posts, status messages)? Soren's rule of thumb: lenses should see what a human in the room would see, nothing more.

2. **Parallelism deferral.** Should round 1 responses run sequentially (slow but works today) or parallel (requires Phase C first)? My instinct: sequential in v0.8, parallel in v0.9 once Orc is non-blocking. Lens responses aren't order-dependent in round 1 — visibility only matters in round 2 — so parallel is safe *in principle* once the infrastructure supports it.

3. **Flow triggering surface.** Is `@Orchestrator run flow X` the right surface, or should flows be first-class action verbs (`start_peer_review`, `start_consensus`)? Verb-per-flow is more discoverable for Pav but makes adding new flows a code change.

4. **Bot-message routing scope.** When we allow bot-authored messages through Route 3/4 routing, do we allow *any* bot to wake a lens (risking loops if two lenses address each other in sequence), or restrict to council members / project-attached lenses only? Needs a loop-detection mechanism if we're permissive.

5. **Persona for synthesis.** Should Orc's synthesis post as Orc (default) or as a synthetic "project lead" persona? No strong view; flagging for council.

6. **What other flows does Pav want?** He said "there might be other funnelling flows I'd want to try." Candidates:
   - **Consensus** (N rounds until silence or agreement)
   - **Debate** (pro/con pairs, rebuttal, moderator synthesis)
   - **Critique** (one lens proposes, others critique, proposer revises)
   - **Standup** (each lens reports, Orc tracks deltas since last standup)
   - **Cascade** (lens A output → lens B reviews → lens C finalizes)
   - ... worth asking Pav to sketch one more so the abstraction has two data points before we generalize.

---

## Known constraints (non-negotiable)

- **Existing routing contracts preserved.** Routes 1-3 keep working identically. Route 4 is the only change to existing routing; flow orchestration is new surface.
- **Lens session identity preserved.** Each round uses session resume (`runLensMeet` continuation mode) so lenses remember their prior work.
- **Visibility is enforced at context-injection time**, not by filtering Slack. Lenses never bypass visibility by reading the channel — they get the visibility their phase allows.
- **Flows are cancellable.** Pav can @Orc with `cancel flow` at any phase boundary. Mid-phase cancellation is nice-to-have but not MVP.
- **Flow runs are observable.** Every phase transition, lens invocation, and output is logged. Pav can replay a flow from its events.jsonl if needed.

---

## What I want from council

- **Structural signoff** on the two-layer split (routing / flow orchestration) and the MVP order (A→B→C→D).
- **Views on the open questions above.** Visibility semantics, parallelism timing, trigger surface.
- **Flow design critique.** Is peer-review-2-round the right first flow? Is the 5-phase shape right, or do we want explicit `critique`, `refine`, `consensus_check` phases as first-class primitives?
- **Red flags.** What's going to break? Where's the technical debt? What's a better abstraction I'm not seeing?

Once the shape is agreed, Spinner ships Phase A + B. Non-blocking Orc (Phase C) may deserve its own brief given its scope.

---

_State of play: conversation layer is the next infrastructure milestone after the hat. Pav's mental model — Slack as surface, substrate doing the work — is right but not yet implemented. This brief proposes the smallest build that realizes the mental model for one concrete flow, with a clean path to generalization._
