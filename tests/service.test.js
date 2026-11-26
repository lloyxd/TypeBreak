/**
 * Service integration tests.
 *
 * The service is the single surface the browser app calls, so these exercise
 * exactly what the pages use. A MemoryStore stands in for IndexedDB, which keeps
 * the tests synchronous and focused on service behaviour; the real IndexedDB
 * implementation is covered in `store.test.js`.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { AppService } from '../web/core/service.js';
import { buildFixtureLibrary } from './fixtures.js';
import { MemoryStore } from './memory-store.js';

let clock;
let library;

beforeEach(() => {
  let current = new Date('2026-11-15T09:00:00Z');
  clock = () => new Date(current);
  clock.advance = (ms) => {
    current = new Date(current.getTime() + ms);
  };
  library = buildFixtureLibrary();
});

function newService() {
  return new AppService({
    library,
    now: clock,
    store: new MemoryStore({ now: clock }),
  });
}

/** Type an exercise through the service, optionally mistyping chosen positions. */
function practise(service, lessonId, { mode = 'flow', corrupt = () => false, exerciseIndex = 0 } = {}) {
  const lesson = service.lesson(lessonId);
  const exercise = lesson.exercises[exerciseIndex % lesson.exercises.length];
  void mode;
  const started = service.startSession({ lessonId, exerciseId: exercise.id, mode: 'flow' });
  let i = 0;
  for (const ch of started.text) {
    // `x` and `z` are never in the fixture drills, so either is always wrong.
    const typed = corrupt(i, ch) ? (ch === 'x' ? 'z' : 'x') : ch;
    i += 1;
    service.press({ key: typed });
    clock.advance(150);
  }
  return service.finishSession();
}

describe('lesson access through the service', () => {
  test('exposes the library and its facets', () => {
    const service = newService();
    const overview = service.libraryOverview();
    assert.equal(overview.size, 7);
    assert.ok(overview.facets.fingers.length > 0);
    // The fixture library targets three fingers, not all ten.
    assert.deepEqual(overview.coveredFingers.sort(), ['LINDEX', 'LRING', 'RINDEX']);
  });

  test('lesson lookup returns null for unknown ids', () => {
    const service = newService();
    assert.equal(service.lesson('nope'), null);
  });
});

describe('session lifecycle', () => {
  test('starting a session returns library text, never caller-supplied text', () => {
    const service = newService();
    const session = service.startSession({ lessonId: 'T-INDEX-HOME' });
    const lesson = service.lesson('T-INDEX-HOME');
    assert.equal(session.text, lesson.exercises[0].text);
    assert.ok(session.segments.length > 0);
  });

  test('a session cannot be started for an unknown lesson', () => {
    const service = newService();
    assert.throws(() => service.startSession({ lessonId: 'nope' }));
  });

  test('an exercise id from another lesson is rejected', () => {
    const service = newService();
    assert.throws(() => service.startSession({ lessonId: 'T-INDEX-HOME', exerciseId: 'T-RING-HOME-E1' }));
  });

  test('pressing keys returns segments and live stats', () => {
    const service = newService();
    service.startSession({ lessonId: 'T-INDEX-HOME' });
    const result = service.press({ key: 'f' });
    assert.equal(result.correct, true);
    assert.ok(Array.isArray(result.segments));
    assert.ok(result.stats.accuracy === 100);
    assert.equal(result.progress.percent >= 0, true);
  });

  test('pressing without a session is a clear error', () => {
    const service = newService();
    assert.throws(() => service.press({ key: 'f' }), /No active session/);
  });

  test('finishing persists exactly one attempt', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    assert.equal(service.getState().attempts.length, 1);
  });

  test('finishing twice does not double-count', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    assert.throws(() => service.finishSession(), /No active session/);
    assert.equal(service.getState().attempts.length, 1);
  });

  test('cancelling records nothing', () => {
    const service = newService();
    service.startSession({ lessonId: 'T-INDEX-HOME' });
    service.press({ key: 'f' });
    service.cancelSession();
    assert.equal(service.getState().attempts.length, 0);
  });

  test('two clients keep independent sessions', () => {
    const service = newService();
    service.startSession({ lessonId: 'T-INDEX-HOME', clientId: 'cli' });
    service.startSession({ lessonId: 'T-RING-HOME', clientId: 'web' });
    service.press({ clientId: 'cli', key: 'f' });
    const web = service.press({ clientId: 'web', key: 's' });
    assert.equal(web.correct, true, 'the web session should be on its own text');

    service.finishSession({ clientId: 'cli' });
    service.finishSession({ clientId: 'web' });
    assert.equal(service.getState().attempts.length, 2);
  });
});

