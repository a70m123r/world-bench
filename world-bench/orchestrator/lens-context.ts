// World-Bench v0.6.9 Gate 2 — Lens Context Injection (expanded)
// Builds structured context for lens channel conversations so the lens
// knows who it is, what it did last, where it sits in the project, and
// what the humans + council said about it.
//
// Seven awareness layers:
//   1. lens.json state (maturity, config, maturityLog)
//   2. Last run audit from events.jsonl
//   3. Last settling diff (from maturityLog)
//   4. Last 10 messages from lens channel
//   5. Last 10 messages from project channel (Orchestrator analysis, Pav feedback)
//   6. Pipeline position (which lenses exist, where this one sits)
//   7. Private scratchpad (lens's own notes to its future self)

import * as fs from 'fs';
import * as path from 'path';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.join(__dirname, '..');

/**
 * Build a structured context block for a lens channel conversation.
 * Returns a formatted string that gets prepended to the user's message
 * so the lens wakes up situated, not amnesiac.
 */
export async function buildLensContext(
  projectSlug: string,
  lensId: string,
  slackClient?: any,  // WebClient from @slack/web-api — optional, for channel history
): Promise<string> {
  const sections: string[] = [];
  sections.push('--- CONTEXT (your current state — read before responding) ---\n');

  // 1. lens.json state
  const lensJsonContext = getLensJsonContext(projectSlug, lensId);
  if (lensJsonContext) sections.push(lensJsonContext);

  // 2. Last run audit
  const auditContext = getLastRunAudit(projectSlug, lensId);
  if (auditContext) sections.push(auditContext);

  // 3. Last settling diff (from maturityLog)
  const settlingContext = getLastSettlingDiff(projectSlug, lensId);
  if (settlingContext) sections.push(settlingContext);

  // 4. Last 10 messages from lens channel (if Slack client available)
  if (slackClient) {
    const channelHistory = await getLensChannelHistory(projectSlug, lensId, slackClient);
    if (channelHistory) sections.push(channelHistory);
  }

  // 5. Last 10 messages from project channel
  if (slackClient) {
    const projectHistory = await getProjectChannelHistory(projectSlug, slackClient);
    if (projectHistory) sections.push(projectHistory);
  }

  // 6. Pipeline position — where this lens sits relative to others
  const pipelineContext = getPipelinePosition(projectSlug, lensId);
  if (pipelineContext) sections.push(pipelineContext);

  // 7. Private scratchpad — lens's own notes to its future self
  const scratchpad = getScratchpad(projectSlug, lensId);
  if (scratchpad) sections.push(scratchpad);

  sections.push('--- END CONTEXT ---');
  sections.push('');
  sections.push('You can write notes to your scratchpad at any time by writing to `memory/scratchpad.md` in your workspace. These persist across sessions and will appear in your context next time.');
  sections.push('');
  return sections.join('\n');
}

/**
 * 1. lens.json state: maturity, tools, research enabled, active prompt version
 */
function getLensJsonContext(projectSlug: string, lensId: string): string | null {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    if (!fs.existsSync(lensJsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));

    const lines: string[] = [];
    lines.push('**Your current state (lens.json):**');
    lines.push(`- Maturity: ${data.maturity || 'unknown'}`);
    lines.push(`- Tools: ${(data.tools || []).join(', ')}`);
    lines.push(`- Research phase: ${data.researchPhase?.enabled ? 'enabled' : 'disabled'}`);
    lines.push(`- Active prompt version: ${data.activePromptVersion || 'none'}`);

    if (data.maturityLog && data.maturityLog.length > 0) {
      const last3 = data.maturityLog.slice(-3);
      lines.push('- Recent maturity transitions:');
      for (const entry of last3) {
        lines.push(`  - ${entry.from} → ${entry.to}: ${entry.reason} (${entry.triggeredBy}, ${new Date(entry.timestamp).toISOString().slice(0, 16)})`);
      }
    }

    return lines.join('\n');
  } catch { return null; }
}

/**
 * 2. Last run audit: timing, tools used, errors, escalations
 */
