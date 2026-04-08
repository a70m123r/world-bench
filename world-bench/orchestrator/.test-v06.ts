// Mechanical test pass for v0.6 seed lifecycle.
// Tests the three load-bearing safety mechanisms without Slack/SDK dependencies.
// Run with: npx tsx orchestrator/.test-v06.ts

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { SeedManager, SeedNotYetApprovedError, NoIgnitedSeedError } from './seed-manager';

const WORLD_BENCH_ROOT = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');
const TEST_SLUG = `_test-seed-${Date.now()}`;

function pass(label: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}

function fail(label: string, err?: any) {
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  if (err) console.log(`    ${err.message || err}`);
  process.exitCode = 1;
}

async function main() {
  console.log('\n=== v0.6 Mechanical Test Pass ===\n');
  let passed = 0;
  let failed = 0;

  const seedManager = new SeedManager(WORLD_BENCH_ROOT);
  const testProjectDir = path.join(WORLD_BENCH_ROOT, 'projects', TEST_SLUG);

  // Cleanup any leftover from previous runs
  if (fs.existsSync(testProjectDir)) {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  }

  // ─── TEST 1: Hard gate ───
  console.log('TEST 1: Hard gate — requireIgnited() throws NoIgnitedSeedError without an ignited seed');
  try {
    seedManager.requireIgnited(TEST_SLUG);
    fail('should have thrown NoIgnitedSeedError'); failed++;
  } catch (e: any) {
    if (e instanceof NoIgnitedSeedError) {
      pass(`threw NoIgnitedSeedError: ${e.message.slice(0, 80)}...`); passed++;
    } else {
      fail(`threw wrong error type: ${e.constructor.name}`); failed++;
    }
  }

  // ─── TEST 2: Pav interlock — same-turn create + ignite blocked ───
  console.log('\nTEST 2: Pav interlock — same-turn create_seed → ignite_seed must throw');
  const sameTurnId = uuid();
  try {
    seedManager.createSeed(
      TEST_SLUG,
      'test intent',
      'test output shape',
      [{ slug: 'test-lens', name: 'Test Lens', purpose: 'testing' }],
      sameTurnId,
    );
    pass('createSeed succeeded'); passed++;
  } catch (e: any) {
    fail(`createSeed failed: ${e.message}`); failed++;
  }

  try {
    seedManager.igniteSeed(TEST_SLUG, sameTurnId);
    fail('should have thrown SeedNotYetApprovedError on same-turn ignite'); failed++;
  } catch (e: any) {
    if (e instanceof SeedNotYetApprovedError) {
      pass(`threw SeedNotYetApprovedError on same-turn ignite`); passed++;
    } else {
      fail(`threw wrong error type: ${e.constructor.name}`, e); failed++;
    }
  }

  // ─── TEST 3: Different turn ignites successfully ───
  console.log('\nTEST 3: Different turn — ignite_seed succeeds in a subsequent turn');
  const differentTurnId = uuid();
  try {
    const seed = seedManager.igniteSeed(TEST_SLUG, differentTurnId);
    if (seed.status === 'ignited') {
      pass('seed status advanced to ignited'); passed++;
    } else {
      fail(`seed status is ${seed.status}, expected 'ignited'`); failed++;
    }
    if (seed.ignited_at_turn_id === differentTurnId) {
      pass('ignited_at_turn_id recorded correctly'); passed++;
    } else {
      fail('ignited_at_turn_id not set'); failed++;
    }
  } catch (e: any) {
    fail(`ignite failed: ${e.message}`, e); failed++;
  }

  // ─── TEST 4: requireIgnited works after ignition ───
  console.log('\nTEST 4: Hard gate accepts ignited seeds');
  try {
    const seed = seedManager.requireIgnited(TEST_SLUG);
    if (seed.status === 'ignited') {
      pass('requireIgnited returns ignited seed'); passed++;
    } else {
      fail(`unexpected status: ${seed.status}`); failed++;
    }
  } catch (e: any) {
    fail(`requireIgnited threw: ${e.message}`); failed++;
  }

  // ─── TEST 5: markRendering advances status ───
  console.log('\nTEST 5: markRendering — ignited → rendering');
  try {
    const seed = seedManager.markRendering(TEST_SLUG);
    if (seed.status === 'rendering') {
      pass('seed status advanced to rendering'); passed++;
    } else {
      fail(`seed status is ${seed.status}, expected 'rendering'`); failed++;
    }
  } catch (e: any) {
    fail(`markRendering failed: ${e.message}`); failed++;
  }

  // ─── TEST 6: requireIgnited still accepts rendering status ───
  console.log('\nTEST 6: Hard gate accepts rendering seeds');
  try {
    const seed = seedManager.requireIgnited(TEST_SLUG);
    if (seed.status === 'rendering') {
      pass('requireIgnited accepts rendering'); passed++;
    } else {
      fail(`unexpected status: ${seed.status}`); failed++;
    }
  } catch (e: any) {
    fail(`requireIgnited threw on rendering: ${e.message}`); failed++;
  }

  // ─── TEST 7: updateSeed can't mutate status ───
  console.log('\nTEST 7: updateSeed strips lifecycle fields');
  try {
    seedManager.updateSeed(TEST_SLUG, {
      intent: 'updated intent',
      status: 'complete' as any,             // should be stripped
      created_at_turn_id: 'forged' as any,   // should be stripped
    });
    const seed = seedManager.loadSeed(TEST_SLUG);
    if (!seed) { fail('seed disappeared after update'); failed++; }
    else {
      if (seed.status === 'rendering') {
        pass('status not mutated by updateSeed'); passed++;
      } else {
        fail(`status was mutated to ${seed.status}`); failed++;
      }
      if (seed.created_at_turn_id !== 'forged') {
        pass('created_at_turn_id not mutated'); passed++;
      } else {
        fail('created_at_turn_id was mutated — interlock can be bypassed'); failed++;
      }
      if (seed.intent === 'updated intent') {
        pass('intent (non-protected) was updated'); passed++;
      } else {
        fail('intent update did not take effect'); failed++;
      }
    }
  } catch (e: any) {
    fail(`updateSeed test failed: ${e.message}`); failed++;
  }

  // ─── TEST 8: Cold start — loadActiveSeeds returns empty when no seeds ───
  console.log('\nTEST 8: Cold start — empty seed list when none exist');
  // Tear down test seed temporarily and check cold-start behavior
  fs.rmSync(testProjectDir, { recursive: true, force: true });
  try {
    const active = seedManager.loadActiveSeeds().filter(s => s.slug === TEST_SLUG);
    if (active.length === 0) {
      pass('test seed gone from active list'); passed++;
    } else {
      fail('test seed still appears'); failed++;
    }
    const formatted = seedManager.formatActiveSeedsForContext();
    // Other seeds might exist — just verify the test seed is not there
    if (!formatted || !formatted.includes(TEST_SLUG)) {
      pass('test seed not in formatted context'); passed++;
    } else {
      fail('test seed still in context'); failed++;
    }
  } catch (e: any) {
    fail(`cold start check failed: ${e.message}`); failed++;
  }

  // ─── TEST 9: ROOM-ZERO-STATE.md not in loadMemoryContext ───
  console.log('\nTEST 9: ROOM-ZERO-STATE.md ingest is severed');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');
    // Look for any active READ of ROOM-ZERO-STATE in loadMemoryContext
    const loadMemoryStart = indexSource.indexOf('private loadMemoryContext');
    const loadMemoryEnd = indexSource.indexOf('async start', loadMemoryStart);
    const loadMemoryBody = indexSource.slice(loadMemoryStart, loadMemoryEnd);
    // Acceptable: comments mentioning it, or `ROOM-ZERO-STATE.md` in a deletion comment.
    // Unacceptable: an actual readFileSync call against ROOM-ZERO-STATE.md
    const hasReadCall = /readFileSync\([^)]*ROOM-ZERO-STATE/i.test(loadMemoryBody);
    if (!hasReadCall) {
      pass('no readFileSync of ROOM-ZERO-STATE.md in loadMemoryContext'); passed++;
    } else {
      fail('loadMemoryContext still reads ROOM-ZERO-STATE.md'); failed++;
    }
  } catch (e: any) {
    fail(`source check failed: ${e.message}`); failed++;
  }

  // ─── TEST 10: rehearse — source-level invariants (v0.6.2) ───
  // Rehearse is a method on the Orchestrator class which needs Slack tokens to
  // instantiate. We verify the council-mandated guarantees by reading the source:
  //   a) rehearse method exists
  //   b) it requires the project to already exist (no implicit bootstrap)
  //   c) it does NOT call attachLensToProject or bootstrapProject
  //   d) it does NOT call markRendering / markComplete (read-only on lifecycle)
  //   e) it rejects requests for unattached lenses (no silent attach)
  //   f) the action handler exists and is wired to the parser
  console.log('\nTEST 10: rehearse — bare verb, no smuggled differentiation (v0.6.2)');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');

    // a) method exists
    const rehearseStart = indexSource.indexOf('async rehearse(');
    const rehearseEnd = indexSource.indexOf('private loadLensFromDisk', rehearseStart);
    if (rehearseStart < 0 || rehearseEnd < 0) {
      fail('rehearse() method not found in source'); failed++;
    } else {
      pass('rehearse() method present'); passed++;
      const body = indexSource.slice(rehearseStart, rehearseEnd);

      // b) requires project to exist
      if (/projectExists\(projectSlug\)/.test(body) && /Cannot rehearse: project/i.test(body)) {
        pass('rehearse refuses missing projects (no implicit bootstrap)'); passed++;
      } else {
        fail('rehearse missing projectExists guard'); failed++;
      }

      // c) no smuggled bootstrap or attach calls
      if (!/bootstrapProject\(/.test(body) && !/attachLensToProject\(/.test(body)) {
        pass('rehearse never calls bootstrapProject or attachLensToProject'); passed++;
      } else {
        fail('rehearse smuggles bootstrap/attach — composition is leaking into differentiation'); failed++;
      }

      // d) read-only on the seed lifecycle
      if (!/markRendering\(/.test(body) && !/markComplete\(/.test(body)) {
        pass('rehearse never advances seed status (lifecycle read-only)'); passed++;
      } else {
        fail('rehearse mutates seed status — should be read-only'); failed++;
      }

      // e) rejects unattached lenses
      if (/meta\.lenses\.includes/.test(body) && /not attached/i.test(body)) {
        pass('rehearse rejects unattached lens slugs'); passed++;
      } else {
        fail('rehearse missing attached-lens check'); failed++;
      }

      // f) refuses draft seeds (must be past ignition)
      if (/status === 'draft'/.test(body)) {
        pass('rehearse refuses draft seeds'); passed++;
      } else {
        fail('rehearse allows rehearsing draft seeds'); failed++;
      }
    }

    // Action handler wired
    if (/\(response\.action as string\) === 'rehearse'/.test(indexSource)) {
      pass('rehearse action handler present in dispatcher'); passed++;
    } else {
      fail('rehearse action handler missing from dispatcher'); failed++;
    }

    // Parser branch wired
    if (/actionData\.action === 'rehearse'/.test(indexSource)) {
      pass('rehearse parser branch present'); passed++;
    } else {
      fail('rehearse parser branch missing'); failed++;
    }
  } catch (e: any) {
    fail(`rehearse source check failed: ${e.message}`); failed++;
  }

  // ─── TEST 11: v0.6.3 — capability boundary canUseTool present ───
  console.log('\nTEST 11: canUseTool — capability boundary on protected paths (v0.6.3)');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');

    // makeCanUseTool helper exists
    if (/private makeCanUseTool\(\)/.test(indexSource)) {
      pass('makeCanUseTool() helper present'); passed++;
    } else {
      fail('makeCanUseTool() helper missing'); failed++;
    }

    // canUseTool wired into SDK options
    if (/canUseTool: this\.makeCanUseTool\(\)/.test(indexSource)) {
      pass('canUseTool wired into SDK options'); passed++;
    } else {
      fail('canUseTool not wired into SDK options'); failed++;
    }

    // permissionMode is NOT bypassPermissions anymore (would short-circuit canUseTool)
    const sdkBlock = indexSource.match(/permissionMode:\s*'([^']+)'/);
    if (sdkBlock && sdkBlock[1] !== 'bypassPermissions') {
      pass(`permissionMode is '${sdkBlock[1]}' (not bypassPermissions, so canUseTool fires)`); passed++;
    } else {
      fail('permissionMode is still bypassPermissions — canUseTool will be skipped'); failed++;
    }

    // Mutation tools list includes Write/Edit/NotebookEdit/MultiEdit
    if (/mutationTools = new Set\(\[['"]Write['"][^)]*['"]Edit['"][^)]*['"]NotebookEdit['"][^)]*['"]MultiEdit['"]/.test(indexSource)) {
      pass('mutation tools set covers Write, Edit, NotebookEdit, MultiEdit'); passed++;
    } else {
      fail('mutation tools set is incomplete'); failed++;
    }

    // Protected path detector covers projects/, orchestrator/, agents/
    const cu = indexSource.indexOf('makeCanUseTool');
    const cuEnd = indexSource.indexOf('private async converse', cu);
    const cuBody = indexSource.slice(cu, cuEnd);
    if (/'projects'/.test(cuBody) && /'orchestrator'/.test(cuBody) && /'agents'/.test(cuBody)) {
      pass('protected path detector covers projects/, orchestrator/, agents/'); passed++;
    } else {
      fail('protected path detector incomplete'); failed++;
    }

    // action.json is the explicit allowlist
    if (/allowedActionPath/.test(cuBody) && /action\.json/.test(cuBody)) {
      pass('action.json is the explicit single allowed write target'); passed++;
    } else {
      fail('action.json allowlist missing'); failed++;
    }

    // Deny returns a behavior:'deny' result
    if (/behavior:\s*['"]deny['"]/.test(cuBody)) {
      pass('canUseTool returns deny result on protected paths'); passed++;
    } else {
      fail('canUseTool deny path missing'); failed++;
    }
  } catch (e: any) {
    fail(`canUseTool check failed: ${e.message}`); failed++;
  }

  // ─── TEST 12: v0.6.3 — amend_seed action verb ───
  console.log('\nTEST 12: amend_seed verb — legitimate path through SeedManager (v0.6.3)');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');

    // ActionType union includes amend_seed
    if (/'amend_seed'/.test(indexSource)) {
      pass('amend_seed in ActionType union'); passed++;
    } else {
      fail('amend_seed missing from ActionType union'); failed++;
    }

    // Action handler wired
    if (/\(response\.action as string\) === 'amend_seed'/.test(indexSource)) {
      pass('amend_seed action handler present'); passed++;
    } else {
      fail('amend_seed action handler missing'); failed++;
    }

    // Parser branch wired
    if (/actionData\.action === 'amend_seed'/.test(indexSource)) {
      pass('amend_seed parser branch present'); passed++;
    } else {
      fail('amend_seed parser branch missing'); failed++;
    }

    // Routes through SeedManager.updateSeed (not direct write)
    const handlerStart = indexSource.indexOf("(response.action as string) === 'amend_seed'");
    const handlerEnd = indexSource.indexOf('// ignite_seed:', handlerStart);
    const handlerBody = indexSource.slice(handlerStart, handlerEnd);
    if (/this\.seedManager\.updateSeed\(/.test(handlerBody)) {
      pass('amend_seed handler routes through SeedManager.updateSeed()'); passed++;
    } else {
      fail('amend_seed handler does not call SeedManager.updateSeed()'); failed++;
    }
  } catch (e: any) {
    fail(`amend_seed check failed: ${e.message}`); failed++;
  }

  // ─── TEST 13: v0.6.3 — ProjectSeed grew constraints + artifact_spec ───
  console.log('\nTEST 13: ProjectSeed type — constraints + artifact_spec fields (v0.6.3)');
  try {
    const typesSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'agents', 'types.ts'), 'utf-8');
    const seedStart = typesSource.indexOf('export interface ProjectSeed');
    const seedEnd = typesSource.indexOf('export interface LensSketch', seedStart);
    const seedBody = typesSource.slice(seedStart, seedEnd);

    if (/constraints\?:/.test(seedBody)) {
      pass('ProjectSeed has constraints? field'); passed++;
    } else {
      fail('ProjectSeed missing constraints field'); failed++;
    }

    if (/artifact_spec\?:/.test(seedBody)) {
      pass('ProjectSeed has artifact_spec? field'); passed++;
    } else {
      fail('ProjectSeed missing artifact_spec field'); failed++;
    }

    // updateSeed should NOT strip these (they're editable, not lifecycle-protected)
    const seedManagerSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'seed-manager.ts'), 'utf-8');
    const updateStart = seedManagerSource.indexOf('updateSeed(');
    const updateEnd = seedManagerSource.indexOf('markRendering', updateStart);
    const updateBody = seedManagerSource.slice(updateStart, updateEnd);
    // Check that constraints and artifact_spec are NOT in the strip list
    if (!/delete sanitized\.constraints/.test(updateBody) && !/delete sanitized\.artifact_spec/.test(updateBody)) {
      pass('updateSeed leaves constraints + artifact_spec editable (not stripped)'); passed++;
    } else {
      fail('updateSeed strips constraints or artifact_spec — should be editable'); failed++;
    }

    // renderSeedMarkdown renders both new sections
    if (/seed\.constraints/.test(seedManagerSource) && /## Constraints/.test(seedManagerSource)) {
      pass('renderSeedMarkdown renders ## Constraints when present'); passed++;
    } else {
      fail('renderSeedMarkdown does not render constraints'); failed++;
    }
    if (/seed\.artifact_spec/.test(seedManagerSource) && /## Artifact/.test(seedManagerSource)) {
      pass('renderSeedMarkdown renders ## Artifact when present'); passed++;
    } else {
      fail('renderSeedMarkdown does not render artifact_spec'); failed++;
    }
  } catch (e: any) {
    fail(`ProjectSeed growth check failed: ${e.message}`); failed++;
  }

  // ─── TEST 14: v0.6.3 — system prompt teaches the capability boundary ───
  console.log('\nTEST 14: system prompt teaches the capability boundary (v0.6.3)');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');

    if (/The Capability Boundary/.test(indexSource)) {
      pass('system prompt has Capability Boundary section'); passed++;
    } else {
      fail('system prompt missing Capability Boundary section'); failed++;
    }

    if (/canUseTool/.test(indexSource) && /denied/i.test(indexSource)) {
      pass('system prompt explains canUseTool deny behavior'); passed++;
    } else {
      fail('system prompt does not explain canUseTool deny'); failed++;
    }

    if (/amend_seed/.test(indexSource)) {
      pass('system prompt documents amend_seed verb'); passed++;
    } else {
      fail('system prompt does not document amend_seed'); failed++;
    }
  } catch (e: any) {
    fail(`system prompt check failed: ${e.message}`); failed++;
  }

  // ─── TEST 15: v0.6.3 — end-to-end amend_seed via SeedManager ───
  console.log('\nTEST 15: amend_seed end-to-end via SeedManager (v0.6.3)');
  // Recreate the test seed for this test (TEST 8 cleanup tore it down)
  try {
    const turn = uuid();
    const seed = seedManager.createSeed(
      TEST_SLUG, 'orig intent', 'orig output shape', [], turn,
    );
    // Apply an amend with new constraints + artifact_spec
    const amended = seedManager.updateSeed(TEST_SLUG, {
      constraints: { product: ['v1 is one hat, not a hat system'], process: ['shape-cutting is manual'] },
      artifact_spec: { path: 'world-bench/test/hat.md', format: 'markdown', sections: ['A', 'B'], word_cap: 500 },
      intent: 'updated intent',
    });
    if (amended.constraints?.product?.[0] === 'v1 is one hat, not a hat system') {
      pass('amend persisted constraints.product'); passed++;
    } else {
      fail('amend did not persist constraints.product'); failed++;
    }
    if (amended.artifact_spec?.path === 'world-bench/test/hat.md') {
      pass('amend persisted artifact_spec.path'); passed++;
    } else {
      fail('amend did not persist artifact_spec.path'); failed++;
    }
    if (amended.intent === 'updated intent') {
      pass('amend updated editable field (intent)'); passed++;
    } else {
      fail('amend did not update intent'); failed++;
    }

    // Reload from disk and verify the markdown body now contains both sections
    const onDisk = fs.readFileSync(
      path.join(WORLD_BENCH_ROOT, 'projects', TEST_SLUG, 'SEED.md'), 'utf-8',
    );
    if (/## Constraints/.test(onDisk) && /v1 is one hat/.test(onDisk)) {
      pass('SEED.md markdown body contains rendered Constraints section'); passed++;
    } else {
      fail('SEED.md markdown body missing Constraints section'); failed++;
    }
    if (/## Artifact/.test(onDisk) && /world-bench\/test\/hat\.md/.test(onDisk)) {
      pass('SEED.md markdown body contains rendered Artifact section'); passed++;
    } else {
      fail('SEED.md markdown body missing Artifact section'); failed++;
    }
  } catch (e: any) {
    fail(`end-to-end amend test failed: ${e.message}`); failed++;
  }

  // ─── TEST 16: v0.6.4 — meet_lens action verb ───
  console.log('\nTEST 16: meet_lens verb — conversation-only stem cell introduction (v0.6.4)');
  try {
    const indexSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'index.ts'), 'utf-8');
    const lensManagerSource = fs.readFileSync(path.join(WORLD_BENCH_ROOT, 'orchestrator', 'lens-manager.ts'), 'utf-8');

    // a) ActionType union includes meet_lens
    if (/'meet_lens'/.test(indexSource)) {
      pass('meet_lens in ActionType union'); passed++;
    } else {
      fail('meet_lens missing from ActionType union'); failed++;
    }

    // b) Action handler present in dispatcher
    if (/\(response\.action as string\) === 'meet_lens'/.test(indexSource)) {
      pass('meet_lens action handler present'); passed++;
    } else {
      fail('meet_lens action handler missing'); failed++;
    }

    // c) Parser branch present
    if (/actionData\.action === 'meet_lens'/.test(indexSource)) {
      pass('meet_lens parser branch present'); passed++;
    } else {
      fail('meet_lens parser branch missing'); failed++;
    }

    // d) Orchestrator.meetLens method exists and calls runLensMeet
    if (/async meetLens\(/.test(indexSource) && /this\.lensManager\.runLensMeet\(/.test(indexSource)) {
      pass('Orchestrator.meetLens routes through lens-manager.runLensMeet'); passed++;
    } else {
      fail('Orchestrator.meetLens does not route through runLensMeet'); failed++;
    }

    // e) lens-manager has runLensMeet method
    if (/async runLensMeet\(/.test(lensManagerSource)) {
      pass('lens-manager.runLensMeet present'); passed++;
    } else {
      fail('lens-manager.runLensMeet missing'); failed++;
    }

    // f) runLensMeet strips mutation tools
    const meetStart = lensManagerSource.indexOf('async runLensMeet(');
    const meetEnd = lensManagerSource.indexOf('private async spawnWithTimeout', meetStart);
    const meetBody = lensManagerSource.slice(meetStart, meetEnd);
    if (/MUTATION_TOOLS/.test(meetBody) && /'Write'/.test(meetBody) && /'Edit'/.test(meetBody) && /\.filter\(/.test(meetBody)) {
      pass('runLensMeet strips Write/Edit/NotebookEdit/MultiEdit from tool list'); passed++;
    } else {
      fail('runLensMeet does not strip mutation tools'); failed++;
    }

    // g) runLensMeet does NOT call research or production phases
    if (!/buildResearchPrompt\(/.test(meetBody) && !/buildProductionPrompt\(/.test(meetBody)) {
      pass('runLensMeet never invokes research or production phases'); passed++;
    } else {
      fail('runLensMeet smuggles research or production phase'); failed++;
    }

    // h) runLensMeet returns sessionId for resume
    if (/sessionId:/.test(meetBody) && /result.*sessionId/.test(meetBody)) {
      pass('runLensMeet captures and returns sessionId for resume continuity'); passed++;
    } else {
      fail('runLensMeet does not return sessionId'); failed++;
    }

    // i) pendingMeetSessions map exists on Orchestrator
    if (/pendingMeetSessions: Map<string, string>/.test(indexSource)) {
      pass('Orchestrator has pendingMeetSessions map'); passed++;
    } else {
      fail('pendingMeetSessions map missing'); failed++;
    }

    // j) attachLensToProject accepts optional meetSessionId
    if (/attachLensToProject\(slug: string, lens: LensConfig, meetSessionId\?: string\)/.test(indexSource)) {
      pass('attachLensToProject accepts optional meetSessionId'); passed++;
    } else {
      fail('attachLensToProject missing meetSessionId parameter'); failed++;
    }

    // k) render_lens consumes pendingMeetSessions and threads to attachLensToProject
    const renderStart = indexSource.indexOf("if (response.action === 'render_lens'");
    const renderEnd = indexSource.indexOf('// rehearse:', renderStart);
    const renderBody = indexSource.slice(renderStart, renderEnd);
    if (/pendingMeetSessions\.get/.test(renderBody) && /pendingMeetSessions\.delete/.test(renderBody) && /attachLensToProject\([^)]+meetSessionId\)/.test(renderBody)) {
      pass('render_lens consumes pendingMeetSessions and threads sessionId to attachLensToProject'); passed++;
    } else {
      fail('render_lens does not consume pending meet sessions'); failed++;
    }

    // l) attachLensToProject writes meetSessionId into lens.json on creation
    const attachStart = indexSource.indexOf('async attachLensToProject(');
    const attachEnd = indexSource.indexOf('// ─── Workflow Execution ───', attachStart);
    const attachBody = indexSource.slice(attachStart, attachEnd);
    if (/lensWithSession\.sessionId = meetSessionId/.test(attachBody) && /JSON\.stringify\(lensWithSession/.test(attachBody)) {
      pass('attachLensToProject persists meetSessionId into lens.json'); passed++;
    } else {
      fail('attachLensToProject does not persist meetSessionId'); failed++;
    }

    // m) System prompt documents meet_lens verb (check for the action JSON example)
    if (/"action": "meet_lens"/.test(indexSource) && /introduce the stem cell/i.test(indexSource)) {
      pass('system prompt documents meet_lens verb with action JSON example'); passed++;
    } else {
      fail('system prompt missing meet_lens documentation'); failed++;
    }

    // n) Phase 3 description updated to include meet
    if (/Phase 3 — Sketch → Meet → Render/.test(indexSource)) {
      pass('Phase 3 description includes Meet beat'); passed++;
    } else {
      fail('Phase 3 still says Sketch → Render without Meet'); failed++;
    }

    // o) canUseTool deny message includes meet_lens in verb list
    if (/create_seed,.*meet_lens.*render_lens/.test(indexSource)) {
      pass('canUseTool deny message verb list includes meet_lens'); passed++;
    } else {
      fail('canUseTool deny message verb list missing meet_lens'); failed++;
    }
  } catch (e: any) {
    fail(`meet_lens source check failed: ${e.message}`); failed++;
  }

  // ─── Cleanup ───
  if (fs.existsSync(testProjectDir)) {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  }

  // ─── Summary ───
  console.log('\n=== Results ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed === 0) {
    console.log('\n  \x1b[32mAll mechanical tests passed.\x1b[0m\n');
  } else {
    console.log('\n  \x1b[31mTests failed.\x1b[0m\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
