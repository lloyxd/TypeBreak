/**
 * BTS adaptive algorithm tests.
 *
 * These are the tests that enforce the project's non-negotiable requirements:
 *   - the planner only ever selects existing lessons
 *   - it never invents or edits exercise text
 *   - it is deterministic for a given state and date
 *   - one bad attempt can never create a weakness
 *   - weaknesses actually steer the plan
 *   - the plan stays balanced across weakness / progression / maintenance
 *   - every recommendation is explainable
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BTS_CONFIG,
  identifyWeaknesses,
  scoreLessons,
  planDay,
  buildDailyTasks,
  assess,
  assertPlanUsesLibraryOnly,
  evaluateFinger,
} from '../web/core/bts.js';
import { buildSnapshot, buildFingerProfiles } from '../web/core/profiles.js';
import { buildFixtureLibrary, attempt, weakFingerAttempts, stateWith } from './fixtures.js';

/** Build a snapshot for the fixture library from a list of attempts. */
function snapshotFor(attempts, { now = new Date('2026-11-15T10:00:00'), settings = {} } = {}) {
  const library = buildFixtureLibrary();
  const state = stateWith(attempts, settings);
  return { snapshot: buildSnapshot({ state, library, now }), library };
}

/** A learner with a genuinely weak left ring finger. */
function weakRingSetup() {
  const attempts = [
    ...weakFingerAttempts({
      lessonId: 'T-RING-HOME',
      finger: 'LRING',
      days: 5,
      perDay: 2,
      accuracy: 65,
      startDate: '2026-11-09T09:00:00.000Z',
    }),
    // Clean index work on the same days, so LINDEX looks strong.
    ...Array.from({ length: 8 }, (_, i) =>
      attempt({
        lessonId: 'T-INDEX-HOME',
        accuracy: 99,
        wpm: 34,
        errors: 0,
        finishedAt: new Date(new Date('2026-11-09T10:00:00.000Z').getTime() + i * 86400000).toISOString(),
        fingerStats: { LINDEX: { correct: 99, wrong: 1, total: 100 } },
        movementStats: { home: { correct: 99, wrong: 1, total: 100 } },
      }),
    ),
  ];
  return snapshotFor(attempts);
}

