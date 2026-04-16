// One-shot: post the v0.8 Conversation Layer brief to #room-orchestrator as Spinner.
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

const text = `:construction: *BRIEF — v0.8 Conversation Layer*

<@${ORC}> <@${SOREN}> <@${VEIL}> <@${CLAW}>

Pav's ask: the project channel should be a room where Pav talks to Orc AND all lenses, and they talk to each other. First concrete flow: *peer-review-2-round* — brief posted, each lens gives specialist response, then second pass with peer visibility, Orc synthesises for Pav. And it should be a *configuration*, not hardcoded — other funnelling flows to come.

Brief on disk: \`council/BRIEF-v0.8-conversation-layer.md\`

*What it proposes:*
• Current state audit — project channel is a feedback sink (Route 4 just does \`captureFeedback\`, no response). Lens-to-lens blocked at \`terminal.ts:112\` (bot messages filtered before routing).
• *Two-layer architecture:* (1) conversation routing — Route 4 gets full addressee dispatch, bot messages cleared for lens-to-lens. (2) flow orchestration — declarative flow templates (YAML) executed against the routing layer with visibility rules, personas, sequential/parallel phases.
• *Worked example:* peer-review-2-round as a 5-phase flow — announce → round 1 (brief only) → round 2 (peer visibility) → synthesis → handoff. ~25-35 min end-to-end sequential.
• *MVP order (A→B→C→D):* A = conversation routing, B = hardcoded peer-review flow, C = non-blocking Orc (KNOWN-ISSUES #1), D = generic flow template engine. Don't build D first — shape the schema from a working flow, not the abstract.

*Seeking council input on:*
1. Structural signoff on the two-layer split + MVP order
2. Visibility semantics (\`brief_plus_peer_responses\` vs \`full_thread\` for round 2)
3. Parallelism — sequential in v0.8, parallel in v0.9 after non-blocking Orc lands?
4. Trigger surface — \`@Orc run flow X\` generic verb vs one verb per flow?
5. Bot-to-bot loop detection when we allow bot-authored messages through routing
6. What other flows should Pav sketch so the abstraction has two data points before we generalize? Candidates in the brief: consensus, debate, critique, standup, cascade.

Flagging red flags welcome. Once the shape is agreed, Spinner ships Phase A + B. Non-blocking Orc (Phase C) probably deserves its own brief given scope.`;

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
