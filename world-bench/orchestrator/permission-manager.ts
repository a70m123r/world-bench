// World-Bench v0.5 — Permission Manager
// Handles the elevation loop between Orchestrator and lens.
// Sandbox enforcement, tool grants, hardening suggestions.
//
// Elevation flow:
//   1. Lens hits a permission wall (PostToolUse denied)
//   2. Orchestrator evaluates: does this tool fit the lens's purpose?
//   3. If yes → grant silently, log it
//   4. If no → deny, log it
//   5. If ambiguous → escalate to Pav
//
// Hardening flow:
//   After 3 consecutive runs with stable tool usage,
//   Orchestrator suggests locking the permission set.
//   Pav decides.

import * as fs from 'fs';
import * as path from 'path';
import {
  LensConfig,
  LensPermissions,
  STEM_CELL_ALLOWED,
  STEM_CELL_DENIED,
  WorkflowEvent,
} from '../agents/types';
import { createEvent, appendEvent } from './event-log';

const HARDENING_THRESHOLD = 3; // consecutive runs with stable tool usage

export class PermissionManager {
  private worldBenchRoot: string;

  constructor(worldBenchRoot: string) {
    this.worldBenchRoot = worldBenchRoot;
  }

  // ─── Sandbox Enforcement ───

  /**
   * Get the effective tool list for a lens based on its permission tier.
   * This is what gets passed to the SDK subprocess at spawn time.
   */
  getEffectiveTools(lens: LensConfig): string[] {
    const perms = lens.permissions;

    if (perms.tier === 'hardened') {
      // Hardened: locked to allowed list, minus any denied
      return perms.allowed.filter(t => !perms.denied.includes(t));
    }

    if (perms.tier === 'shaping') {
      // Shaping: sandbox defaults + any tools granted during shaping
      const base = new Set([...STEM_CELL_ALLOWED, ...perms.granted]);
      for (const denied of perms.denied) base.delete(denied);
      return Array.from(base);
    }

    // Stem: sandbox defaults only — no Bash/Write/Edit until granted
    const base = new Set(STEM_CELL_ALLOWED);
    for (const denied of [...STEM_CELL_DENIED, ...perms.denied]) base.delete(denied);
    // Add any explicitly granted tools (from elevation)
    for (const granted of perms.granted) base.add(granted);
    return Array.from(base);
  }

  /**
   * Create default permissions for a new stem cell lens.
   */
  createStemPermissions(): LensPermissions {
    return {
      tier: 'stem',
      allowed: [...STEM_CELL_ALLOWED],
      denied: [...STEM_CELL_DENIED],
      granted: [],
      stableRunCount: 0,
      observedTools: [],
    };
  }

  // ─── Elevation Loop ───

  /**
   * Evaluate a tool elevation request from a lens.
   * Returns: 'grant' (Orchestrator approves), 'deny' (Orchestrator rejects),
   * or 'escalate' (ambiguous, needs Pav).
   */
  evaluateElevation(
    lens: LensConfig,
    requestedTool: string,
  ): { decision: 'grant' | 'deny' | 'escalate'; reason: string } {
    // Hard deny: tools on the permanent deny list
    if (lens.permissions.denied.includes(requestedTool) && lens.permissions.tier === 'hardened') {
      return {
        decision: 'deny',
        reason: `Tool "${requestedTool}" is permanently denied for hardened lens "${lens.name}".`,
      };
    }

    // Already granted
    if (lens.permissions.granted.includes(requestedTool)) {
      return {
        decision: 'grant',
        reason: `Tool "${requestedTool}" was previously granted.`,
      };
    }

    // Evaluate based on lens purpose + tool type
    const purposeLower = lens.purpose.toLowerCase();
    const toolLower = requestedTool.toLowerCase();

    // Read tools — always safe to grant
    if (['read', 'glob', 'grep'].includes(toolLower)) {
      return {
        decision: 'grant',
        reason: `Read-only tool "${requestedTool}" is safe for any lens.`,
      };
    }

    // Web tools — grant if purpose involves research/search/fetch
    if (['websearch', 'webfetch'].includes(toolLower)) {
      if (purposeLower.match(/research|search|find|read|gather|fetch|scrape|news|headlines/)) {
        return {
          decision: 'grant',
          reason: `Web tool "${requestedTool}" aligns with lens purpose: "${lens.purpose}".`,
        };
      }
    }

    // Write/Edit — grant if purpose involves creation/writing/drafting
    if (['write', 'edit'].includes(toolLower)) {
      if (purposeLower.match(/write|create|draft|produce|generate|build|compose/)) {
        return {
          decision: 'grant',
          reason: `Write tool "${requestedTool}" aligns with lens purpose: "${lens.purpose}".`,
        };
      }
    }

    // Bash — almost always escalate. Too powerful for auto-grant.
    if (toolLower === 'bash') {
      // Only auto-grant if purpose explicitly involves code execution
      if (purposeLower.match(/execute|run|compile|build|test|script/)) {
        return {
          decision: 'grant',
          reason: `Bash aligns with execution-oriented lens purpose: "${lens.purpose}".`,
        };
      }
      return {
        decision: 'escalate',
        reason: `Lens "${lens.name}" requested Bash access. Purpose: "${lens.purpose}". Bash is high-risk — needs Pav's approval.`,
      };
    }

    // Default: escalate anything we can't confidently judge
    return {
      decision: 'escalate',
      reason: `Lens "${lens.name}" requested "${requestedTool}". Purpose: "${lens.purpose}". Orchestrator can't confidently judge — needs Pav.`,
    };
  }