describe('weakness identification', () => {
  test('a single bad attempt cannot create a weakness', () => {
    const attempts = [
      attempt({
        lessonId: 'T-RING-HOME',
        accuracy: 20,
        errors: 80,
        fingerStats: { LRING: { correct: 20, wrong: 80, total: 100 } },
      }),
    ];
    const { snapshot } = snapshotFor(attempts);
    const result = identifyWeaknesses(snapshot);
    assert.equal(result.weakFingers.length, 0, 'one attempt is not evidence');
    assert.equal(result.summary.hasEnoughData, false);
  });

  test('two poor attempts without enough characters is still not a weakness', () => {
    const attempts = Array.from({ length: 2 }, () =>
      attempt({
        lessonId: 'T-RING-HOME',
        accuracy: 40,
        errors: 10,
        fingerStats: { LRING: { correct: 5, wrong: 15, total: 20 } },
      }),
    );
    const { snapshot } = snapshotFor(attempts);
    const result = identifyWeaknesses(snapshot);
    assert.equal(result.weakFingers.length, 0, 'not enough characters yet');
  });

  test('consistent poor performance identifies the correct finger', () => {
    const { snapshot } = weakRingSetup();
    const result = identifyWeaknesses(snapshot);
    assert.ok(result.weakFingers.length > 0, 'a real weakness should be found');
    assert.equal(result.weakFingers[0].finger, 'LRING', 'the weak finger should be left ring');
    assert.equal(result.summary.weakest.finger, 'LRING');
    assert.ok(result.weakFingers[0].accuracy < BTS_CONFIG.weaknessAccuracy);
  });

  test('a strong finger is not reported as weak', () => {
    const { snapshot } = weakRingSetup();
    const result = identifyWeaknesses(snapshot);
    const indexEval = result.fingerEvals.find((f) => f.finger === 'LINDEX');
    assert.notEqual(indexEval.status, 'weak');
    assert.notEqual(indexEval.status, 'critical');
    assert.ok(result.summary.strongest, 'a strongest finger should be reported');
  });

  test('findings carry reasons the user can read', () => {
    const { snapshot } = weakRingSetup();
    const result = identifyWeaknesses(snapshot);
    for (const finding of result.findings) {
      assert.ok(finding.title, 'every finding needs a title');
      assert.ok(finding.detail, 'every finding needs a detail');
      assert.ok(Array.isArray(finding.reasons) && finding.reasons.length > 0, 'every finding needs reasons');
      assert.equal(typeof finding.severity, 'number');
    }
  });

  test('severity ordering matches accuracy ordering', () => {
    // Two fingers, both weak, one clearly worse.
    const attempts = [
      ...weakFingerAttempts({ lessonId: 'T-RING-HOME', finger: 'LRING', days: 4, accuracy: 80 }),
      ...weakFingerAttempts({ lessonId: 'T-INDEX-HOME', finger: 'LINDEX', days: 4, accuracy: 50 }),
    ];
    const { snapshot } = snapshotFor(attempts);
    const result = identifyWeaknesses(snapshot);
    const worst = result.weakFingers[0];
    assert.equal(worst.finger, 'LINDEX', 'the lower-accuracy finger must rank first');
    for (let i = 1; i < result.weakFingers.length; i += 1) {
      assert.ok(
        result.weakFingers[i - 1].severity >= result.weakFingers[i].severity,
        'weak fingers must be sorted by descending severity',
      );
    }
  });

  test('regression is detected when recent attempts are worse', () => {
    const attempts = [
      // Early: good.
      ...Array.from({ length: 3 }, (_, i) =>
        attempt({
          lessonId: 'T-RING-HOME',
          accuracy: 99,
          errors: 0,
          finishedAt: new Date(new Date('2026-11-01T09:00:00.000Z').getTime() + i * 86400000).toISOString(),
          fingerStats: { LRING: { correct: 100, wrong: 0, total: 100 } },
        }),
      ),
      // Recent: bad.
      ...Array.from({ length: 3 }, (_, i) =>
        attempt({
          lessonId: 'T-RING-HOME',
          accuracy: 70,
          errors: 30,
          finishedAt: new Date(new Date('2026-11-12T09:00:00.000Z').getTime() + i * 86400000).toISOString(),
          fingerStats: { LRING: { correct: 70, wrong: 30, total: 100 } },
        }),
      ),
    ];
    const { snapshot } = snapshotFor(attempts);
    const profiles = buildFingerProfiles(snapshot.attempts);
    assert.equal(profiles.LRING.trend, 'declining', 'a clear drop should read as declining');
    const result = identifyWeaknesses(snapshot);
    assert.ok(result.regressions.some((r) => r.finger === 'LRING'), 'the regression should be reported');
  });
});

describe('lesson scoring', () => {
  test('every lesson in the library is scored', () => {
    const { snapshot, library } = weakRingSetup();
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    assert.equal(scored.length, library.size);
  });

  test('a lesson targeting the weak finger outranks one that does not', () => {
    const { snapshot, library } = weakRingSetup();
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    const ring = scored.find((s) => s.lessonId === 'T-RING-HOME');
    const index = scored.find((s) => s.lessonId === 'T-INDEX-HOME');
    assert.ok(ring.score > index.score, `ring (${ring.score}) should outrank index (${index.score})`);
  });

  test('every score carries at least one reason', () => {
    const { snapshot, library } = weakRingSetup();
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    for (const entry of scored) {
      assert.ok(entry.reasons.length > 0, `${entry.lessonId} has no reasons`);
      assert.ok(entry.kind, `${entry.lessonId} has no kind`);
      assert.equal(typeof entry.score, 'number');
    }
  });

  test('scores are sorted descending', () => {
    const { snapshot, library } = weakRingSetup();
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    for (let i = 1; i < scored.length; i += 1) {
      assert.ok(scored[i - 1].score >= scored[i].score, 'scores must be descending');
    }
  });

  test('signals explain the score components', () => {
    const { snapshot, library } = weakRingSetup();
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    const ring = scored.find((s) => s.lessonId === 'T-RING-HOME');
    assert.ok(ring.signals.some((s) => s.id === 'weakness'), 'the weakness signal should fire for a weak finger');
  });

  test('a mastered lesson is discounted when no weakness applies', () => {
    // Strong performance on the index lesson, with the index finger strong.
    const attempts = Array.from({ length: 6 }, (_, i) =>
      attempt({
        lessonId: 'T-INDEX-HOME',
        accuracy: 100,
        wpm: 60,
        errors: 0,
        finishedAt: new Date(new Date('2026-11-10T09:00:00.000Z').getTime() + i * 3600000).toISOString(),
        fingerStats: { LINDEX: { correct: 200, wrong: 0, total: 200 } },
      }),
    );
    const { snapshot, library } = snapshotFor(attempts);
    const scored = scoreLessons({ ...snapshot, __weaknesses: identifyWeaknesses(snapshot) }, library);
    const entry = scored.find((s) => s.lessonId === 'T-INDEX-HOME');
    assert.ok(entry.signals.some((s) => s.id === 'mastered'), 'the mastered discount should fire');
    assert.ok(entry.signals.find((s) => s.id === 'mastered').weight < 0, 'the discount must be negative');
  });
});

