/**
 * Requirements tests.
 *
 * Each test here maps to a numbered non-negotiable requirement from the brief.
 * They are written against the public modules so a refactor cannot quietly drop
 * one of the guarantees.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MOVEMENTS, FINGERS, describeChar, KEY_TABLE_SOURCE } from '../web/core/keyboard.js';
import { identifyWeaknesses, planDay, scoreLessons, BTS_CONFIG } from '../web/core/bts.js';
import { buildSnapshot } from '../web/core/profiles.js';
import { buildFixtureLibrary, attempt, weakFingerAttempts, stateWith } from './fixtures.js';

const NOW = new Date('2026-11-15T10:00:00');

/**
 * Requirement 1: the library is predefined and is the single source of truth.
 *
 * Proven structurally: the library module accepts a document and returns a
 * frozen, validated facade. There is no code path that appends to it.
 */
describe('R1 — the library is predefined and authoritative', () => {
  test('the library exposes no mutation API', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    const apiSurface = Object.keys(library);
    for (const forbidden of ['add', 'insert', 'create', 'remove', 'delete', 'set', 'push', 'update']) {
      assert.equal(apiSurface.includes(forbidden), false, `library must not expose ${forbidden}()`);
    }
  });

  test('lessons cannot be mutated through the library', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    const lesson = library.all()[0];
    assert.throws(() => {
      lesson.criteria.minAccuracy = 1;
    }, 'lesson objects must be frozen');
  });

  test('every lesson and exercise ultimately comes from the JSON document', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(join(here, '..', 'web', 'data', 'lessons.json'), 'utf8'));

    const library = await loadRealLibrary();
    const rawIds = new Set(raw.lessons.flatMap((l) => l.exercises.map((e) => e.id)));
    const libraryIds = new Set(library.all().flatMap((l) => l.exercises.map((e) => e.id)));

    assert.equal(libraryIds.size, rawIds.size);
    for (const id of libraryIds) assert.ok(rawIds.has(id), `${id} is not in the source document`);
  });
});

/**
 * Requirement 2 & 3: the adaptive system never generates exercises, and the
 * planner only selects, orders and combines existing lessons.
 */
describe('R2/R3 — no generated content, selection only', () => {
  test('a plan contains only ids that resolve in the library', () => {
    const library = buildFixtureLibrary();
    const attempts = weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 5, accuracy: 60 });
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });

    for (const item of plan.items) {
      assert.ok(library.has(item.lessonId), `plan item ${item.lessonId} is not a library lesson`);
    }
  });

  test('a plan item carries no exercise text of its own', () => {
    const library = buildFixtureLibrary();
    const snapshot = buildSnapshot({ state: stateWith([]), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });
    for (const item of plan.items) {
      assert.equal('text' in item, false);
      assert.equal('exercises' in item, false);
      assert.equal('content' in item, false);
    }
  });

  test('planning cannot introduce a lesson id absent from the library', () => {
    const library = buildFixtureLibrary();
    // Even with absurd history, the id set is closed.
    const attempts = Array.from({ length: 40 }, (_, i) =>
      attempt({ lessonId: 'T-RING-HOME', accuracy: 40, wpm: 10, finishedAt: new Date(NOW.getTime() - i * 3600000).toISOString() }),
    );
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });
    const valid = new Set(library.all().map((l) => l.id));
    assert.equal(plan.items.every((i) => valid.has(i.lessonId)), true);
  });

  test('the library content itself never changes after planning', () => {
    const library = buildFixtureLibrary();
    const before = JSON.stringify(library.all().map((l) => l.exercises.map((e) => e.text)));
    const snapshot = buildSnapshot({ state: stateWith([]), library, now: NOW });
    planDay({ ...snapshot, __library: library }, library, { now: NOW });
    const after = JSON.stringify(library.all().map((l) => l.exercises.map((e) => e.text)));
    assert.equal(after, before, 'planning must not modify exercise text');
  });
});

