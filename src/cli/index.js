#!/usr/bin/env node
/**
 * TypeBreak CLI entry point.
 */

import { runCommandLine } from './app.js';

process.on('SIGINT', () => {
  process.stdout.write('\n');
  process.exit(0);
});

runCommandLine(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