describe('attempt evaluation', () => {
  test('a clean attempt passes and reports no mistakes', () => {
    const service = newService();
    const result = practise(service, 'T-INDEX-HOME');
    assert.equal(result.verdict.passed, true);
    assert.deepEqual(result.attributedMistakes, []);
  });

  test('mistakes are attributed to the correct finger', () => {
    const service = newService();
    // Corrupt every 'f' (left index) into 'j'.
    const result = practise(service, 'T-INDEX-HOME', {
      corrupt: (_, ch) => ch === 'f',
    });
    const fingers = result.attributedMistakes.map((m) => m.finger);
    assert.ok(fingers.includes('LINDEX'), `expected LINDEX in ${JSON.stringify(fingers)}`);
    const indexMistake = result.attributedMistakes.find((m) => m.finger === 'LINDEX');
    assert.ok(indexMistake.count > 0);
    assert.ok(indexMistake.movements.length > 0, 'mistakes should name a movement');
  });

  test('a poor attempt fails the criteria with an explanatory message', () => {
    const service = newService();
    const result = practise(service, 'T-INDEX-HOME', { corrupt: () => true });
    assert.equal(result.verdict.passed, false);
    assert.ok(result.verdict.message.length > 20);
  });

  test('a single mistake does not make a lesson unpassable', () => {
    // Regression: completion used to be derived from correct characters, so any
    // mistake capped completion below 100% and the lesson could never pass.
    const service = newService();
    const lesson = service.lesson('T-INDEX-HOME');
    const total = lesson.exercises[0].text.length;
    const result = practise(service, 'T-INDEX-HOME', {
      // Exactly one wrong key, early in the exercise.
      corrupt: (index) => index === 0,
    });
    assert.equal(result.record.metrics.completion, 100, `completion should still reach 100 (text was ${total} chars)`);
    assert.equal(result.record.metrics.errors, 1);
    // Accuracy will be below target on such a short drill, so it still fails —
    // but it fails on accuracy, not on an unreachable completion.
    assert.equal(result.verdict.meetsAccuracy, false);
    assert.match(result.verdict.message, /accuracy/i, 'the message should name accuracy as the problem');
  });

  test('recordAttempt rejects an exercise from a different lesson', () => {
    const service = newService();
    const session = service.startSession({ lessonId: 'T-INDEX-HOME' });
    void session;
    // Build a plausible record but pair it with the wrong exercise.
    const bogus = {
      lessonId: 'T-RING-HOME',
      exerciseId: 'T-INDEX-HOME-E1',
      metrics: { wpm: 10, accuracy: 99, errors: 0, elapsedMs: 1000, completion: 100, correctChars: 10, totalKeystrokes: 10 },
      errorsByChar: {},
      errorsByFinger: {},
      errorsByMovement: {},
      fingerStats: {},
      movementStats: {},
    };
    assert.throws(() => service.recordAttempt(bogus), /not part of lesson/);
  });
});

describe('progress derivation', () => {
  test('an attempt updates finger progress', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    const fingers = service.fingerProgress();
    const index = fingers.find((f) => f.finger === 'LINDEX');
    assert.ok(index.total > 0, 'the left index should have character data');
    assert.equal(index.accuracy, 100);
  });

  test('lesson progress reflects the pass', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    const progress = service.lessonProgress().find((l) => l.lessonId === 'T-INDEX-HOME');
    assert.equal(progress.passed, true);
    assert.equal(progress.attempts, 1);
  });

  test('streak counts consecutive days', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    clock.advance(86400000);
    practise(service, 'T-INDEX-HOME');
    const stats = service.stats();
    assert.equal(stats.streak.current, 2);
  });

  test('history includes today after practising', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    const history = service.history({ days: 7 });
    const today = history.days[history.days.length - 1];
    assert.equal(today.attempts, 1);
  });
});

