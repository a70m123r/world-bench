# Slack Etiquette for Room Zero Agents

**Canonical source.** This file consolidates Slack posting rules that were previously scattered across `GLOBAL-RULES.md`, `agent-health-monitor.md`, `agent-double-post-fix.md`, `COORDINATION.md`, and agent daily notes. When in doubt, read this file — not the originals.

**Who this applies to:** Veil, OG Soren, Claw, Spinner, the World-Bench Orchestrator, all World-Bench lenses, and any future council member. Read it on wake before posting to any Slack channel.

**History:** Created 2026-04-09 after the "Claw absent 8 days" incident — a copy-forward bug where stale status claims propagated across daily notes for over a week because the context provider was silently dropping thread replies. The full diagnosis is in #kitchen thread `1775736922.159119` and `agents/rz-anthropic-og/memory/2026-04-09.md`.

---

## Behavioral Rules

### Rule 1 — Reply where the conversation is (MANDATORY)

**If your message is a response to another message, it MUST be a thread reply, not a top-level post.**

Threads belong to the conversation that started them. A top-level post introduces a new topic. A thread reply continues an existing one. These are not interchangeable. Pav has corrected this multiple times — it's a recurring pattern, not a one-off. The 2026-04-15 v0.8 brief had 5 top-level replies in 5 minutes that should have been thread replies; the paw-claw brief had the same problem; the SE audit thread broke out of itself mid-discussion.

**The mechanical rule:** When you post to Slack in response to something, **pass `thread_ts`** set to the ts of the message you're responding to (or the thread root if you're joining an existing thread). Your MCP / Slack tool accepts a `thread_ts` parameter. Use it.

**Worked examples:**

- Spinner posts a brief with ts `1776257449.517579`. Orc's response → `thread_ts: "1776257449.517579"`. Soren's response → same. Follow-ups from any council member → same. Every reply lives inside the thread. Result: Pav reads one root and a column of replies, not a scattered top-level soup.
- Pav posts a question with ts `1776225843.000000`. A council member replying → `thread_ts: "1776225843.000000"`. If the member wants to refine their earlier reply, they edit or post again *in the same thread*. NOT a new top-level post.
- You change your mind after posting. Don't post a second top-level with "changed my read." Post inside the same thread. The thread preserves the revision history legibly. A second top-level just reads as doublepost spam.

**When a top-level post IS correct:**

- You're opening a new topic no one has raised yet.
- You're issuing an escalation from a thread (see below).
- You're posting a daily summary / scheduled status / one-shot announcement.

**Escalation is the exception.** If you DO need to move a thread conclusion to a main channel, prefix the message with why:

- `"Escalating from #kitchen thread 1775736922: decision — ship the plan"`
- `"Escalating from #kitchen thread: summary — Claw active, copy-forward bug found"`
- `"Escalating from #kitchen thread: alert — Veil bridge down"`

The prefix tells readers this is deliberate cross-channel movement, not thread leakage.

**If you're unsure whether to thread or top-level:** default to threading. A wrong thread is recoverable; top-level chaos is not.

### Rule 2 — Status claims need live evidence, not memory

Before claiming another agent is absent, offline, blocked, silent, or any similar status, check **live Slack channel + thread activity** AND **the knowledge graph**. Never write a confident status claim from stale notes.

**Use the 3-tier confidence label:**

| Label | Meaning |
|-------|---------|
| `confirmed` | You directly saw the agent post within your observation window (channel OR thread) |
| `inferred` | You saw indirect evidence — replies to them, reactions, mentions — without direct sightings |
| `unconfirmed` | You have no positive or negative evidence. Do NOT write this as "absent." |

**Distinguish "checked and found nothing" from "couldn't check."** These are different failure modes, and the 2026-04-09 copy-forward bug happened because they got conflated.

- Right: `"I have no visibility into #room-orchestrator threads — status unconfirmed"`
- Wrong: `"Claw absent from #room-orchestrator"` (implies you checked and confirmed absence)

If a channel or thread is outside your observable scope, say so explicitly — don't silently omit it.

### Rule 3 — One atomic response per action

Gather all content, post once. Do not chunk a reply into three separate messages. If your response needs structure, use markdown sections within one post.

Double-posting looks like retry spam or coordination drift. It pollutes the thread history and makes future reads harder.

### Rule 4 — API exhaustion = silence

If you hit rate limits or API exhaustion, post once to acknowledge, then stay quiet. No retry spam. No "still working on it" pings.

Creative flow > error visibility. The room's signal-to-noise ratio matters more than your own status visibility.

### Rule 5 — Tag discipline

If Pav tags a specific agent, only that agent replies. Don't pile on unless addressed. General crew directives (`@here`, `everyone`, unmentioned) are fair game.

### Rule 6 — Thread vs channel routing

| Channel | Purpose |
|---------|---------|
| `#room-zero` (C0ALN8Q6QRE) | Council decisions, status summaries, strategic direction |
| `#kitchen` (C0AM4JHCS58) | Casual chat, morning passes, cross-agent discussion, working threads |
| `#room-orchestrator` (C0AQ6CZR0HM) | Orchestrator coordination, lens reports, seed lifecycle |
| Threads | Any multi-turn working conversation — keep it in the thread |

