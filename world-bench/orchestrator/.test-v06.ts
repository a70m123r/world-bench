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
