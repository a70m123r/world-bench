// v0.7 DEBUG: lens.json write trap
// Instead of patching fs.writeFileSync (read-only in Node 22),
// add a direct check function that callers can use.
// We'll grep for the culprit by adding console.trace() directly
// to the write sites instead.
//
// This file now just exports a helper that index.ts calls
// right before any lens.json write.

export function trapLensJsonWrite(filePath: string, data: string): void {
  if (!filePath.includes('lens.json')) return;

  let hasChannelId = false;
  try {
    const parsed = JSON.parse(data);
    hasChannelId = !!parsed?.slack_channel_id;
  } catch { }

  if (!hasChannelId) {
    console.warn(`\n[TRAP] ⚠️ lens.json WRITE WITHOUT slack_channel_id!`);
    console.warn(`  path: ${filePath}`);
    console.trace('  Write origin:');
    console.warn('');
  }
}