function getLastRunAudit(projectSlug: string, lensId: string): string | null {
  const runsDir = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'runs');
  try {
    if (!fs.existsSync(runsDir)) return null;
    const runs = fs.readdirSync(runsDir).sort();
    if (runs.length === 0) return null;

    // Find the most recent run that has events for this lens
    for (let i = runs.length - 1; i >= 0; i--) {
      const eventsPath = path.join(runsDir, runs[i], 'events.jsonl');
      if (!fs.existsSync(eventsPath)) continue;

      const raw = fs.readFileSync(eventsPath, 'utf-8');
      const events = raw.trim().split('\n').filter(Boolean);

      // Check if this run involved our lens
      const hasLens = events.some(line => {
        try { return JSON.parse(line).actor === lensId.charAt(0).toUpperCase() + lensId.slice(1); } // "Harvester"
        catch { return false; }
      });
      // Also check lowercase
      const hasLensLower = events.some(line => {
        try { return JSON.parse(line).actor === lensId; }
        catch { return false; }
      });

      if (!hasLens && !hasLensLower) continue;

      // Build a compact audit from this run's events
      const toolCounts: Record<string, number> = {};
      let errorCount = 0;
      let escalationCount = 0;
      let startTime: string | undefined;
      let endTime: string | undefined;

      for (const line of events) {
        try {
          const e = JSON.parse(line);
          if (!startTime) startTime = e.timestamp;
          endTime = e.timestamp;
          if (e.type === 'message' && e.metadata?.tool) {
            toolCounts[e.metadata.tool] = (toolCounts[e.metadata.tool] || 0) + 1;
          }
          if (e.type === 'error') errorCount++;
          if (e.type === 'elevation_request') escalationCount++;
        } catch { }
      }

      const dur = startTime && endTime
        ? `${Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)}s`
        : 'unknown';
      const toolStr = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t} x${c}`)
        .join(', ');

      const lines: string[] = [];
      lines.push(`**Last run audit** (run ${runs[i].slice(0, 8)}):`);
      lines.push(`- Duration: ${dur}`);
      lines.push(`- Tools: ${toolStr || 'none'}`);
      lines.push(`- Errors: ${errorCount}`);
      lines.push(`- Escalations: ${escalationCount}`);

      // Check output
      const outputDir = path.join(WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'output');
      try {
        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          const outputFiles = files.map(f => {
            const s = fs.statSync(path.join(outputDir, f));
            return `${f} (${Math.round(s.size / 1024)}KB)`;
          });
          if (outputFiles.length > 0) {
            lines.push(`- Output files: ${outputFiles.join(', ')}`);
          }
        }
      } catch { }

      return lines.join('\n');
    }
  } catch { }
  return null;
}

/**
 * 3. Last settling diff from maturityLog
 */
function getLastSettlingDiff(projectSlug: string, lensId: string): string | null {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    if (!fs.existsSync(lensJsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
    const log = data.maturityLog || [];

    // Find the most recent settling-related entry with evidence
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].evidence && (log[i].from === 'settling' || log[i].to === 'settling')) {
        return `**Last settling change:** ${log[i].reason}\n- Evidence: ${log[i].evidence}\n- When: ${new Date(log[i].timestamp).toISOString().slice(0, 16)}`;
      }
    }
  } catch { }
  return null;
}

/**
 * 4. Last 10 messages from the lens channel (human-readable summary)
 */
async function getLensChannelHistory(
  projectSlug: string,
  lensId: string,
  slackClient: any,
): Promise<string | null> {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    if (!fs.existsSync(lensJsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
    const channelId = data.slack_channel_id;
    if (!channelId) return null;

    const result = await slackClient.conversations.history({
      channel: channelId,
      limit: 10,
    });

    if (!result.messages || result.messages.length === 0) return null;

    const lines: string[] = [];
    lines.push(`**Recent lens channel messages** (last ${result.messages.length}):`);

    // Reverse to show oldest first
    const msgs = [...result.messages].reverse();
    for (const msg of msgs) {
      const time = new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 16);
      const user = msg.username || msg.user || 'unknown';
      const text = (msg.text || '').slice(0, 150).replace(/\n/g, ' ');
      lines.push(`- [${time}] ${user}: ${text}`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * 5. Last 10 messages from the project channel — Orchestrator analysis,
 * run summaries, Pav's feedback, settling diffs, other lenses' summaries.
 */
async function getProjectChannelHistory(
  projectSlug: string,
  slackClient: any,
): Promise<string | null> {
  const projectJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'project.json',
  );
  try {
    if (!fs.existsSync(projectJsonPath)) return null;
    const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    const channelId = meta.project_channel_id;
    if (!channelId) return null;

    const result = await slackClient.conversations.history({
      channel: channelId,
      limit: 10,
    });

    if (!result.messages || result.messages.length === 0) return null;

    const lines: string[] = [];
    lines.push(`**Recent project channel messages** (#wb-proj-${projectSlug}, last ${result.messages.length}):`);

    const msgs = [...result.messages].reverse();
    for (const msg of msgs) {
      const time = new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 16);
      const user = msg.username || msg.user || 'unknown';
      const text = (msg.text || '').slice(0, 200).replace(/\n/g, ' ');
      lines.push(`- [${time}] ${user}: ${text}`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * 6. Pipeline position — which lenses exist in this project, their maturity,
 * and where this lens sits in the pipeline. Gives the lens awareness of
 * its siblings and its role in the chain.
 */
function getPipelinePosition(projectSlug: string, lensId: string): string | null {
  const projectJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'project.json',
  );
  try {
    if (!fs.existsSync(projectJsonPath)) return null;
    const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    const lensIds: string[] = meta.lenses || [];

    if (lensIds.length <= 1) {
      return `**Pipeline position:** You are the only lens in project \`${projectSlug}\`.`;
    }

    const lines: string[] = [];
    lines.push(`**Pipeline position** (project \`${projectSlug}\`, ${lensIds.length} lenses):`);

    for (const id of lensIds) {
      const lensJsonPath = path.join(
        WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', id, 'lens.json',
      );
      try {
        const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
        const maturity = data.maturity || 'unknown';
        const isSelf = id === lensId;
        const marker = isSelf ? ' ← you' : '';
        lines.push(`- **${data.name || id}** (${maturity})${marker}: ${(data.purpose || '').slice(0, 100)}`);
      } catch {
        lines.push(`- **${id}** (unknown): config not readable`);
      }
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * 7. Private scratchpad — the lens's own notes to its future self.
 * Stored at projects/{slug}/lenses/{lensId}/memory/scratchpad.md.
 * The lens can write here during any session via Write tool. Notes
 * persist across sessions and appear in context every time.
 */
function getScratchpad(projectSlug: string, lensId: string): string | null {
  const scratchpadPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'memory', 'scratchpad.md',
  );
  try {
    if (!fs.existsSync(scratchpadPath)) return null;
    const content = fs.readFileSync(scratchpadPath, 'utf-8').trim();
    if (!content) return null;

    // Cap at 2000 chars to avoid bloating the context
    const capped = content.length > 2000
      ? content.slice(0, 2000) + '\n...(truncated, full file at memory/scratchpad.md)'
      : content;

    return `**Your scratchpad** (notes you left for yourself):\n${capped}`;
  } catch {
    return null;
  }
}