/** Requirement 4: recommendations are based on actual performance. */
describe('R4 — recommendations follow measured performance', () => {
  test('with no performance data, no weakness is claimed', () => {
    const library = buildFixtureLibrary();
    const snapshot = buildSnapshot({ state: stateWith([]), library, now: NOW });
    const result = identifyWeaknesses(snapshot);
    assert.equal(result.weakFingers.length, 0);
    assert.equal(result.summary.hasEnoughData, false);
  });

  test('the weakest finger drives the top recommendation', () => {
    const library = buildFixtureLibrary();
    const attempts = [
      ...weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 6, accuracy: 55 }),
      ...Array.from({ length: 6 }, (_, i) =>
        attempt({
          lessonId: 'T-INDEX-HOME',
          accuracy: 99,
          finishedAt: new Date(NOW.getTime() - i * 3600000).toISOString(),
          fingerStats: { LINDEX: { correct: 100, wrong: 0, total: 100 } },
        }),
      ),
    ];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const weaknesses = identifyWeaknesses(snapshot);
    assert.equal(weaknesses.weakFingers[0].finger, 'LRING');

    const scored = scoreLessons({ ...snapshot, __weaknesses: weaknesses }, library);
    const top = scored[0];
    assert.ok(
      top.lesson.fingers.includes('LRING'),
      `the top recommendation (${top.lessonId}) should target the weak finger`,
    );
  });
});

/** Requirement 5: all ten fingers and their movements are covered. */
describe('R5 — full finger and movement coverage', () => {
  test('the keyboard model maps every finger', () => {
    for (const finger of FINGERS) {
      const keys = KEY_TABLE_SOURCE.filter(([, f]) => f === finger);
      if (finger === 'LTHUMB' || finger === 'RTHUMB') {
        // Thumbs own only the space bar, which is mapped separately because
        // both thumbs share it.
        assert.equal(keys.length, 0, 'thumbs should not appear in the key table');
        assert.equal(describeChar(' ').movement, 'space');
      } else {
        assert.ok(keys.length > 0, `${finger} has no keys`);
      }
    }
  });

  test('every movement variation is exercised by at least one real lesson', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    for (const movement of Object.keys(MOVEMENTS)) {
      const lessons = library.filter({ movement });
      assert.ok(lessons.length > 0, `movement ${movement} has no lesson`);
    }
  });

  test('every finger is an explicit target of at least one real lesson', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    for (const finger of FINGERS) {
      const lessons = library.filter({ finger });
      assert.ok(lessons.length > 0, `finger ${finger} has no lesson`);
    }
  });

  test('every character in every exercise is attributable to a finger', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    for (const lesson of library.all()) {
      for (const exercise of lesson.exercises) {
        for (const ch of exercise.text) {
          assert.ok(describeChar(ch).finger, `"${ch}" in ${exercise.id} has no finger`);
        }
      }
    }
  });
});

