// World-Bench v0.6 — Seed Manager
// Project ignition lifecycle. The "clutch" between intent parsing and
// topology instantiation. Per SPEC-orchestrator-v0.6-seed-lifecycle.md.
//
// Key responsibilities:
//  1. Persist seeds as Markdown-with-embedded-JSON files
//  2. Enforce the Pav interlock (non-collapsible same-turn create→ignite gate)
//  3. Hard-gate project creation behind ignited seeds
//  4. Load active seeds on wake (replaces ROOM-ZERO-STATE ingest)
//  5. Provide cold-start "no active projects, waiting for Pav" path

import * as fs from 'fs';
import * as path from 'path';
import { ProjectSeed, LensSketch } from '../agents/types';

export class SeedNotYetApprovedError extends Error {
  constructor(slug: string) {
    super(`Seed "${slug}" was created in the current turn. Pav must approve in a separate message before ignition. This is the non-collapsible interlock — same-turn self-advancement is invalid by design.`);
    this.name = 'SeedNotYetApprovedError';
  }
}

export class NoIgnitedSeedError extends Error {
  constructor(slug: string) {
    super(`No ignited seed found for project "${slug}". Projects cannot be created without an approved seed. This is the v0.6 hard gate.`);
    this.name = 'NoIgnitedSeedError';
  }
}

export class SeedManager {
  private worldBenchRoot: string;

  constructor(worldBenchRoot: string) {
    this.worldBenchRoot = worldBenchRoot;
  }

  // ─── Paths ───

  private seedPath(slug: string): string {
    return path.join(this.worldBenchRoot, 'projects', slug, 'SEED.md');
  }

  private projectDir(slug: string): string {
    return path.join(this.worldBenchRoot, 'projects', slug);
  }

  // ─── Create / Read / Write ───

  /**
   * Create a draft seed. Records the current turn UUID so the Pav interlock
   * can refuse same-turn ignition.
   */
  createSeed(
    slug: string,
    intent: string,
    output_shape: string,
    lens_sketch: LensSketch[],
    currentTurnId: string,
  ): ProjectSeed {
    if (this.seedExists(slug)) {
      throw new Error(`Seed "${slug}" already exists. Amend in place via updateSeed() instead.`);
    }

    const seed: ProjectSeed = {
      slug,
      intent,
      output_shape,
      lens_sketch,
      status: 'draft',
      created_at: new Date().toISOString(),
      created_at_turn_id: currentTurnId,
    };

    // Create project directory (just for the seed file — no lens dirs yet)
    fs.mkdirSync(this.projectDir(slug), { recursive: true });
    this.writeSeedFile(seed);

    console.log(`[SeedManager] Draft seed created: ${slug} (turn ${currentTurnId.slice(0, 8)})`);
    return seed;
  }

  /**
   * Promote a draft seed to ignited. Refuses if the seed was created in
   * the current turn — Pav must approve in a subsequent message.
   *
   * THE PAV INTERLOCK. This is the safety case, in code.
   */
  igniteSeed(slug: string, currentTurnId: string): ProjectSeed {
    const seed = this.loadSeed(slug);
    if (!seed) {
      throw new Error(`Cannot ignite: seed "${slug}" does not exist.`);
    }

    if (seed.status !== 'draft') {
      throw new Error(`Cannot ignite: seed "${slug}" has status "${seed.status}", expected "draft".`);
    }

    // The interlock: same-turn ignition is invalid by design
    if (seed.created_at_turn_id === currentTurnId) {
      throw new SeedNotYetApprovedError(slug);
    }

    seed.status = 'ignited';
    seed.ignited_at = new Date().toISOString();
    seed.ignited_at_turn_id = currentTurnId;
    this.writeSeedFile(seed);

    console.log(`[SeedManager] Seed ignited: ${slug}`);
    return seed;
  }

  /**
   * Update an existing seed (for sketch evolution — amend in place).
   *
   * IMPORTANT: this method protects all lifecycle-critical fields from mutation.
   * Status changes go through dedicated methods (igniteSeed, markRendering,
   * markComplete) so the interlock and lifecycle invariants stay intact.
   * (Veil's review note from v0.6 build audit.)
   */
  updateSeed(slug: string, updates: Partial<ProjectSeed>): ProjectSeed {
    const seed = this.loadSeed(slug);
    if (!seed) {
      throw new Error(`Cannot update: seed "${slug}" does not exist.`);
    }

    // Strip lifecycle-critical fields from any update payload.
    // These can only be set via the dedicated lifecycle methods.
    const sanitized: any = { ...updates };
    delete sanitized.created_at_turn_id;
    delete sanitized.created_at;
    delete sanitized.status;            // status changes go through markRendering/markComplete
    delete sanitized.ignited_at;
    delete sanitized.ignited_at_turn_id;

    Object.assign(seed, sanitized);
    this.writeSeedFile(seed);
    return seed;
  }

