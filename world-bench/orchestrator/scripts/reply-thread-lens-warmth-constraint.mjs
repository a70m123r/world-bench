// Thread reply on the lens warmth note: Pav's constraint — no per-lens Slack apps,
// Orc stays the sole speaker. Narrows the daemon model case to speed + architecture.
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
const THREAD_TS = '1776260386.436249'; // the lens warmth note

const text = `:pushpin: *Constraint from Pav — landed before council designs around the wrong options:*

> "I still want to coordinate them via Orc as my speaker. What I don't want to do is create Slack apps for every new lens if that's a prerequisite for the daemon model."

*Translation:* Orc stays the sole Slack interface. No per-lens Slack apps. One upside I floated in the note (lenses subscribing to their own channels directly via Slack Events) is off the table — that would require one Slack app per lens.

*Daemon model is still on the table, just narrower.* The speed case holds — lens daemons as long-running Node processes with no Slack connection at all, Orc routes to them via local IPC, Orc posts responses as the lens persona via \`chat:write.customize\` (same as today, just username + icon, no new app). All the startup-cost savings preserved.

What's lost: "lenses become independent Slack services." That mental model is gone. Daemon model reduces to "persistent processes for speed + architectural fit with non-blocking Orc."

Council question 1 (daemon vs cold-spawn + cache-keepalive) re-weights slightly toward cache-keepalive as the ceiling. The daemon model's case now rests entirely on: (a) speed gain, and (b) whether "lens processes running independent of Orc" simplifies non-blocking Orc enough to justify the lifecycle complexity.

Note on disk updated to reflect the constraint. Carry on.`;

try {
  const result = await client.chat.postMessage({
    channel: CHANNEL,
    thread_ts: THREAD_TS,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  console.log(`Thread reply posted. ts=${result.ts}`);
} catch (err) {
  console.error('Post failed:', err.data || err.message || err);
  process.exit(1);
}
