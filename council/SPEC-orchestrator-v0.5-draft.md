# Orchestrator v0.5 Specification — DRAFT

**Author:** Spinner, incorporating Pav's architecture decisions + council review feedback
**Status:** DRAFT — awaiting council review
**Supersedes:** Extends v0.4 (v0.4 remains the baseline, v0.5 adds to it)

---

## What v0.5 Adds

Three pillars, in priority order:

### 1. Stem Cell Permission Lifecycle

Permissions are discovered through use, not prescribed upfront.

**Lifecycle:**

| Phase | Description | Tool Access |
|-------|-------------|-------------|
| **Stem** | Newborn lens, undifferentiated | Sandbox: Read, Glob, Grep, WebSearch, WebFetch, Agent. No Bash/Write/Edit. |
| **Shaping** | Pav is interacting, lens is taking form | Sandbox + any tools granted via elevation loop |
| **Hardened** | Lens has stabilized, permissions locked | Only observed tools from shaping phase |
| **Dormant** | Shelved with frozen permission set | Reactivates scoped. Orchestrator flags if lens hits a wall on first run, offers re-shaping. |

**Sandbox ceiling (stem cell hard limits):**
- No `Bash` — shell access requires explicit grant
- No `Write` / `Edit` — file modification requires explicit grant
- Full read access (Read, Glob, Grep)
- Full web access (WebSearch, WebFetch)
- Agent spawning allowed

**Elevation loop (Orchestrator ↔ Lens, before escalating to Pav):**

1. Lens hits a permission wall — tries to use a denied tool
2. Orchestrator evaluates: does this tool fit the lens's purpose?
   - Read tools → always grant (safe)
   - Web tools → grant if purpose involves research/search/fetch
   - Write/Edit → grant if purpose involves creation/writing/drafting
   - Bash → almost always escalate to Pav (too powerful for auto-grant)
3. If clearly aligned with purpose → grant silently, log it, lens continues
4. If clearly misaligned → deny, log it, lens works within current toolset
5. If ambiguous → escalate to Pav: "Joke Writer requested Bash access. Purpose: 'Write jokes.' Grant?"
6. Pav decides → Orchestrator applies and logs

**Hardening trigger:**
- Orchestrator detects tool usage convergence: same tool set across 3 consecutive runs
- Orchestrator prompts Pav: "This lens has used WebSearch and WebFetch across 3 runs — want to lock it?"
- Pav decides. Human trigger, machine detection.

**Break glass:**
- Hardened lens hits a tool wall mid-run → Orchestrator catches the denial
- Orchestrator evaluates (same elevation loop) → grants, denies, or escalates
- If lens has drifted far enough from original shape, Orchestrator can offer to reopen for shaping

**Data source:** PostToolUse hooks already collect tool usage per-lens per-run in `events.jsonl`. No new infrastructure needed — the permission manager reads existing event data.

### 2. Structured Output for Command Routing

Replace the JSON-in-system-prompt pattern (the v0.4 HIGH severity issue) with SDK tool-use routing.

**Current (fragile):**
- System prompt tells Claude to respond in JSON
- Greedy regex extracts JSON from response
- Falls back to plain chat if parse fails → "make me a project" becomes small talk

**Proposed:**
- Define Orchestrator actions as SDK tools: `create_project`, `list_status`, `shelve_lens`, `rerun_lens`
- Claude uses tool_use to express intent → structured, typed, no parsing
- Conversational text goes through normal assistant messages
- Both can coexist in a single response: chat text + tool call

**Benefits:**
- No JSON parsing fragility
- New actions added as new tools, not system prompt edits
- Claude naturally decides when to chat vs when to act

### 3. `resume(id, newContext)` — Lens State Preservation

**Current (v0.4):** Iteration = kill lens and respawn with old output as context. Lens state is thrown away. Each invocation starts cold.

**Proposed:** Resume a lens from where it left off, injecting new context (Pav's feedback, new data from another lens) into the running conversation.

**Implementation options (for council to evaluate):**
- **A. SDK session resume** — use `options.resume` with the lens's session ID + new prompt. SDK handles state. Simplest.
- **B. Checkpoint + replay** — save lens conversation state to disk, reconstruct on resume. More control, more code.
- **C. Hybrid** — SDK resume for short iterations, checkpoint for cross-session persistence.

**Recommendation:** Option A for v0.5. It's the smallest change — the SDK already supports `resume`. We just need to persist lens session IDs (which we already do for the Orchestrator's own sessions).

---

## What v0.5 Does NOT Include

| Component | When |
|-----------|------|
| Lens-to-lens direct mesh | v0.6. Orchestrator still mediates. |
| Session compaction for long-running lenses | v0.6. Token budget management. |
| Concurrency > 1 | When Claude Max rate limits allow. |
| World-Bench UI / Canvas | When Slack hits its limits. |
| Automated Bridge | When the manual loop proves out. |
| ModelRouter | When we need a second model. |

---

## Implementation Plan

| Step | What | Files |
|------|------|-------|
| 1 | Permission types + sandbox constants | `agents/types.ts` |
| 2 | Permission manager (elevation loop, hardening, break glass) | `orchestrator/permission-manager.ts` (new) |
| 3 | PreToolUse hook for permission enforcement | `orchestrator/agent-adapter.ts` |
| 4 | Effective tools resolution at spawn time | `orchestrator/lens-manager.ts` |
| 5 | Stem cell defaults on lens creation | `orchestrator/index.ts` |
| 6 | Structured output — define action tools | `orchestrator/index.ts` |
| 7 | Lens session persistence for resume | `orchestrator/lens-manager.ts` |
| 8 | Test: elevation loop, hardening trigger, break glass | Manual test |
| 9 | Council review of running system | Post to #room-orchestrator |

---

## Open Questions (for council)

1. **Sandbox ceiling:** Is denying Bash/Write/Edit at stem the right default? Or should Write be allowed (lenses often need to save drafts to workspace)?
2. **Elevation auto-grant scope:** Should the Orchestrator ever auto-grant Bash? Current proposal: only if purpose explicitly mentions execution/scripting. Is that too permissive or too restrictive?
3. **Hardening trigger:** 3 consecutive runs with stable tool usage — is that the right threshold? Too aggressive? Too slow?
4. **Structured output:** Tool-use routing vs JSON with better parsing — which does the council prefer?
5. **Resume:** Option A (SDK resume), B (checkpoint), or C (hybrid)?

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.5-draft | 2026-04-05 | Spinner | Initial draft. Permission lifecycle, structured output, lens resume. Incorporates council feedback from v0.4 review + claw-code analysis. |
