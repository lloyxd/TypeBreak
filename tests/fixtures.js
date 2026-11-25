/**
 * Shared test fixtures: a tiny deterministic library and a fixed clock.
 *
 * Using a fixture library keeps tests fast and makes the planner's behaviour
 * obvious, while one test also runs against the real library to catch drift.
 */

import { loadLibrary } from '../src/core/library.js';

/** Fixed clock so streaks, staleness and date keys are reproducible. */
export const FIXED_NOW = new Date('2026-11-15T10:00:00');

export function clock(startIso = FIXED_NOW.toISOString()) {
  let current = new Date(startIso);
  const now = () => new Date(current);
  now.advance = (ms) => {
    current = new Date(current.getTime() + ms);
  };
  now.advanceDays = (days) => now.advance(days * 86400000);
  now.set = (iso) => {
    current = new Date(iso);
  };
  return now;
}

function lesson(spec) {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? 'A test lesson.',
    category: spec.category ?? 'finger-isolation',
    level: spec.level,
    fingers: spec.fingers,
    movements: spec.movements,
    keys: spec.keys ?? ['f'],
    exercises: (spec.texts ?? ['ffff ffff']).map((text, i) => ({
      id: `${spec.id}-E${i + 1}`,
      text,
      focus: 'f',
    })),
    outcome: 'Test outcome.',
    related: spec.related ?? [],
    criteria: {
      minAccuracy: spec.minAccuracy ?? 95,
      minWpm: spec.minWpm ?? 20,
      attempts: 2,
      speedIsAdvisory: true,
    },
    estimatedSeconds: spec.estimatedSeconds ?? 60,
    order: spec.order ?? 0,
  };
}

/**
 * Six lessons forming a small but complete ladder:
 *   index home (L1), index up (L2), ring home (L3), ring up (L4),
 *   a two-finger coordination lesson (L5), and a pattern lesson (L6).
 */
export function buildFixtureLibrary() {
  const lessons = [
    lesson({
      id: 'T-INDEX-HOME',
      name: 'Index home',
      level: 1,
      fingers: ['LINDEX'],
      movements: ['home'],
      texts: ['ff jf ff', 'fj ff jj'],
      related: ['T-INDEX-UP'],
    }),
    lesson({
      id: 'T-INDEX-UP',
      name: 'Index up',
      level: 2,
      fingers: ['LINDEX'],
      movements: ['up'],
      texts: ['rr ff rr', 'fr rf fr'],
      related: ['T-INDEX-HOME'],
    }),
    lesson({
      id: 'T-RING-HOME',
      name: 'Ring home',
      level: 3,
      fingers: ['LRING'],
      movements: ['home'],
      texts: ['ss dd ss', 'sd ds sd'],
      category: 'movement-variation',
      related: ['T-RING-UP'],
    }),
    lesson({
      id: 'T-RING-UP',
      name: 'Ring up',
      level: 4,
      fingers: ['LRING'],
      movements: ['up'],
      texts: ['ww ss ww', 'ws sw ws'],
      category: 'movement-variation',
      related: ['T-RING-HOME'],
    }),
    lesson({
      id: 'T-COMBO',
      name: 'Two-finger combo',
      level: 5,
      fingers: ['LINDEX', 'LRING'],
      movements: ['home', 'up'],
      texts: ['fs dr fs', 'rf ds rf'],
      category: 'finger-combination',
    }),
    lesson({
      id: 'T-PATTERN',
      name: 'Pattern drill',
      level: 6,
      fingers: ['LINDEX', 'LRING'],
      movements: ['digraph'],
      texts: ['fs fs fs', 'dr dr dr'],
      category: 'pattern',
      minAccuracy: 90,
    }),
    lesson({
      // A third finger, unrelated to the others, so tests can exercise a plan
      // where non-weakness material exists.
      id: 'T-RINDEX-HOME',
      name: 'Right index home',
      level: 1,
      fingers: ['RINDEX'],
      movements: ['home'],
      texts: ['jj kk jj', 'jk kj jk'],
      related: [],
    }),
  ];

  lessons.forEach((l, i) => {
    l.order = i;
  });

  return loadLibrary({
    schemaVersion: 1,
    counts: { lessons: lessons.length },
    lessons,
  });
}

/** Load the real generated library from disk. */
export async function loadRealLibrary() {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  return loadLibrary(JSON.parse(readFileSync(join(here, '..', 'data', 'lessons.json'), 'utf8')));
}

/**
 * Build a fake attempt record.
 *
 * @param {object} opts
 * @param {string} opts.lessonId
 * @param {string} [opts.exerciseId]
 * @param {number} [opts.accuracy]   percentage
 * @param {number} [opts.wpm]
 * @param {number} [opts.errors]
 * @param {number} [opts.elapsedMs]
 * @param {string} [opts.finishedAt] ISO timestamp
 * @param {object} [opts.fingerStats]
 * @param {object} [opts.movementStats]
 */
export function attempt({
  lessonId,
  exerciseId = `${lessonId}-E1`,
  accuracy = 98,
  wpm = 30,
  errors = 1,
  elapsedMs = 60000,
  finishedAt = FIXED_NOW.toISOString(),
  fingerStats = null,
  movementStats = null,
  errorsByChar = {},
  mode = 'flow',
} = {}) {
  const totalKeystrokes = 100;
  return {
    lessonId,
    exerciseId,
    mode,
    text: 'ffff',
    metrics: {
      wpm,
      cpm: wpm * 5,
      grossWpm: wpm,
      accuracy,
      errors,
      correctChars: Math.round((accuracy / 100) * totalKeystrokes),
      totalKeystrokes,
      elapsedMs,
      completion: 100,
    },
    errorsByChar,
    errorsByFinger: {},
    errorsByMovement: {},
    fingerStats: fingerStats ?? {},
    movementStats: movementStats ?? {},
    keystrokes: [],
    startedAt: new Date(new Date(finishedAt).getTime() - elapsedMs).toISOString(),
    finishedAt,
    fullyCorrect: errors === 0,
  };
}

/**
 * Generate a sequence of attempts that establish a clear finger pattern:
 * `badFinger` performs poorly across many attempts while others stay clean.
 */
export function weakFingerAttempts({
  lessonId,
  finger,
  days = 5,
  perDay = 2,
  accuracy = 70,
  startDate = '2026-11-10T09:00:00.000Z',
}) {
  const out = [];
  // Derive the character tallies from `accuracy` so the fixture cannot produce
  // an internally inconsistent profile (accuracy disagreeing with correct/wrong).
  const total = 100;
  const correct = Math.round((accuracy / 100) * total);
  const wrong = total - correct;

  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const at = new Date(new Date(startDate).getTime() + d * 86400000 + i * 60000).toISOString();
      out.push(
        attempt({
          lessonId,
          accuracy,
          wpm: 22,
          errors: wrong,
          finishedAt: at,
          fingerStats: {
            [finger]: { correct, wrong, total },
          },
          movementStats: { home: { correct, wrong, total } },
        }),
      );
    }
  }
  return out;
}

/** A minimal state document for tests that call the planner directly. */
export function stateWith(attempts, settings = {}) {
  return {
    version: 1,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    profile: { name: 'test', createdAt: FIXED_NOW.toISOString(), settings: { mode: 'flow', dailyGoalExercises: 6, ...settings } },
    attempts,
    fingers: {},
    movements: {},
    lessons: {},
    plans: {},
    tasks: {},
    assessments: {},
  };
}