  /**
   * Advance seed status from `ignited` to `rendering` after the first lens
   * is attached. Auto-called by attachLensToProject().
   */
  markRendering(slug: string): ProjectSeed {
    const seed = this.loadSeed(slug);
    if (!seed) throw new Error(`Cannot mark rendering: seed "${slug}" does not exist.`);
    if (seed.status !== 'ignited') {
      // Already rendering or complete — no-op
      return seed;
    }
    seed.status = 'rendering';
    this.writeSeedFile(seed);
    console.log(`[SeedManager] Seed ${slug} now rendering`);
    return seed;
  }

  /**
   * Mark a seed complete. Pav-driven action — there's no automatic completion
   * because the Orchestrator can't tell when a project is "done."
   */
  markComplete(slug: string): ProjectSeed {
    const seed = this.loadSeed(slug);
    if (!seed) throw new Error(`Cannot mark complete: seed "${slug}" does not exist.`);
    seed.status = 'complete';
    this.writeSeedFile(seed);
    console.log(`[SeedManager] Seed ${slug} marked complete`);
    return seed;
  }

  /**
   * Load a seed from disk. Returns null if missing.
   */
  loadSeed(slug: string): ProjectSeed | null {
    const filePath = this.seedPath(slug);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Extract the embedded JSON block
      const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
      if (!jsonMatch) {
        console.warn(`[SeedManager] Seed file ${slug} has no embedded JSON block`);
        return null;
      }
      return JSON.parse(jsonMatch[1]);
    } catch (e: any) {
      console.error(`[SeedManager] Failed to load seed ${slug}: ${e.message}`);
      return null;
    }
  }

  seedExists(slug: string): boolean {
    return fs.existsSync(this.seedPath(slug));
  }

  /**
   * Hard gate for createProject() — refuse if no ignited seed.
   */
  requireIgnited(slug: string): ProjectSeed {
    const seed = this.loadSeed(slug);
    if (!seed || (seed.status !== 'ignited' && seed.status !== 'rendering')) {
      throw new NoIgnitedSeedError(slug);
    }
    return seed;
  }

  // ─── Active Seed Discovery (replaces ROOM-ZERO-STATE on wake) ───

  /**
   * Find all active seeds (draft, ignited, or rendering).
   * The Orchestrator reads these on wake to resume from where Pav left off,
   * NOT from a cron-written priority stack.
   */
  loadActiveSeeds(): ProjectSeed[] {
    const projectsDir = path.join(this.worldBenchRoot, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const active: ProjectSeed[] = [];
    try {
      for (const slug of fs.readdirSync(projectsDir)) {
        const seed = this.loadSeed(slug);
        if (seed && (seed.status === 'draft' || seed.status === 'ignited' || seed.status === 'rendering')) {
          active.push(seed);
        }
      }
    } catch { }

    return active;
  }

  /**
   * Format active seeds for injection into context. Used by loadMemoryContext().
   * If empty, returns null — let the Orchestrator say "I have no active projects."
   */
  formatActiveSeedsForContext(): string | null {
    const active = this.loadActiveSeeds();
    if (active.length === 0) return null;

    const lines: string[] = ['## Active Project Seeds (where you and Pav left off)'];
    for (const seed of active) {
      lines.push('');
      lines.push(`### ${seed.slug} — \`${seed.status}\``);
      lines.push(`**Intent:** ${seed.intent}`);
      lines.push(`**Output shape:** ${seed.output_shape}`);
      if (seed.lens_sketch.length > 0) {
        lines.push(`**Lens sketch (advisory):** ${seed.lens_sketch.map(l => l.name).join(' → ')}`);
      }
    }
    return lines.join('\n');
  }

  // ─── File I/O ───

  /**
   * Write seed as Markdown with embedded JSON section.
   * Pav reads the markdown; the Orchestrator parses the JSON block.
   */
  private writeSeedFile(seed: ProjectSeed): void {
    const filePath = this.seedPath(seed.slug);
    const content = this.renderSeedMarkdown(seed);
    fs.writeFileSync(filePath, content);
  }

  private renderSeedMarkdown(seed: ProjectSeed): string {
    const lines: string[] = [];
    lines.push(`# Seed: ${seed.slug}`);
    lines.push('');
    lines.push(`**Status:** \`${seed.status}\``);
    lines.push(`**Created:** ${seed.created_at}`);
    if (seed.ignited_at) lines.push(`**Ignited:** ${seed.ignited_at}`);
    lines.push('');
    lines.push('## Intent');
    lines.push('');
    lines.push(seed.intent);
    lines.push('');
    lines.push('## Output Shape');
    lines.push('');
    lines.push(seed.output_shape);
    lines.push('');
    lines.push('## Lens Sketch (advisory — not executable)');
    lines.push('');
    if (seed.lens_sketch.length === 0) {
      lines.push('_No sketch yet._');
    } else {
      for (const lens of seed.lens_sketch) {
        lines.push(`- **${lens.name}** (\`${lens.slug}\`) — ${lens.purpose}`);
      }
    }
    lines.push('');
    lines.push('## Machine');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(seed, null, 2));
    lines.push('```');
    lines.push('');
    return lines.join('\n');
  }
}
