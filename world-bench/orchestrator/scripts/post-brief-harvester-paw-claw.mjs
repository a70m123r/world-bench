// One-shot: post the Harvester paw-claw handoff brief to #room-orchestrator as Spinner.
// Run: node scripts/post-brief-harvester-paw-claw.mjs
import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../config/.env') });

const token = process.env.SPINNER_BOT_TOKEN;
if (!token) {
  console.error('SPINNER_BOT_TOKEN missing from world-bench/orchestrator/config/.env');
  process.exit(1);
}

const client = new WebClient(token);
const CHANNEL = 'C0AQ6CZR0HM'; // #room-orchestrator
const ORC = 'U0AQF829HPF';
const SOREN = 'U0ALUKXQDL4';
const VEIL = 'U0ALA3YLSHX';
const CLAW = 'U0AKWQX57FE';

const text = `:package: *BRIEF — Paw-Claw → Harvester Handoff*

<@${ORC}> <@${SOREN}> <@${VEIL}> <@${CLAW}>

Packaged the handoff per Pav's direction. Full brief on disk:
\`council/BRIEF-harvester-paw-claw-handoff.md\`

*What it covers:*
• Why the handoff — coverage gap (only #room-orchestrator harvested) + Spinner session data (32MB, off-pipeline, contains v0.7 / hat wiring / root-cause / fixes that never hit Slack)
• Existing assets to reuse (not reinvent): \`council/paw-claw/scripts/strip-all-spinner.py\`, \`SPEC-retention-exceptions.md\`, \`schema/normalized-event.json\` (15 fields, already matches Claw's proposed contract)
• Primary target: the live session at \`C:\\Users\\Admin\\.claude\\projects\\D--OpenClawWorkspace-world-bench\\39e34fd4-90a8-4129-97ed-b19aeebaa269.jsonl\` (32MB, active)
• What Harvester is asked to do: *read, sample, adapt, propose* — agent-driven adaptation, not a spec handed down
• Hard constraints from council consensus (Shape 3 + pre-cluster): one event contract, retention before synthesis, provenance on every event, don't carry March data itself

*Open question for Harvester:* drop path — \`world-bench/intake/spinner/\` (operational) vs \`archive/paw-claw/raw/spinner/\` (archival)? Soren flagged this as a lineage decision.

*Not in this brief:* Slack channel expansion (step 1 of the council's 5-step order) — that's a Harvester config change, separate from the Spinner ingest work. Shout if you want it folded in.

Handing to the Harvester. Council's welcome to weigh in — this is step 3 of the agreed execution order, not blocking step 1.`;

try {
  const result = await client.chat.postMessage({
    channel: CHANNEL,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  console.log(`Posted as Spinner. ts=${result.ts}`);
  console.log(`https://pavpav-workspace.slack.com/archives/${CHANNEL}/p${result.ts.replace('.', '')}`);
} catch (err) {
  console.error('Post failed:', err.data || err.message || err);
  process.exit(1);
}
