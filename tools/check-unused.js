/**
 * Lightweight static check: find imported names that are never used again in
 * the file. Not a parser — good enough to catch dead imports before they rot.
 *
 *   node tools/check-unused.js
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['web', 'tools', 'tests'];
const files = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js')) files.push(path);
  }
}

for (const root of ROOTS) walk(root);

let problems = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const importRe = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/).pop()?.trim())
      .filter(Boolean);
    const rest = source.slice(match.index + match[0].length);
    for (const name of names) {
      const occurrences = rest.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
      if (occurrences.length === 0) {
        console.log(`${file}: unused import "${name}"`);
        problems += 1;
      }
    }
  }
}

if (problems === 0) console.log('No unused imports.');
else console.log(`\n${problems} unused import(s).`);

process.exitCode = problems === 0 ? 0 : 1;