/** Requirement 6: future plans adapt as performance changes. */
describe('R6 — plans adapt to changing performance', () => {
  test('a declining finger changes the plan', () => {
    const library = buildFixtureLibrary();
    const good = Array.from({ length: 6 }, (_, i) =>
      attempt({
        lessonId: 'T-RING-HOME',
        accuracy: 99,
        finishedAt: new Date(NOW.getTime() - i * 3600000).toISOString(),
        fingerStats: { LRING: { correct: 100, wrong: 0, total: 100 } },
      }),
    );
    const bad = Array.from({ length: 6 }, (_, i) =>
      attempt({
        lessonId: 'T-RING-HOME',
        accuracy: 55,
        finishedAt: new Date(NOW.getTime() - i * 3600000).toISOString(),
        fingerStats: { LRING: { correct: 55, wrong: 45, total: 100 } },
      }),
    );

    const goodSnap = buildSnapshot({ state: stateWith(good), library, now: NOW });
    const badSnap = buildSnapshot({ state: stateWith(bad), library, now: NOW });

    const goodPlan = planDay({ ...goodSnap, __library: library }, library, { now: NOW });
    const badPlan = planDay({ ...badSnap, __library: library }, library, { now: NOW });

    assert.equal(goodPlan.buckets.weakness.length, 0, 'a healthy finger needs no weakness work');
    assert.ok(badPlan.buckets.weakness.length > 0, 'a weak finger must attract weakness work');
  });

  test('improvement reduces weakness emphasis over time', () => {
    const library = buildFixtureLibrary();
    // Phase 1: bad. Phase 2: recent good attempts.
    const attempts = [
      ...weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 4, accuracy: 60, startDate: '2026-11-01T09:00:00.000Z' }),
      ...Array.from({ length: 6 }, (_, i) =>
        attempt({
          lessonId: 'T-RING-HOME',
          accuracy: 99,
          finishedAt: new Date(new Date('2026-11-12T09:00:00.000Z').getTime() + i * 3600000).toISOString(),
          fingerStats: { LRING: { correct: 100, wrong: 0, total: 100 } },
        }),
      ),
    ];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const weaknesses = identifyWeaknesses(snapshot);
    // Cumulative accuracy improved, and the recent trend is up.
    const ring = weaknesses.fingerEvals.find((f) => f.finger === 'LRING');
    assert.equal(ring.trend, 'improving');
  });
});

/** Requirement 7: balance between weakness work and overall development. */
describe('R7 — the plan stays balanced', () => {
  test('weakness work is capped as a share of the plan', () => {
    const library = buildFixtureLibrary();
    // Make both fingers in the fixture look terrible.
    const attempts = [
      ...weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 5, accuracy: 45 }),
      ...weakFingerAttempts({ lessonId: 'T-INDEX-HOME', finger: 'LINDEX', days: 5, accuracy: 45 }),
    ];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });

    // The plan must always report its composition honestly.
    assert.ok(plan.balance, 'the plan must report its balance');
    assert.equal(typeof plan.balance.weaknessShare, 'number');

    const share = plan.buckets.weakness.length / plan.items.length;
    if (plan.balance.status === 'balanced') {
      assert.ok(share <= 0.6 + 1e-9, `balanced plans must respect the 60% ceiling, got ${share}`);
    } else {
      // A tiny library can genuinely have no non-weakness material. In that case
      // the limitation must be stated, not hidden.
      assert.equal(plan.balance.status, 'weakness-limited');
      assert.ok(plan.balance.note.length > 30, 'the limitation must be explained to the user');
    }
  });

  test('on the full library, the 60% ceiling is always met', async () => {
    const { loadRealLibrary } = await import('./fixtures.js');
    const library = await loadRealLibrary();
    // A learner who is bad at the left hand across the board.
    const attempts = ['LPINKY', 'LRING', 'LMIDDLE', 'LINDEX'].flatMap((finger) =>
      weakFingerAttempts({ lessonId: 'L-LINDEX-HOME', finger, days: 4, accuracy: 50, perDay: 2 }),
    );
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });

    const share = plan.buckets.weakness.length / plan.items.length;
    assert.equal(plan.balance.status, 'balanced', 'the real library has enough variety to balance the plan');
    assert.ok(share <= 0.6 + 1e-9, `weakness share ${share} must not exceed 60%`);
    assert.ok(
      plan.buckets.progression.length + plan.buckets.maintenance.length >= 1,
      'some non-weakness work must be present',
    );
  });

  test('a balanced plan always includes some non-weakness work when possible', () => {
    const library = buildFixtureLibrary();
    const attempts = weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 5, accuracy: 50 });
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });
    const nonWeakness = plan.items.filter((i) => i.kind !== 'weakness');
    assert.ok(nonWeakness.length >= 1, 'requirement 7 requires some progression or maintenance work');
  });

  test('the configured slots sum to the plan size', () => {
    assert.equal(
      BTS_CONFIG.weaknessSlots + BTS_CONFIG.progressionSlots + BTS_CONFIG.maintenanceSlots,
      BTS_CONFIG.planSize,
      'the three practice kinds should exactly fill a plan',
    );
  });
});

