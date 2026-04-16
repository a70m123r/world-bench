# Known Issues

## 1. Orchestrator blocks during lens renders (HIGH — UX)
**Filed:** 2026-04-14
**Symptom:** While a lens is rendering (3-7 minutes), the Orchestrator can't process Slack messages. Pav sends messages, gets silence until the render finishes.
**Root cause:** `adapter.spawn()` is `await`ed inside `converse()`, which blocks the event loop. No other messages can be processed until the SDK query completes.
**Impact:** Pav can't clarify, cancel, or redirect during renders. The Orchestrator also fires premature renders because it misinterprets Pav's clarification messages as go-aheads (they arrive after the render starts, not before).
**Fix options:**
  - (a) Background renders — use the SDK's background mode, poll for completion
  - (b) Separate process — fork lens execution into a child process, keep the message handler responsive
  - (c) Queue model — render requests go to a queue, executor process pulls and runs, Orchestrator stays responsive
**Priority:** v0.8 — doesn't block pipeline work but degrades the human experience significantly.

## 2. ContextProvider "not_in_channel" (LOW — cosmetic)
**Filed:** 2026-04-14
**Symptom:** `[ContextProvider] Context fetch failed: An API error occurred: not_in_channel` on every converse() call.
**Root cause:** Context provider tries to fetch channel history but gets a scope/membership error. The bot IS a member (verified via conversations.info) — likely a scope issue on a specific API endpoint.
**Impact:** Orchestrator works without channel context. No functional impact, just a noisy log warning.
**Fix:** Investigate which channel/endpoint is failing. Low priority.

## 3. Signal Extractor can't read its own lens channel (MEDIUM)
**Filed:** 2026-04-14
**Symptom:** SE says "the bot token doesn't have the channels:join scope, so I can't join #wb-lens-signal-extractor to read it."
**Root cause:** The lens runs with the Orchestrator's MCP tools, not with the Slack bot's own token. The MCP slack tools route through the Slack connector which has different permissions.
**Impact:** Lenses can't read their own channel history during conversation mode. They're blind to what was said about them between renders.
**Workaround:** The context injection (Gate 2) reads channel history FOR the lens and injects it into the prompt. The lens doesn't need to read the channel directly — it gets the last 10 messages via context.

