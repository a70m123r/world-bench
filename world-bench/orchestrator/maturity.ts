// World-Bench v0.6.7 — Lens Maturity Lifecycle
// Implements SPEC-lens-maturity-lifecycle.md v2
//
// Four phases: discovery → first-cut → settling → steady
// Transitions are logged with evidence. Prompt versions tracked separately.

import * as fs from 'fs';
import * as path from 'path';
import { LensConfig, LensMaturity, MaturityTransition, PromptVersion } from '../agents/types';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.join(__dirname, '..');

// ─── Maturity Transitions ───

/**
 * Advance or regress a lens's maturity, logging the transition with evidence.
 * Writes updated maturity + maturityLog to lens.json on disk.
 * Returns the new maturity value.
 */
export function transitionMaturity(
  projectSlug: string,
  lensId: string,
  to: LensMaturity,
  reason: string,
  triggeredBy: MaturityTransition['triggeredBy'],
  opts?: {
    evidence?: string;
    runId?: string;
    promptVersionBefore?: number;
    promptVersionAfter?: number;
  },
): LensMaturity {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );

  if (!fs.existsSync(lensJsonPath)) {
    console.warn(`[Maturity] lens.json not found for ${projectSlug}/${lensId}, skipping transition`);
    return to;
  }

  const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
  const from: LensMaturity = lensData.maturity || 'discovery';

  // Don't log no-op transitions (same state, no reason to log)
  if (from === to && !opts?.evidence) return from;

  const transition: MaturityTransition = {
    from,
    to,
    reason,
    evidence: opts?.evidence,
    triggeredBy,
    timestamp: new Date().toISOString(),
    runId: opts?.runId,
    promptVersionBefore: opts?.promptVersionBefore,
    promptVersionAfter: opts?.promptVersionAfter,
  };

  // Update lens.json
  lensData.maturity = to;
  if (!lensData.maturityLog) lensData.maturityLog = [];
  lensData.maturityLog.push(transition);

  if (!lensData.slack_channel_id) console.warn(`[TRAP] maturity.ts:65 writing lens.json for ${lensId} WITHOUT slack_channel_id!`);
  fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));

  console.log(`[Maturity] ${lensId}: ${from} → ${to} (${reason})`);
  return to;
}

/**
 * Read current maturity from lens.json. Defaults to 'discovery' if not set.
 */
export function getMaturity(projectSlug: string, lensId: string): LensMaturity {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    if (fs.existsSync(lensJsonPath)) {
      const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
      return data.maturity || 'discovery';
    }
  } catch { }
  return 'discovery';
}

/**
 * Count consecutive clean renders (no wasted turns, no errors) from the
 * maturityLog. Used to determine settling → steady transition.
 */
export function countConsecutiveCleanRenders(projectSlug: string, lensId: string): number {
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    if (!fs.existsSync(lensJsonPath)) return 0;
    const data = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
    const log: MaturityTransition[] = data.maturityLog || [];

    // Walk backwards through log, count entries that are settling→settling
    // or settling→steady with "clean render" evidence
    let count = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.reason?.includes('clean render') || entry.reason?.includes('completed')) {
        count++;
      } else if (entry.to === 'settling' && entry.from === 'first-cut') {
        // First success → counts as first clean render
        count++;
        break;
      } else {
        break;
      }
    }
    return count;
  } catch { return 0; }
}

// ─── Prompt Versioning ───

/**
 * Save a new prompt version to prompt-history.json (separate file per council decision).
 * Returns the new version number.
 */
export function savePromptVersion(
  projectSlug: string,
  lensId: string,
  lens: LensConfig,
  reason: string,
  createdBy: PromptVersion['createdBy'],
): number {
  const historyPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'prompt-history.json',
  );

  let versions: PromptVersion[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      versions = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    }
  } catch { }

  const newVersion: PromptVersion = {
    version: versions.length + 1,
    systemPrompt: lens.systemPrompt,
    tools: [...lens.tools],
    researchEnabled: lens.researchPhase?.enabled ?? false,
    createdAt: new Date().toISOString(),
    createdBy,
    reason,
    maturityAtCreation: lens.maturity || 'discovery',
  };

  versions.push(newVersion);
  fs.writeFileSync(historyPath, JSON.stringify(versions, null, 2));

  // Update activePromptVersion in lens.json
  const lensJsonPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'lens.json',
  );
  try {
    const lensData = JSON.parse(fs.readFileSync(lensJsonPath, 'utf-8'));
    lensData.activePromptVersion = newVersion.version;
    if (!lensData.slack_channel_id) console.warn(`[TRAP] maturity.ts:165 writing lens.json for ${lensId} WITHOUT slack_channel_id!`);
    fs.writeFileSync(lensJsonPath, JSON.stringify(lensData, null, 2));
  } catch { }

  console.log(`[Maturity] ${lensId}: prompt version ${newVersion.version} saved (${reason})`);
  return newVersion.version;
}

/**
 * Get a specific prompt version from prompt-history.json.
 * Returns null if not found.
 */
export function getPromptVersion(
  projectSlug: string,
  lensId: string,
  version: number,
): PromptVersion | null {
  const historyPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'prompt-history.json',
  );
  try {
    if (!fs.existsSync(historyPath)) return null;
    const versions: PromptVersion[] = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    return versions.find(v => v.version === version) || null;
  } catch { return null; }
}

/**
 * Get the latest prompt version number.
 */
export function getLatestPromptVersion(projectSlug: string, lensId: string): number {
  const historyPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'lenses', lensId, 'prompt-history.json',
  );
  try {
    if (!fs.existsSync(historyPath)) return 0;
    const versions: PromptVersion[] = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    return versions.length;
  } catch { return 0; }
}

// ─── Wasted Turn Detection ───

/**
 * Count wasted turns in a run's events.jsonl.
 * A turn is wasted if it consumes a tool/model action and yields no state
 * advance toward the contract (Soren + Claw definition).
 * - Tool calls returning hard errors (404, auth failure) = wasted
 * - Tool searches for tools that don't exist = wasted
 * - Research exploration during first-cut = NOT wasted
 * - Self-recovered errors = NOT wasted
 */
export function countWastedTurns(
  projectSlug: string,
  runId: string,
  lensName: string,
  maturity: LensMaturity,
): number {
  const eventsPath = path.join(
    WORLD_BENCH_ROOT, 'projects', projectSlug, 'runs', runId, 'events.jsonl',
  );

  if (!fs.existsSync(eventsPath)) return 0;

  let wastedCount = 0;
  try {
    const raw = fs.readFileSync(eventsPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.actor !== lensName) continue;

        // Hard errors = wasted (unless in first-cut where exploration is expected)
        if (event.type === 'error' && maturity !== 'first-cut') {
          wastedCount++;
        }

        // Elevation requests for tools that the lens shouldn't need at this maturity
        // (e.g., searching for MCP tools in settling/steady when they're known-dead)
        if (event.type === 'elevation_request' && maturity === 'steady') {
          wastedCount++;
        }
      } catch { /* skip malformed */ }
    }
  } catch { }

  return wastedCount;
}
