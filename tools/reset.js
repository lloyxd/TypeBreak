/**
 * Delete all recorded progress.
 *
 * Keeps the lesson library (which is generated, not user data) and removes the
 * state document plus its backup.
 *
 *   npm run reset
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const statePath = join(HERE, '..', 'data', 'state.json');

const targets = [statePath, `${statePath}.bak`, `${statePath}.tmp`];
let removed = 0;

for (const path of targets) {
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`Removed ${path}`);
    removed += 1;
  }
}

// Also clear any quarantined corrupt files from a previous crash.
import { readdirSync, rmSync } from 'node:fs';
const dataDir = join(HERE, '..', 'data');
if (existsSync(dataDir)) {
  for (const entry of readdirSync(dataDir)) {
    if (entry.includes('.corrupt-')) {
      rmSync(join(dataDir, entry), { force: true });
      console.log(`Removed data/${entry}`);
      removed += 1;
    }
  }
}

console.log(removed ? 'Progress reset.' : 'No progress to reset.');