describe('plan generation', () => {
  test('the plan only contains lessons that exist in the library', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    assert.ok(plan.items.length > 0, 'a plan should have items');
    for (const item of plan.items) {
      assert.ok(library.get(item.lessonId), `plan contained unknown lesson ${item.lessonId}`);
    }
    assert.doesNotThrow(() => assertPlanUsesLibraryOnly(plan, library));
  });

  test('assertPlanUsesLibraryOnly rejects an invented lesson', () => {
    const library = buildFixtureLibrary();
    const fakePlan = { items: [{ lessonId: 'MADE-UP-LESSON' }] };
    assert.throws(() => assertPlanUsesLibraryOnly(fakePlan, library), /unknown lesson/);
  });

  test('the plan never introduces exercise text of its own', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    // Plan items carry lesson ids only — no `text` field anywhere.
    for (const item of plan.items) {
      assert.equal(item.text, undefined, 'plan items must not carry generated exercise text');
      assert.equal(item.exercises, undefined, 'plan items must not carry exercise lists');
    }
  });

  test('the plan is deterministic for the same state and date', () => {
    const { snapshot, library } = weakRingSetup();
    const now = new Date('2026-11-15T10:00:00');
    const a = planDay({ ...snapshot, __library: library }, library, { now });
    const b = planDay({ ...snapshot, __library: library }, library, { now, force: true });
    assert.deepEqual(
      a.items.map((i) => i.lessonId),
      b.items.map((i) => i.lessonId),
      'the same inputs must produce the same plan',
    );
  });

  test('the plan targets the identified weak finger', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const targetsRing = plan.items.some((item) => {
      const lesson = library.get(item.lessonId);
      return lesson.fingers.includes('LRING');
    });
    assert.ok(targetsRing, 'the plan must include work for the weak finger');
  });

  test('the plan balances weakness, progression and maintenance', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    assert.ok(plan.buckets.weakness.length > 0, 'weakness work should be present');
    assert.ok(
      plan.buckets.progression.length + plan.buckets.maintenance.length > 0,
      'the plan must not be weakness-only (requirement 7)',
    );
    assert.ok(
      plan.buckets.weakness.length <= BTS_CONFIG.weaknessSlots,
      'weakness slots must be bounded',
    );
  });

  test('weakness work never exceeds its configured share of the plan', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const share = plan.buckets.weakness.length / plan.items.length;
    assert.ok(share <= 0.6, `weakness share ${share.toFixed(2)} should stay balanced`);
  });

  test('a fresh profile still gets a usable plan', () => {
    const { snapshot, library } = snapshotFor([]);
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    assert.ok(plan.items.length > 0, 'a brand-new user must get a plan');
    for (const item of plan.items) {
      assert.ok(library.get(item.lessonId));
    }
    assert.ok(plan.explanation.length > 0, 'the plan must explain itself');
  });

  test('the first-day plan starts with the easiest lessons', () => {
    const { snapshot, library } = snapshotFor([]);
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const levels = plan.items.map((i) => library.get(i.lessonId).level);
    assert.ok(Math.min(...levels) <= 2, 'a beginner plan should start near level 1');
  });

  test('the explanation names the weakness the plan actually addresses', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const targetsRing = plan.items.some((item) => library.get(item.lessonId).fingers.includes('LRING'));
    if (targetsRing) {
      assert.match(plan.explanation, /ring/i, 'the explanation should mention the finger being trained');
    }
  });

  test('plan items are ordered weakness first', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const ranks = { weakness: 0, progression: 1, maintenance: 2 };
    for (let i = 1; i < plan.items.length; i += 1) {
      assert.ok(
        ranks[plan.items[i - 1].kind] <= ranks[plan.items[i].kind],
        'items must be grouped weakness → progression → maintenance',
      );
    }
  });

  test('every plan item explains itself', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    for (const item of plan.items) {
      assert.ok(item.reasons.length > 0, `${item.lessonId} has no reasons`);
      assert.ok(item.reasons.every((r) => typeof r === 'string' && r.length > 10));
    }
  });

  test('an existing plan is reused rather than reshuffled', () => {
    const { snapshot, library } = weakRingSetup();
    const now = new Date('2026-11-15T10:00:00');
    const first = planDay({ ...snapshot, __library: library }, library, { now });
    // Simulate the plan having been persisted, then ask again.
    const withPlan = { ...snapshot, plans: { [first.date]: first } };
    const second = planDay({ ...withPlan, __library: library }, library, { now });
    assert.equal(second.reused, true);
    assert.deepEqual(
      second.items.map((i) => i.lessonId),
      first.items.map((i) => i.lessonId),
    );
  });

  test('force regenerates instead of reusing', () => {
    const { snapshot, library } = weakRingSetup();
    const now = new Date('2026-11-15T10:00:00');
    const first = planDay({ ...snapshot, __library: library }, library, { now });
    const withPlan = { ...snapshot, plans: { [first.date]: first } };
    const forced = planDay({ ...withPlan, __library: library }, library, { now, force: true });
    assert.equal(forced.reused, false);
  });

  test('the plan changes when performance changes', () => {
    // Build a plan with a weak ring, then a snapshot where the ring is fine.
    const weak = weakRingSetup();
    const now = new Date('2026-11-15T10:00:00');
    const weakPlan = planDay({ ...weak.snapshot, __library: weak.library }, weak.library, { now });

    const healthy = snapshotFor(
      Array.from({ length: 6 }, (_, i) =>
        attempt({
          lessonId: 'T-RING-HOME',
          accuracy: 99,
          wpm: 40,
          errors: 0,
          finishedAt: new Date(new Date('2026-11-10T09:00:00.000Z').getTime() + i * 3600000).toISOString(),
          fingerStats: { LRING: { correct: 150, wrong: 0, total: 150 } },
        }),
      ),
    );
    const healthyPlan = planDay({ ...healthy.snapshot, __library: healthy.library }, healthy.library, { now });

    assert.notDeepEqual(
      weakPlan.items.map((i) => i.lessonId),
      healthyPlan.items.map((i) => i.lessonId),
      'the plan must adapt when performance changes (requirement 6)',
    );
    assert.equal(
      healthyPlan.buckets.weakness.length,
      0,
      'a healthy finger should not generate weakness work',
    );
  });

  test('a plan adapts within the fixture library without inventing ids', () => {
    const { snapshot, library } = weakRingSetup();
    const plan = planDay({ ...snapshot, __library: library }, library, { now: new Date('2026-11-15T10:00:00') });
    const validIds = new Set(library.all().map((l) => l.id));
    for (const item of plan.items) {
      assert.ok(validIds.has(item.lessonId), `${item.lessonId} is not a library id`);
    }
  });
});