/** Requirement 9: the user can see why lessons are recommended. */
describe('R9 — every recommendation is explainable', () => {
  test('each plan item has readable reasons', () => {
    const library = buildFixtureLibrary();
    const attempts = weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 5, accuracy: 55 });
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });

    for (const item of plan.items) {
      assert.ok(item.reasons.length > 0);
      for (const reason of item.reasons) {
        assert.ok(reason.length > 15, `reason "${reason}" is too terse to be useful`);
        assert.match(reason, /[a-z]/, 'reason should be prose, not an identifier');
      }
    }
  });

  test('the plan explanation is a readable sentence', () => {
    const library = buildFixtureLibrary();
    const snapshot = buildSnapshot({ state: stateWith([]), library, now: NOW });
    const plan = planDay({ ...snapshot, __library: library }, library, { now: NOW });
    assert.ok(plan.explanation.length > 60);
    assert.match(plan.explanation, /lesson/i);
  });

  test('score signals name the factor behind each contribution', () => {
    const library = buildFixtureLibrary();
    const attempts = weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 5, accuracy: 55 });
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    const withSignals = scored.filter((s) => s.signals.length > 0);
    assert.ok(withSignals.length > 0, 'at least some lessons should have signals');
    for (const entry of withSignals) {
      for (const signal of entry.signals) {
        assert.equal(typeof signal.id, 'string');
        assert.equal(typeof signal.weight, 'number');
        assert.ok(signal.id.length > 0);
      }
    }
  });
});

/** Requirement 10: progress reflects demonstrated ability, not completion. */
describe('R10 — progress reflects demonstrated ability', () => {
  test('attempting a lesson without meeting criteria does not mark it passed', () => {
    const library = buildFixtureLibrary();
    const attempts = [
      attempt({ lessonId: 'T-INDEX-HOME', accuracy: 70, wpm: 40, errors: 30 }),
      attempt({ lessonId: 'T-INDEX-HOME', accuracy: 72, wpm: 40, errors: 28 }),
    ];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    assert.equal(snapshot.lessonProgress['T-INDEX-HOME'].passed, false);
    assert.ok(snapshot.lessonProgress['T-INDEX-HOME'].attempts === 2, 'attempts are still recorded');
  });

  test('meeting the accuracy bar marks the lesson passed', () => {
    const library = buildFixtureLibrary();
    const attempts = [attempt({ lessonId: 'T-INDEX-HOME', accuracy: 98, wpm: 30 })];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    assert.equal(snapshot.lessonProgress['T-INDEX-HOME'].passed, true);
  });

  test('speed alone cannot pass a lesson', () => {
    const library = buildFixtureLibrary();
    // Fast but inaccurate: the criteria must gate on accuracy.
    const attempts = [attempt({ lessonId: 'T-INDEX-HOME', accuracy: 80, wpm: 120 })];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    assert.equal(snapshot.lessonProgress['T-INDEX-HOME'].passed, false);
  });

  test('overall progress needs demonstrated accuracy, not just completions', () => {
    const library = buildFixtureLibrary();
    const attempts = [attempt({ lessonId: 'T-INDEX-HOME', accuracy: 98, wpm: 30 })];
    const snapshot = buildSnapshot({ state: stateWith(attempts), library, now: NOW });
    // One lesson passed out of six is a real but small gain.
    assert.ok(snapshot.overall.percent > 0);
    assert.ok(snapshot.overall.percent < 100);
    assert.equal(snapshot.overall.lessonsPassed, 1);
    assert.equal(snapshot.overall.lessonsTotal, 7);
  });

  test('a lesson passed with high accuracy scores more stars than a bare pass', () => {
    const library = buildFixtureLibrary();
    const lesson = library.get('T-INDEX-HOME');
    const allExercises = lesson.exercises.map((ex, i) =>
      attempt({
        lessonId: lesson.id,
        exerciseId: ex.id,
        accuracy: 100,
        wpm: 40,
        errors: 0,
        finishedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
      }),
    );
    const snapshot = buildSnapshot({ state: stateWith(allExercises), library, now: NOW });
    assert.equal(snapshot.lessonProgress[lesson.id].stars, 3);
  });
});

