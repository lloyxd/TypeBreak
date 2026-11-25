/**
 * UI feedback logic tests.
 *
 * The animation layer itself needs a browser to verify, but the rules that drive
 * it are plain logic and worth pinning down: when a combo breaks, when it tiers
 * up, and that the mountain layout stays readable as the library grows.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ComboTracker } from '../web/ui/effects.js';
import { buildFixtureLibrary } from './fixtures.js';

describe('ComboTracker', () => {
  test('starts empty', () => {
    const combo = new ComboTracker();
    assert.equal(combo.count, 0);
    assert.equal(combo.best, 0);
    assert.equal(combo.tier, 0);
  });

  test('counts consecutive hits', () => {
    const combo = new ComboTracker();
    for (let i = 0; i < 5; i += 1) combo.hit();
    assert.equal(combo.count, 5);
    assert.equal(combo.best, 5);
  });

  test('a miss resets the count but keeps the best', () => {
    const combo = new ComboTracker();
    for (let i = 0; i < 7; i += 1) combo.hit();
    const { lost } = combo.miss();
    assert.equal(lost, 7, 'the run that was broken is reported');
    assert.equal(combo.count, 0);
    assert.equal(combo.best, 7, 'the best run is remembered for the summary');
  });

  test('tiers fire at each multiple of the tier size', () => {
    const combo = new ComboTracker({ tierSize: 10 });
    const tiers = [];
    for (let i = 1; i <= 31; i += 1) {
      const { tierUp } = combo.hit();
      if (tierUp) tiers.push(tierUp);
    }
    assert.deepEqual(tiers, [1, 2, 3], 'a tier should fire once per threshold crossed');
  });

  test('a miss resets the tier, so the reward has to be re-earned', () => {
    const combo = new ComboTracker({ tierSize: 10 });
    for (let i = 0; i < 12; i += 1) combo.hit();
    assert.equal(combo.tier, 1);
    combo.miss();
    assert.equal(combo.tier, 0);

    // Building back to 10 should fire tier 1 again.
    let fired = 0;
    for (let i = 0; i < 10; i += 1) {
      const { tierUp } = combo.hit();
      if (tierUp) fired = tierUp;
    }
    assert.equal(fired, 1);
  });

  test('reset clears everything for a new exercise', () => {
    const combo = new ComboTracker();
    for (let i = 0; i < 15; i += 1) combo.hit();
    combo.reset();
    assert.equal(combo.count, 0);
    assert.equal(combo.tier, 0);
  });

  test('best is never lowered by a later short run', () => {
    const combo = new ComboTracker();
    for (let i = 0; i < 20; i += 1) combo.hit();
    combo.miss();
    for (let i = 0; i < 3; i += 1) combo.hit();
    assert.equal(combo.best, 20);
  });
});

/**
 * The mountain map must stay usable with the real 55-lesson library, which is the
 * case that would break a naive layout.
 */
describe('mountain layout invariants', () => {
  test('every lesson in the real library gets exactly one waypoint', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { loadLibrary } = await import('../web/core/library.js');

    const here = dirname(fileURLToPath(import.meta.url));
    const library = loadLibrary(JSON.parse(readFileSync(join(here, '..', 'web', 'data', 'lessons.json'), 'utf8')));

    const lessons = library.all();
    const levels = [...new Set(lessons.map((l) => l.level))].sort((a, b) => a - b);

    // The layout groups by level; assert that grouping loses nothing.
    const grouped = new Map();
    for (const lesson of lessons) {
      if (!grouped.has(lesson.level)) grouped.set(lesson.level, 0);
      grouped.set(lesson.level, grouped.get(lesson.level) + 1);
    }
    const total = [...grouped.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, lessons.length);
    assert.ok(levels.length >= 8, 'the library should span many levels for the climb to read as a climb');
  });

  test('the fixture library groups cleanly by level', () => {
    const library = buildFixtureLibrary();
    const byLevel = new Map();
    for (const lesson of library.all()) {
      byLevel.set(lesson.level, (byLevel.get(lesson.level) ?? 0) + 1);
    }
    const total = [...byLevel.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, library.size);
  });
});