describe('daily tasks', () => {
  test('tasks are generated from the plan and are checkable', () => {
    const { snapshot, library } = weakRingSetup();
    const augmented = { ...snapshot, __library: library };
    const plan = planDay(augmented, library, { now: new Date('2026-11-15T10:00:00') });
    const tasks = buildDailyTasks({ plan, snapshot: augmented, library, now: new Date('2026-11-15T10:00:00') });

    assert.ok(tasks.tasks.length > 0);
    for (const task of tasks.tasks) {
      assert.ok(task.id, 'task needs an id');
      assert.ok(task.title, 'task needs a title');
      assert.equal(typeof task.done, 'boolean', 'task needs a boolean done state');
      assert.ok(task.target > 0, 'task needs a positive target');
    }
  });

  test('completing plan lessons marks the plan task done', () => {
    const now = new Date('2026-11-15T10:00:00');
    const { snapshot, library } = weakRingSetup();
    const augmented = { ...snapshot, __library: library };
    const plan = planDay(augmented, library, { now });

    const incomplete = buildDailyTasks({ plan, snapshot: augmented, library, now });
    assert.equal(incomplete.tasks.find((t) => t.type === 'complete-plan').done, false);

    // Simulate practising every planned lesson today.
    const practised = plan.items.map((item) =>
      attempt({ lessonId: item.lessonId, finishedAt: now.toISOString(), accuracy: 97 }),
    );
    const completedSnapshot = buildSnapshot({
      state: stateWith(practised),
      library,
      now,
    });
    const complete = buildDailyTasks({
      plan,
      snapshot: { ...completedSnapshot, __library: library },
      library,
      now,
    });
    assert.equal(complete.tasks.find((t) => t.type === 'complete-plan').done, true);
  });

  test('the accuracy task is achievable relative to current performance', () => {
    const now = new Date('2026-11-15T10:00:00');
    const { snapshot, library } = weakRingSetup();
    const augmented = { ...snapshot, __library: library };
    const plan = planDay(augmented, library, { now });
    const tasks = buildDailyTasks({ plan, snapshot: augmented, library, now });
    const accuracyTask = tasks.tasks.find((t) => t.type === 'accuracy-goal');
    assert.ok(accuracyTask.target >= 90 && accuracyTask.target <= 98, 'the goal should be a fair stretch');
  });
});