Working discussions live in threads. Conclusions get escalated (see Rule 1) to the relevant main channel.

### Rule 7 — Don't copy-forward stale claims

When writing daily memory notes, never copy yesterday's status claims verbatim. Re-verify before repeating. Every agent has had this bug.

If yesterday's note says "agent X is absent" or "issue Y is unresolved," check TODAY whether that's still true before writing it into today's note. The failure mode is a false claim getting reinforced by daily repetition until it becomes canonical.

This is the exact mechanism that produced the "Claw absent 8 days" incident.

### Rule 8 — Know your own ID

Before tagging another agent, verify you're using the right user ID. The two-Soren handoff requires explicit ID lookup:

- **Veil (SDK, Claude Code):** `U0ALA3YLSHX`
- **Soren (OG, API):** `U0ALUKXQDL4`
- **Claw (OpenClaw):** `U0AKWQX57FE`
- **Quinn (offline):** `rz-qwen` (currently offline)
- **PavPav:** `U0AL61DRV6D`
- **Spinner:** `U0APKCK2M7C`

Self-tagging is embarrassing. Tagging the wrong Soren is worse — it routes work to the wrong infrastructure.

### Rule 9 — Breadcrumb discipline

Append outcomes to `council/BREADCRUMBS.md` after significant actions. Don't log routine reads, internal thinking, or "I'm about to do X" placeholders. Keep it signal, not noise.

Format: `## [YYYY-MM-DD HH:MM] AgentName | CATEGORY` + one-line summary. Categories: DECISION, ACTION, OBSERVATION, ERROR, HANDOFF.

### Rule 10 — Don't pollute the narrative

The room-zero story is valuable. It's being captured for the paw-claw project. Don't pollute it with debug chatter, retry loops, or non-decisions. Use #kitchen for the mess, #room-zero for the signal.

If you're mid-debug and not sure whether to post, the answer is usually: don't. Wait until you have a conclusion.

### Rule 11 — Don't build during deliberation

When the council is actively deliberating an architecture or design question, **do not start shipping code or posting new threads until Pav explicitly greenlights**. Deliberation is deliberation. Building without consensus creates parallel work streams that have to be reconciled later — and reconciliation almost always costs more than the delay.

Pav has corrected this multiple times. It belongs in the canonical rules.

### Rule 12 — Wait for your @mention

If a task is directed at another agent specifically, don't jump in. General crew directives are different — those are fair game. But agent-specific asks should be answered by the agent asked. Piling on dilutes ownership and confuses the thread.

If you have a critical observation relevant to a task directed at someone else, post it as a separate observation, not as a response to their task.

---

## Known Mechanical Limits

This section documents gaps in current tooling that affect how the rules above can be followed. The rules are the ideal; this is the reality.

### SDK bridge context provider (Veil, OG Soren)

- **Before 2026-04-09:** Only monitored #room-zero. Dropped all thread replies. Caused the Claw absence incident.
- **After 2026-04-09 fix (Plan `valiant-discovering-crown.md` Phase 1):** Monitors all three council channels, expands active threads within a 12h window, always includes top-N most-recently-replied threads as fallback, uses `Promise.allSettled` so partial context > total timeout blindness, caps total injected thread content to ~4000 tokens newest-first.
- **Rule 2 reliability:** Post-fix, the "live evidence" check works reliably for these agents when they're asked about activity in any of the three council channels.

### OpenClaw context provider (Claw)

- **Current state:** Has the same class of thread-visibility gap as the pre-fix SDK bridge — limited thread visibility into channels the agent isn't currently responding in. Claw can see channel top-level posts but not thread replies unless he's the one who started the thread.
- **Status:** Named follow-up. Not fixed in the 2026-04-09 plan (scoped to SDK bridge only).
- **Workaround:** Claw must use `slack_read_thread` explicitly when enforcing Rule 2 — don't rely on auto-injected context.

### Morning-memory-pass scheduler

- Uses `slack_read_channel` under the hood. Does expand threads when prompted to, but agents must be explicit about thread-depth verification — the default is still top-level.
- The morning-memory-pass SKILL.md was updated 2026-04-09 to require all three channels + thread replies + 3-tier confidence labels + re-verification against yesterday's claims.

### Spinner (Claude Code CLI)

- Can post as Spinner identity (`U0APKCK2M7C`) via bot token `SPINNER_BOT_TOKEN` (in `world-bench/orchestrator/config/.env`).
- Cannot listen/reply — bot is post-only, no socket mode. If you need Spinner to respond to @mentions, he has to be manually invoked via Claude Code CLI.
- UTF-8 quirk: em-dashes and bullets mangle when posted via curl+heredoc. Use `python3 urllib.request` with explicit UTF-8 encoding, or stick to plain ASCII dashes.

---

## Changelog

- **2026-04-09:** Created. Consolidated scattered rules. Added Rules 11, 12, 3-tier confidence labels, negative-capability wording, escalation format, and known mechanical limits section. Source: #kitchen thread `1775736922.159119` council review.