## 6. Lenses post directly to Slack via their own tokens, bypassing Orc persona wrapping (MEDIUM)
**Filed:** 2026-04-15
**Symptom:** Observed in `#wb-proj-memory-hats` at 21:54–21:55 BST. Pav said "Harvester: can you post your questions and pushbacks here to #wb-proj-memory-hats". Harvester interpreted this as an active instruction, tried `conversations.postMessage` via its own curl/Bash access, got `not_in_channel` + `channels:join` scope error for the target channel, and fell back to posting in `#room-orchestrator` (the only channel its token can reach — it's scoped for *reading* during harvest). The fallback post showed up under the wrong display name ("Veil") because the posting token's app name resolved there with no `username` override.
**Root cause:** Lenses that have Bash + curl (for their own work — e.g. Harvester harvesting Slack) can reach the Slack API directly. The system prompt doesn't distinguish "curl for reading" from "curl for posting." When Pav phrases a request as "post X to channel Y," the lens reaches for the tool instead of producing text and letting Orc's routing post it as the lens persona via `chat:write.customize`.
**Impact:** Wrong persona attribution (display name doesn't match the lens), wrong channel (lens token only reaches its harvest target), meta-commentary notes from the lens explaining why it couldn't post where asked. Confusing for readers. Not catastrophic — the conversation still works, it just looks cheeky.
**Workaround:** Phrase requests as "give me your full questions and pushbacks, concisely" instead of "post your questions to channel X." The lens responds with text; Orc's Phase A routing posts it as the lens persona in the project channel automatically.
**Fix options:**
  - (a) *Prompt patch* — add to base lens prompt: "Do NOT post to Slack directly via curl/MCP/slack tools. Your output is automatically posted by the Orchestrator under your lens persona in the channel the conversation is in. When asked to post something, just produce the text." ~10 lines in `agents/base-lens-agent.ts`.
  - (b) *Scope narrowing* — give lenses a read-only Slack token that can't post at all. Blocks the bug at the auth layer but requires token rotation + config updates.
  - (a) then (b) when doing broader token/scope hardening.
**Priority:** MEDIUM. Workaround works. Pav deferred 2026-04-15 — rephrase on his side for now, patch later.

---

# Wish List

## 4. Hot-reload for code changes (MEDIUM — DX)
**Filed:** 2026-04-14
**Problem:** Every Spinner code fix requires killing and restarting the orchestrator. During active debug sessions this means 5-10 restarts per session, each losing in-memory state (pending meet sessions, thread bindings). Pav has to manually restart from the terminal each time.
**Current workaround:** Spinner batches fixes and commits as one, Pav restarts once to pick up everything. Works but requires coordination.
**Fix options:**
  - (a) `fs.watch` on source files + dynamic `import()` to hot-reload business logic while keeping the Slack connection alive
  - (b) Process manager (like nodemon) that auto-restarts on file change — simpler but still drops state
  - (c) Separate the Slack connection (persistent) from the business logic (reloadable) into two processes
**Priority:** v0.8 — quality of life for the dev loop, not blocking production.

## 5. Confirm before render (LOW — governance)
**Filed:** 2026-04-14
**Problem:** The Orchestrator fires renders on ambiguous Pav messages without confirming intent. Soren: "this isn't just a UX bug — it's a consent violation in the governance chain."
**Fix:** One line in the system prompt: "Before executing a render, confirm the instruction with the user if there's any ambiguity."
**Priority:** Quick win, should ship with next prompt patch.

## 7. Thread discipline — prompt patches insufficient, need router-level enforcement (MEDIUM — DX)
**Filed:** 2026-04-15
**Problem:** On 2026-04-15 Spinner sharpened `SLACK-ETIQUETTE.md` Rule 1 and added threading rules to Orc's system prompt + blockquote reminders to OG Soren / Veil / Claw instruction files. Within a few hours, Soren posted two more top-level replies (22:23:42 and 22:25:14 BST) reviewing Orc's Harvester answers — exactly the pattern the patch was supposed to prevent. First post said "SE classifies, not Harvester"; second post refined to "Harvester rule-tags, SE semantic-overrides." That revision should have been a thread reply under Orc's post. Two top-level peers instead.
**Root cause:** Prompt rules are advisory. Agents know the rule; under time pressure or when they want to refine, they default to posting fresh rather than scrolling up and threading. Soft guidance doesn't survive contact with agent behavior.
**Fix options:**
  - (a) *Router-level enforcement* (the real fix) — when Orc (and any agent via Slack bridge) posts a response to an existing message, the posting helper auto-defaults `thread_ts` to the triggering message's ts unless the response is explicitly marked as a new topic. Takes the decision out of the agent's hands. ~10-20 lines in each posting path.
  - (b) *Post-hoc consolidation* — script that scans recent channel activity, detects clusters of top-level messages on the same topic, and reposts as a digest thread (like Spinner did manually on 2026-04-15 for the v0.8 + paw-claw briefs). Stopgap, not a fix.
**Priority:** MEDIUM. Cumulative cost — every top-level instead of threaded reply costs Pav ~30s of reading effort to reconstruct the conversation. Over 20+ replies/day, meaningful. Not blocking, worth doing during the v0.8 conversation-layer work since that's touching the same posting paths anyway.

**Update 2026-04-15 (Veil + Spinner synthesis failure):** The cost isn't just Pav-readability. Two additional failure modes observed:
- *Data contamination* (Veil): once the Harvester expands to project channels, every top-level Orc / council chain-of-thought post enters the normalized event stream. The SE has to classify them; the hat has to decide whether to surface them. Thread replies stay grouped with their parent; top-level posts fragment into orphan events. This degrades downstream fidelity across hats / analytics / narrative.
- *Synthesis bias* (Spinner): when some council members thread correctly and others post top-level, a shallow channel read over-weights the top-level-posting voices. On 2026-04-15 Spinner missed Claw's and Veil's threaded replies on the Harvester render deliberation and synthesized a recommendation over-weighted toward Soren's two top-level posts. Pav had to point at the thread. Agents (and humans) that only scan the channel surface inherit the same bias.
Both failure modes get fixed by the same mechanism (router-level `thread_ts` auto-default). The incident reinforces priority — this is a data-integrity issue, not just UX.