describe('combined assessment', () => {
  test('assess returns weaknesses, plan, tasks and recommendations together', () => {
    const { snapshot, library } = weakRingSetup();
    const result = assess({ snapshot, library, now: new Date('2026-11-15T10:00:00') });
    assert.ok(result.weaknesses);
    assert.ok(result.plan);
    assert.ok(result.tasks);
    assert.ok(Array.isArray(result.recommendations));
    for (const rec of result.recommendations) {
      assert.ok(rec.lessonId && rec.name && rec.reasons.length > 0);
    }
  });

  test('recommendations are a prefix of the global score ordering', () => {
    const { snapshot, library } = weakRingSetup();
    const result = assess({ snapshot, library, now: new Date('2026-11-15T10:00:00') });
    const scores = result.recommendations.map((r) => r.score);
    const sorted = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, sorted);
  });
});

describe('evaluateFinger', () => {
  test('returns unknown for a finger with no data', () => {
    const result = evaluateFinger({ id: 'LPINKY', label: 'Left pinky', total: 0, attempts: 0 });
    assert.equal(result.status, 'unknown');
    assert.equal(result.severity, 0);
  });

  test('returns unknown when there is data but not enough evidence', () => {
    const result = evaluateFinger({ id: 'LPINKY', label: 'Left pinky', accuracy: 50, total: 10, attempts: 1, wrong: 5 });
    assert.equal(result.status, 'unknown');
  });

  test('a strong finger is classified as strong', () => {
    const result = evaluateFinger({ id: 'LINDEX', label: 'Left index', accuracy: 99, total: 300, attempts: 10, wrong: 3, trend: 'stable' });
    assert.equal(result.status, 'strong');
    assert.equal(result.severity, 0);
  });

  test('severity increases as accuracy falls', () => {
    const base = { total: 300, attempts: 10, trend: 'stable' };
    const a = evaluateFinger({ ...base, id: 'X', label: 'X', accuracy: 90, wrong: 30 });
    const b = evaluateFinger({ ...base, id: 'X', label: 'X', accuracy: 60, wrong: 120 });
    assert.ok(b.severity > a.severity, 'worse accuracy must mean higher severity');
  });
});
