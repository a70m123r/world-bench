// v0.7 DEBUG: lens.json write trap
// Wraps fs.writeFileSync to log every write to any lens.json file
// with a stack trace so we can identify who's clobbering slack_channel_id.
// Remove after the clobber is found.

import * as fs from 'fs';

const originalWriteFileSync = fs.writeFileSync;

(fs as any).writeFileSync = function (filePath: any, data: any, ...args: any[]) {
  const pathStr = String(filePath);
  if (pathStr.includes('lens.json')) {
    // Check if slack_channel_id is present in the data being written
    let hasChannelId = false;
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : null;
      hasChannelId = !!parsed?.slack_channel_id;
    } catch { }

    const stack = new Error().stack?.split('\n').slice(1, 5).join('\n  ') || '(no stack)';
    if (!hasChannelId) {
      console.warn(`\n[TRAP] ⚠️ lens.json WRITE WITHOUT slack_channel_id!\n  path: ${pathStr}\n  stack:\n  ${stack}\n`);
    } else {
      console.log(`[TRAP] lens.json write OK (has slack_channel_id) from:\n  ${stack.split('\n')[0]}`);
    }
  }
  return originalWriteFileSync.call(fs, filePath, data, ...args);
};

console.log('[TRAP] lens.json write trap installed');
