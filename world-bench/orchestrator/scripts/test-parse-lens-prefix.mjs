// Quick check of the parseLensPrefix logic against the lens config
// that'll actually be in use (Harvester, Signal Extractor, Hat Renderer).
// Not a real test suite — just a sanity check before Pav restarts.

const lenses = [
  { id: 'harvester',         username: 'Harvester' },
  { id: 'signal-extractor',  username: 'Signal Extractor' },
  { id: 'hat-renderer',      username: 'Hat Renderer' },
];

function parseLensPrefix(text, lenses) {
  const trimmed = text.replace(/^\s+/, '');
  const lowered = trimmed.toLowerCase();

  const candidates = [];
  for (const lens of lenses) {
    candidates.push({ key: lens.username.toLowerCase(), lensId: lens.id });
    if (lens.id.toLowerCase() !== lens.username.toLowerCase()) {
      candidates.push({ key: lens.id.toLowerCase(), lensId: lens.id });
    }
    const flipped = lens.username.toLowerCase().replace(/[-\s]+/g, ' ');
    if (!candidates.some(c => c.key === flipped)) {
      candidates.push({ key: flipped, lensId: lens.id });
    }
  }
  candidates.sort((a, b) => b.key.length - a.key.length);

  for (const cand of candidates) {
    if (lowered.startsWith(cand.key)) {
      const rest = trimmed.slice(cand.key.length);
      const colonMatch = rest.match(/^\s*[:\-,]\s*(.*)$/s);
      if (colonMatch) {
        const strippedMessage = colonMatch[1].trim();
        if (strippedMessage.length > 0) {
          return { lensId: cand.lensId, strippedMessage };
        }
      }
    }
  }
  return null;
}

const tests = [
  ['Harvester: look at the new brief',               { lensId: 'harvester', strippedMessage: 'look at the new brief' }],
  ['harvester: look at the new brief',               { lensId: 'harvester', strippedMessage: 'look at the new brief' }],
  ['HARVESTER: look at the new brief',               { lensId: 'harvester', strippedMessage: 'look at the new brief' }],
  ['Signal Extractor: do the thing',                 { lensId: 'signal-extractor', strippedMessage: 'do the thing' }],
  ['signal extractor: do the thing',                 { lensId: 'signal-extractor', strippedMessage: 'do the thing' }],
  ['signal-extractor: do the thing',                 { lensId: 'signal-extractor', strippedMessage: 'do the thing' }],
  ['Hat Renderer: hi',                               { lensId: 'hat-renderer', strippedMessage: 'hi' }],
  ['hat-renderer: hi',                               { lensId: 'hat-renderer', strippedMessage: 'hi' }],
  ['   Harvester: leading whitespace ok',            { lensId: 'harvester', strippedMessage: 'leading whitespace ok' }],
  ['Harvester - dash separator',                     { lensId: 'harvester', strippedMessage: 'dash separator' }],
  ['Harvester, comma separator',                     { lensId: 'harvester', strippedMessage: 'comma separator' }],
  ['hey Harvester look at X',                        null], // prefix not at start
  ['Harvester look at X',                            null], // no separator
  ['Harvester:',                                     null], // empty message after prefix
  ['plain feedback message',                         null], // no prefix at all
  ['',                                               null],
];

let pass = 0, fail = 0;
for (const [input, expected] of tests) {
  const got = parseLensPrefix(input, lenses);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} "${input}" → ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
