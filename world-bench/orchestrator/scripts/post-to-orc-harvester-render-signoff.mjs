// Post to Orc (top-level, @mention) in #room-orchestrator: council signed off,
// here's the locked contract for the Harvester render, relay and render.
// Orc was held out of the council deliberation round per Pav's direction;
// this is the handback.
import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../config/.env') });

const token = process.env.SPINNER_BOT_TOKEN;
if (!token) { console.error('SPINNER_BOT_TOKEN missing'); process.exit(1); }

const client = new WebClient(token);
const CHANNEL = 'C0AQ6CZR0HM';
const ORC = 'U0AQF829HPF';
const DELIBERATION_THREAD = '1776288109.506279';

const text = `:white_check_mark: <@${ORC}> — council signoff complete on the Harvester render. Handing back.

*Deliberation thread* (all three signed off in-thread, per Pav's direction): https://pavpav-workspace.slack.com/archives/C0AQ6CZR0HM/p${DELIBERATION_THREAD.replace('.', '')}?thread_ts=${DELIBERATION_THREAD}

*Locked contract — relay this to Harvester verbatim and render:*

*Normalized event shape (flat, no wrappers):*
• \`event_id\`, \`source_type\`, \`source_id\`, \`session_or_thread_id\` (grouping *hint*, not a cluster contract — Claw's precision)
• \`ts\`, \`ingested_at\` (separate from source ts), \`author\`, \`author_display\`, \`text\`, \`kind\`, \`channel\`
• \`classification: null\` at ingest (SE classifies downstream — Claw + Veil + Orc majority; Soren's hybrid on record as minority)
• \`content_hash\` = SHA-256(text) for textual dedup
• \`event_hash\` = SHA-256(source_type + source_id + session_or_thread_id + ts + author + text) for event identity, canonicalized with sorted keys (Veil's implementation note)
• \`import_method\` enum extended with \`"live_harvest"\`
• *Nullable-from-day-one:* \`parent_event_id\`, \`provenance_ref\`, \`visibility\`, \`channel_tier\`, \`artifacts\` (Claw's caution — don't stall render if some sources can't supply)

*Load-bearing constraint* (must appear in the Harvester's brief, not as commentary — Soren's emphasis):
> *"Don't cluster in storage; do require grouping before interpretation."*

*Harvester amendments — all approved:*
• Drop path: \`world-bench/intake/spinner/\`
• Single merged \`harvest.json\` (all sources, one file)
• Subprocess import of \`strip-all-spinner.py\` (not a fork)
• \`import_method: "live_harvest"\` added to enum

*Spinner session ingest — session-chunk definition (Veil's proposal, adopted):*
• One event per user→assistant turn boundary (one logical unit)
• Compaction events are their own \`kind\`
• Session files: append-only, compaction does NOT rotate the UUID, new session = new file in the same cwd-hash directory. Empirical evidence in Spinner's session-growth note in the deliberation thread.

*Watermark (Harvester's call per Veil, grounded in Spinner's evidence):*
• Primary: \`{file_path: byte_offset}\` across all session files in the directory
• Sanity check: \`last_line_uuid\` (not main cursor, just a validation cross-check)
• Fallback to \`(session_id, last_uuid)\` only if rotation behavior proves unexpected

*Contract framing* (Veil's flag to carry into the render):
This is a *rewrite* of the Harvester's output layer, not an extension. Current \`harvest.json\` shape is being replaced entirely. SE v5 refactor picks up the new contract in the same cycle — no backward compat period.

---

*Execution note:* Harvester already has the paw-claw brief + this context in its session (session \`4d1f4592\`). You don't need to re-inject the full brief; a short "go-ahead with these locked decisions" relay is enough, then render.

*Thread discipline:* any follow-up on this render (questions, escalations, status) stays *in a thread*. If Harvester needs clarification mid-render, it escalates via \`escalation.json\` and we reply threaded. No top-level chain-of-thought posts — reinforced by \`KNOWN-ISSUES.md\` #7 and the sharpened \`SLACK-ETIQUETTE.md\` Rule 1.

Ball's with you. Relay and render when ready.`;

try {
  const result = await client.chat.postMessage({
    channel: CHANNEL,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  console.log(`Posted to Orc. ts=${result.ts}`);
  console.log(`https://pavpav-workspace.slack.com/archives/${CHANNEL}/p${result.ts.replace('.', '')}`);
} catch (err) {
  console.error('Post failed:', err.data || err.message || err);
  process.exit(1);
}
