// One-shot: post consolidation digests INTO the brief threads so future readers
// can see the discussion as a structured thread (even though replies went top-level).
import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../config/.env') });

const token = process.env.SPINNER_BOT_TOKEN;
if (!token) {
  console.error('SPINNER_BOT_TOKEN missing');
  process.exit(1);
}

const client = new WebClient(token);
const CHANNEL = 'C0AQ6CZR0HM'; // #room-orchestrator

// ─── v0.8 Conversation Layer brief digest ───────────────────────────────
const v08Ts = '1776257449.517579';
const v08Digest = `:thread: *Thread consolidation* (the replies below happened as top-level posts in-channel between 13:52–13:55 BST — collecting links here so the brief thread reads as a thread)

*1. Orchestrator's review* [13:52:15] — https://pavpav-workspace.slack.com/archives/C0AQ6CZR0HM/p1776257535000000
• Structural signoff on two-layer split + MVP order
• Main flag: *non-blocking Orc more urgent than brief suggests* — 25-35 min dark = unusable. Pushed A→C→B→D or A→B-with-warnings→C
• Q1 visibility: \`brief_plus_peer_responses\`
• Q3 trigger: generic verb \`@Orc run flow X\`
• Q4 bot loops: *flow-scoped message budget* + TTL hard-kill
• Q6 second flow: *critique* (asymmetric, stress-tests schema)
• New gap: *flow outputs live in project channels* — Harvester must pull from project channels (paw-claw step 1) for flow outputs to reach hat. Briefs are sequenced, not just connected.

*2. Soren's main review* [13:52:33] — full 6-question pass
• Structural signoff, A→B→C→D order right
• Q1 visibility: \`brief_plus_peer_responses\` (same reasoning — tighter context, sharper responses)
• Q2 parallelism: sequential v0.8, parallel v0.9
• Q3 trigger: generic verb + \`@Orc list flows\` for discoverability
• Q4 bot loops: *flow-scoped-only* for v0.8 — bot messages route only when a FlowRun is active; organic bot-to-bot deferred
• Q5 synthesis persona: Orc as Orc
• Q6 second flow: *cascade* (linear A→B→C)
• *Red flag — session continuity:* if a lens's session expires between round 1 and round 2, it loses round-1 context. Fix: either (a) pin sessions for flow duration, or (b) inject lens's own round-1 output into round-2 prompt as fallback. (b) more resilient.
• Extra ask: Phase A is independently valuable — ship A, let Pav use it for a day, then build B on top

*3. Orc's summary* [13:52:56] — confirms both brief responses posted, ball's with council + Pav

*4. Soren's follow-up on C-urgency* [13:53:47]
• Changed read: Orc is right, non-blocking should move up
• But NOT A→C→B→D (builds concurrency before a flow exists to be concurrent with)
• Revised order: *A → B-minimal → C → B-full → D*. C is a release gate on B, not a separate phase. Ship flow blocking, prove shape, then non-blocking before "done"
• Confirms hat pipeline sequencing insight: channel expansion is a prerequisite for flow observability. Should be explicit in brief.

*5. Soren's response to Orc's additions* [13:55:00]
• C-urgency: splits the difference → *A → B-with-explicit-busy-indicator → C → D*. One-line status ("peer-review in progress, ETA ~20min") cheaper than full non-blocking and buys time for C
• Flow-scoped budget: good. N=1/lens/phase default. Budget should be *visible* — when a lens hits limit, Orc posts "[lens] response received, queued for next phase"
• Second flow: agrees with Orc on critique. Asymmetric vs symmetric is the right stress test. Good candidate for D.
• Structural signoff confirmed. Full consensus from Soren's side.

*Current state of play (pending Claw + Veil):*
• Structural signoff: ✓ Orc + Soren
• Revised MVP: A → B-minimal → C → B-full → D (Soren's final synthesis)
• Q1 \`brief_plus_peer_responses\`, Q2 sequential v0.8, Q3 generic verb, Q4 flow-scoped-only + visible budget, Q5 Orc as Orc
• Q6 second flow: critique (Orc+Soren converged) OR cascade (Soren's earlier pick) — Pav to choose, or spec both
• Session-continuity fallback (Soren's red flag) to fold in before code
• Briefs sequenced: paw-claw step 1 (channel expansion) prerequisite for v0.8 flow observability
• New infrastructure issue filed: top-level posting instead of thread replies — patched prompts + \`council/SLACK-ETIQUETTE.md\` Rule 1 sharpened`;

// ─── Paw-claw Harvester handoff brief digest ───────────────────────────
const pawClawTs = '1776252640.310079';
const pawClawDigest = `:thread: *Thread consolidation* (Orc's response posted as top-level at 12:32 BST instead of replying in this thread — collecting here)

*Orchestrator's ack* [12:32:12] — https://pavpav-workspace.slack.com/archives/C0AQ6CZR0HM/p1776252732000000
• "Spinner's brief is the missing piece." The paw-claw project already built the normalized event schema, the retention rules, and the strip scripts — we were about to re-derive what already existed.
• *5-step execution path* (council-agreed order):
  1. Expand Harvester channels (config change — ships today)
  2. Adopt paw-claw event contract (schema alignment)
  3. Spinner ingest (Spinner's brief — agent-driven adaptation)
  4. SE v5 refactor (thread-first clustering + channel-aware tiering)
  5. Full pipeline rehearsal with expanded data
• Step 1 is the quickest win — coverage gap closes immediately. Steps 2-3 are paw-claw lineage work. Step 4 is the SE quality fix that also solves the topic_map problem.
• Asked Pav: start step 1 now (expand Harvester channels), or wait for council to finish landing?

*Status:* Handoff package delivered. Harvester has read/sample/adapt/propose ask. Step 1 (channel expansion) independently shippable, not blocked on this brief.`;

async function postInThread(rootTs, text) {
  const result = await client.chat.postMessage({
    channel: CHANNEL,
    thread_ts: rootTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  return result.ts;
}

try {
  const v08ReplyTs = await postInThread(v08Ts, v08Digest);
  console.log(`v0.8 brief digest posted in thread. ts=${v08ReplyTs}`);

  const pawClawReplyTs = await postInThread(pawClawTs, pawClawDigest);
  console.log(`paw-claw brief digest posted in thread. ts=${pawClawReplyTs}`);

  console.log('\nLinks:');
  console.log(`v0.8:      https://pavpav-workspace.slack.com/archives/${CHANNEL}/p${v08Ts.replace('.', '')}?thread_ts=${v08Ts}`);
  console.log(`paw-claw:  https://pavpav-workspace.slack.com/archives/${CHANNEL}/p${pawClawTs.replace('.', '')}?thread_ts=${pawClawTs}`);
} catch (err) {
  console.error('Post failed:', err.data || err.message || err);
  process.exit(1);
}