describe('plan and task persistence', () => {
  test("today's plan is saved and reused", () => {
    const service = newService();
    const first = service.todaysPlan();
    const second = service.todaysPlan();
    assert.equal(second.reused, true);
    assert.deepEqual(
      second.items.map((i) => i.lessonId),
      first.items.map((i) => i.lessonId),
    );
  });

  test('the plan is written to storage, not just held in memory', () => {
    const service = newService();
    const first = service.todaysPlan();
    // The plan must exist in the persisted document, so a reload restores it
    // instead of generating a different selection.
    const stored = service.getState().plans[first.date];
    assert.ok(stored, 'the plan should be persisted under its date');
    assert.deepEqual(
      stored.items.map((i) => i.lessonId),
      first.items.map((i) => i.lessonId),
    );
  });

  test('an attempt is persisted through the store, so it survives a reload', () => {
    const store = new MemoryStore({ now: clock });
    const service = new AppService({ library, now: clock, store });
    practise(service, 'T-INDEX-HOME');

    assert.equal(store.getState().attempts.length, 1, 'the attempt must be in the store');
    assert.equal(store.writeCount > 0, true, 'a write should have been issued');

    // A second service over the same store is what a page reload looks like.
    const reloaded = new AppService({ library, now: clock, store });
    const stats = reloaded.stats();
    assert.equal(stats.attempts, 1);
    const fingers = reloaded.fingerProgress().find((f) => f.finger === 'LINDEX');
    assert.ok(fingers.total > 0);
  });

  test('plan regeneration changes nothing when performance is unchanged', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    const a = service.todaysPlan({ force: true });
    const b = service.todaysPlan({ force: true });
    assert.deepEqual(a.items.map((i) => i.lessonId), b.items.map((i) => i.lessonId));
  });

  test('tasks are persisted-agnostic and derived from the plan', () => {
    const service = newService();
    const tasks = service.todaysTasks();
    assert.ok(tasks.tasks.length > 0);
    assert.equal(tasks.date, service.stats().today);
  });
});

describe('settings and reset', () => {
  test('settings update and are written to storage', () => {
    const store = new MemoryStore({ now: clock });
    const service = new AppService({ library, now: clock, store });

    service.updateSettings({ mode: 'strict', dailyGoalExercises: 9 });
    assert.equal(service.settings().mode, 'strict');

    // Read back from the store, as a reload would.
    assert.equal(store.getState().profile.settings.mode, 'strict');
    assert.equal(store.getState().profile.settings.dailyGoalExercises, 9);
  });

  test('reset clears attempts and plans', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    service.todaysPlan();
    service.resetProgress();
    assert.equal(service.getState().attempts.length, 0);
    assert.deepEqual(service.getState().plans, {});
  });
});

describe('dashboard payload', () => {
  test('has everything the dashboard renders', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    const dashboard = service.dashboard();
    for (const key of ['today', 'streak', 'overall', 'totals', 'plan', 'tasks', 'weaknesses', 'fingers', 'recentAttempts']) {
      assert.ok(key in dashboard, `dashboard is missing ${key}`);
    }
    assert.ok(dashboard.plan.items.every((i) => i.name), 'plan items need display names');
    assert.equal(dashboard.fingers.length, 10);
  });

  test('the dashboard is JSON-serialisable (the web server sends it verbatim)', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    assert.doesNotThrow(() => JSON.stringify(service.dashboard()));
  });
});

describe('the adaptive payload', () => {
  test('assessment is JSON-serialisable and complete', () => {
    const service = newService();
    const payload = service.assessment();
    assert.ok(payload.weaknesses);
    assert.ok(payload.plan);
    assert.ok(payload.tasks);
    assert.ok(Array.isArray(payload.recommendations));
    assert.doesNotThrow(() => JSON.stringify(payload));
  });

  test('every recommendation references a real lesson', () => {
    const service = newService();
    practise(service, 'T-INDEX-HOME');
    for (const rec of service.recommendations(10)) {
      assert.ok(service.lesson(rec.lessonId), `${rec.lessonId} should exist`);
    }
  });
});

describe('free practice sessions', () => {
  test('finish does not write an attempt', () => {
    const service = newService();
    const started = service.startFreeSession({ text: 'hi there' });
    assert.equal(started.ephemeral, true);
    for (const ch of 'hi there') service.press({ key: ch });
    const result = service.finishSession();
    assert.equal(result.ephemeral, true);
    assert.equal(service.getState().attempts.length, 0);
  });

  test('empty text is refused', () => {
    const service = newService();
    assert.throws(() => service.startFreeSession({ text: '' }));
  });
});