/**
 * Requirement 8 (revised for the client-side architecture): a single local core.
 *
 * The app must be entirely client-side, with all learning logic in shared
 * modules rather than duplicated in pages, and no network dependency anywhere.
 */
describe('R8 — one local core, no backend', () => {
  const read = async (relPath) => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', relPath), 'utf8');
  };

  test('there is no server or CLI in the project', async () => {
    const { existsSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '..');

    assert.equal(existsSync(join(root, 'src')), false, 'the src/ tree (CLI + server) should be gone');
    assert.equal(existsSync(join(root, 'web', 'api.js')), false, 'the HTTP API client should be gone');
  });

  test('no core or page module imports network APIs', async () => {
    const files = [
      'web/core/service.js',
      'web/core/bts.js',
      'web/core/engine.js',
      'web/core/profiles.js',
      'web/core/library.js',
      'web/core/keyboard.js',
      'web/core/backup.js',
      'web/pages/dashboard.js',
      'web/pages/practice.js',
      'web/pages/progress.js',
      'web/pages/adaptive.js',
      'web/pages/free-practice.js',
      'web/pages/lessons.js',
      'web/core/words.js',
      'web/core/lesson-flow.js',
    ];

    for (const file of files) {
      const source = await read(file);
      for (const forbidden of ['XMLHttpRequest', '/api/', 'fetch(']) {
        // `fetch` is allowed only in the library loader inside service.js, which
        // reads a static local file rather than calling a service.
        if (forbidden === 'fetch(' && file === 'web/core/service.js') continue;
        assert.equal(
          source.includes(forbidden),
          false,
          `${file} must not use ${forbidden} — the app has no backend`,
        );
      }
    }
  });

  test('the only fetch in the app reads the local lesson library', async () => {
    const source = await read('web/core/service.js');
    const fetchCalls = source.match(/fetch\(/g) ?? [];
    assert.equal(fetchCalls.length, 1, 'exactly one fetch should exist');
    assert.match(source, /fetch\(url/, 'and it should target the library URL, not an endpoint');
    assert.match(source, /lessons\.json/, 'the library is a static asset');
  });

  test('the core modules never import Node built-ins', async () => {
    const files = [
      'web/core/service.js',
      'web/core/db.js',
      'web/core/backup.js',
      'web/core/bts.js',
      'web/core/engine.js',
      'web/core/profiles.js',
      'web/core/library.js',
      'web/core/keyboard.js',
      'web/core/context.js',
      'web/client.js',
      'web/app.js',
    ];
    for (const file of files) {
      const source = await read(file);
      assert.equal(
        /from 'node:/.test(source),
        false,
        `${file} must not import a Node built-in — it runs in the browser`,
      );
    }
  });

  test('pages read data through the client adapter, not from each other', async () => {
    for (const page of ['dashboard', 'lessons', 'practice', 'free-practice', 'progress', 'adaptive', 'settings']) {
      const source = await read(`web/pages/${page}.js`);
      assert.match(
        source,
        /from '\.\.\/client\.js'/,
        `${page} should get its data from client.js`,
      );
    }
  });

  test('BTS logic lives only in bts.js', async () => {
    for (const file of ['web/pages/adaptive.js', 'web/pages/dashboard.js', 'web/client.js', 'web/app.js']) {
      const source = await read(file);
      assert.equal(
        /function identifyWeaknesses/.test(source),
        false,
        `${file} must not reimplement weakness detection`,
      );
      assert.equal(
        /correctChars\s*\/\s*5\s*\//.test(source),
        false,
        `${file} must not compute WPM itself`,
      );
    }
  });
});