  /**
   * Grant a tool to a lens. Updates permissions and persists.
   */
  grantTool(
    lens: LensConfig,
    tool: string,
    projectSlug: string,
    runId: string,
    grantedBy: 'orchestrator' | 'pav',
  ): void {
    if (!lens.permissions.granted.includes(tool)) {
      lens.permissions.granted.push(tool);
    }

    // Move to shaping tier if still stem
    if (lens.permissions.tier === 'stem') {
      lens.permissions.tier = 'shaping';
    }

    // Log the elevation
    const event = createEvent(
      runId, 'orchestrator', 'elevation_granted',
      `Tool "${tool}" granted to "${lens.name}" by ${grantedBy}`,
      { tool, lens_id: lens.id, granted_by: grantedBy },
    );
    appendEvent(projectSlug, runId, event);

    // Persist updated lens config
    this.saveLensConfig(projectSlug, lens);
  }

  /**
   * Deny a tool request. Logs but doesn't modify permissions.
   */
  denyTool(
    lens: LensConfig,
    tool: string,
    projectSlug: string,
    runId: string,
    deniedBy: 'orchestrator' | 'pav',
    reason: string,
  ): void {
    const event = createEvent(
      runId, 'orchestrator', 'elevation_denied',
      `Tool "${tool}" denied for "${lens.name}" by ${deniedBy}: ${reason}`,
      { tool, lens_id: lens.id, denied_by: deniedBy, reason },
    );
    appendEvent(projectSlug, runId, event);
  }

  // ─── Hardening ───

  /**
   * Update observed tool usage after a run completes.
   * Returns a hardening suggestion if tool usage has stabilized.
   */
  updateToolUsage(
    lens: LensConfig,
    projectSlug: string,
    runToolUsage: string[],
  ): { suggest: boolean; message?: string } {
    const uniqueTools = [...new Set(runToolUsage)].sort();
    const previousTools = [...lens.permissions.observedTools].sort();

    const same = uniqueTools.length === previousTools.length &&
      uniqueTools.every((t, i) => t === previousTools[i]);

    if (same) {
      lens.permissions.stableRunCount++;
    } else {
      lens.permissions.stableRunCount = 1;
      lens.permissions.observedTools = uniqueTools;
    }

    this.saveLensConfig(projectSlug, lens);

    if (
      lens.permissions.tier !== 'hardened' &&
      lens.permissions.stableRunCount >= HARDENING_THRESHOLD
    ) {
      return {
        suggest: true,
        message: `Lens "${lens.name}" has used the same tools (${uniqueTools.join(', ')}) across ${lens.permissions.stableRunCount} consecutive runs. Ready to harden?`,
      };
    }

    return { suggest: false };
  }

  /**
   * Harden a lens — lock its permissions to observed usage.
   */
  hardenLens(lens: LensConfig, projectSlug: string): void {
    lens.permissions.tier = 'hardened';
    lens.permissions.allowed = [...lens.permissions.observedTools];
    this.saveLensConfig(projectSlug, lens);
  }

  /**
   * Re-open a hardened lens for shaping (break glass for dormant reactivation).
   */
  reopenForShaping(lens: LensConfig, projectSlug: string): void {
    lens.permissions.tier = 'shaping';
    lens.permissions.stableRunCount = 0;
    this.saveLensConfig(projectSlug, lens);
  }

  // ─── Persistence ───

  private saveLensConfig(projectSlug: string, lens: LensConfig): void {
    const lensJsonPath = path.join(
      this.worldBenchRoot, 'projects', projectSlug, 'lenses', lens.id, 'lens.json',
    );
    try {
      fs.writeFileSync(lensJsonPath, JSON.stringify(lens, null, 2));
    } catch (e: any) {
      console.error(`[PermissionManager] Failed to save lens config for ${lens.id}: ${e.message}`);
    }
  }
}
