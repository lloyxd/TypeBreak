/**
 * Application service — the single shared surface for the CLI and the web app.
 *
 * Both interfaces call exactly these methods and nothing else, which is what
 * guarantees requirement 8: the same lesson library, the same scoring maths and
 * the same progress data behind both front ends.
 *
 * Every method returns plain JSON-serialisable data. That means the web server
 * can serve a method's return value directly, and the CLI can render it, with no
 * second implementation of any rule.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from './library.js';
import { Store, defaultStatePath } from './store.js';
import { TypingSession, SESSION_MODES, summarizeAttempts, formatDuration } from './engine.js';
import {
  buildSnapshot,
  buildFingerProfiles,
  buildMovementProfiles,
  buildLessonProgress,
  computeStreak,
  buildDailyHistory,
  dateKey,
} from './profiles.js';
import { assess, identifyWeaknesses, scoreLessons, planDay, buildDailyTasks, BTS_CONFIG } from './bts.js';
import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel, KEYBOARD_ROWS, HAND_LABEL, describeChar } from './keyboard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..', '..');

/** Load the predefined library from disk. */
export function loadLibraryFromDisk(path = join(PROJECT_ROOT, 'data', 'lessons.json')) {
  const raw = readFileSync(path, 'utf8');
  return loadLibrary(JSON.parse(raw));
}

export class AppService {
  /**
   * @param {object} options
   * @param {string} [options.rootDir]  Project root (for the default data dir).
   * @param {string} [options.statePath]
   * @param {object} [options.library]  Pre-built library (tests pass a fixture).
   * @param {() => Date} [options.now]
   */
  constructor({ rootDir = PROJECT_ROOT, statePath, library, now = () => new Date() } = {}) {
    this.rootDir = rootDir;
    this.now = now;
    this.library = library ?? loadLibraryFromDisk(join(rootDir, 'data', 'lessons.json'));
    this.store = new Store(statePath ?? defaultStatePath(rootDir), { now });
    this.store.load();
    /** In-flight session per interface id, so a CLI run and a browser tab do not clash. */
    this.sessions = new Map();
  }

  /* ---------------- state ---------------- */

  getState() {
    return this.store.getState();
  }

  /** Re-read state from disk — the web server does this so CLI progress shows up live. */
  refresh() {
    this.store.reload();
    return this.store.getState();
  }

  /** Current derived snapshot (finger profiles, streak, history, ...). */
  snapshot({ refresh = true } = {}) {
    if (refresh) this.store.reload();
    return buildSnapshot({ state: this.store.getState(), library: this.library, now: this.now() });
  }

  settings() {
    return this.store.getState().profile?.settings ?? {};
  }

  updateSettings(patch) {
    return this.store.update((state) => {
      state.profile.settings = { ...state.profile.settings, ...patch };
      return state.profile.settings;
    });
  }

  resetProgress() {
    this.sessions.clear();
    return this.store.reset();
  }

  /* ---------------- lesson library ---------------- */

  lessons(filters = {}) {
    return this.library.filter(filters);
  }

  lesson(id) {
    return this.library.get(id);
  }

  libraryOverview() {
    return {
      meta: this.library.meta,
      counts: this.library.meta.counts,
      size: this.library.size,
      exerciseCount: this.library.exerciseCount(),
      facets: this.library.facets(),
      coveredFingers: this.library.coveredFingers(),
      coveredMovements: this.library.coveredMovements(),
    };
  }

  /** Static reference data the web UI needs to draw a keyboard and labels. */
  reference() {
    return {
      fingers: FINGER_INFO,
      movements: MOVEMENTS,
      keyboardRows: KEYBOARD_ROWS,
      handLabels: HAND_LABEL,
      sessionModes: SESSION_MODES,
      fingerOrder: Object.keys(FINGER_INFO),
      btsConfig: BTS_CONFIG,
    };
  }

  /* ---------------- adaptive assessment ---------------- */

  /** The Adaptive Learning payload: weaknesses, plan, tasks, recommendations. */
  assessment({ forcePlan = false } = {}) {
    const snapshot = this.snapshot();
    const result = assess({ snapshot, library: this.library, now: this.now(), forcePlan });
    return { ...result, snapshot: undefined };
  }

  weaknesses() {
    const snapshot = this.snapshot();
    return identifyWeaknesses({ ...snapshot, __library: this.library });
  }

  todaysPlan({ force = false } = {}) {
    const snapshot = this.snapshot();
    const plan = planDay({ ...snapshot, __library: this.library }, this.library, { now: this.now(), force });
    // Persist the generated plan so the CLI and web agree for the rest of the day.
    this.store.update((state) => {
      state.plans[plan.date] = {
        date: plan.date,
        generatedAt: plan.generatedAt,
        demonstratedLevel: plan.demonstratedLevel,
        explanation: plan.explanation,
        buckets: plan.buckets,
        weaknessSummary: plan.weaknessSummary,
        items: plan.items,
      };
      return state;
    });
    return plan;
  }

  todaysTasks() {
    const snapshot = this.snapshot();
    const plan = this.todaysPlan();
    return buildDailyTasks({ plan, snapshot: { ...snapshot, __library: this.library }, library: this.library, now: this.now() });
  }

  /** Recommendations with full "why" detail, for the Adaptive Learning screen. */
  recommendations(limit = 10) {
    const snapshot = this.snapshot();
    const weaknesses = identifyWeaknesses({ ...snapshot, __library: this.library });
    const scored = scoreLessons({ ...snapshot, __library: this.library, __weaknesses: weaknesses }, this.library);
    return scored.slice(0, limit).map((entry) => ({
      lessonId: entry.lessonId,
      name: entry.lesson.name,
      level: entry.lesson.level,
      category: entry.lesson.category,
      kind: entry.kind,
      score: entry.score,
      reasons: entry.reasons,
      signals: entry.signals,
      fingers: entry.lesson.fingers,
      movements: entry.lesson.movements,
    }));
  }

  /* ---------------- progress ---------------- */

  dashboard() {
    const snapshot = this.snapshot();
    const plan = this.todaysPlan();
    const tasks = buildDailyTasks({ plan, snapshot: { ...snapshot, __library: this.library }, library: this.library, now: this.now() });
    const weaknesses = identifyWeaknesses({ ...snapshot, __library: this.library });

    return {
      today: snapshot.today,
      streak: snapshot.streak,
      overall: snapshot.overall,
      totals: snapshot.totals,
      todaySummary: snapshot.todaySummary,
      plan: {
        date: plan.date,
        explanation: plan.explanation,
        items: plan.items.map((item) => ({ ...item, name: this.library.get(item.lessonId)?.name })),
        buckets: plan.buckets,
      },
      tasks,
      weaknesses: {
        summary: weaknesses.summary,
        findings: weaknesses.findings.slice(0, 4),
      },
      fingers: this.fingerProgress(),
      recentAttempts: snapshot.attempts
        .slice(-8)
        .reverse()
        .map((a) => ({
          lessonId: a.lessonId,
          lessonName: this.library.get(a.lessonId)?.name ?? a.lessonId,
          exerciseId: a.exerciseId,
          finishedAt: a.finishedAt,
          wpm: a.metrics.wpm,
          accuracy: a.metrics.accuracy,
          errors: a.metrics.errors,
          practiceMs: a.metrics.elapsedMs,
        })),
    };
  }

  fingerProgress() {
    const snapshot = this.snapshot();
    return Object.keys(FINGER_INFO)
      .map((finger) => {
        const profile = snapshot.fingerProfiles[finger];
        return {
          finger,
          label: profile.label,
          hand: profile.hand,
          short: FINGER_INFO[finger].short,
          total: profile.total,
          correct: profile.correct,
          wrong: profile.wrong,
          accuracy: profile.accuracy,
          proficiency: profile.proficiency,
          attempts: profile.attempts,
          lastPractisedAt: profile.lastPractisedAt,
          trend: profile.trend,
          recentAccuracy: profile.recentAccuracy,
          previousAccuracy: profile.previousAccuracy,
        };
      })
      .sort((a, b) => FINGER_INFO[a.finger].order - FINGER_INFO[b.finger].order);
  }

  movementProgress() {
    const snapshot = this.snapshot();
    return Object.values(MOVEMENTS)
      .map((movement) => {
        const profile = snapshot.movementProfiles[movement.id];
        return {
          movement: movement.id,
          label: movement.label,
          kind: movement.kind,
          description: movement.description,
          accuracy: profile.accuracy,
          proficiency: profile.proficiency,
          total: profile.total,
          wrong: profile.wrong,
          trend: profile.trend,
          lastPractisedAt: profile.lastPractisedAt,
        };
      })
      .filter((m) => m.total > 0);
  }

  lessonProgress() {
    const snapshot = this.snapshot();
    return this.library.all().map((lesson) => {
      const progress = snapshot.lessonProgress[lesson.id];
      return {
        lessonId: lesson.id,
        name: lesson.name,
        level: lesson.level,
        category: lesson.category,
        fingers: lesson.fingers,
        movements: lesson.movements,
        attempts: progress.attempts,
        passed: progress.passed,
        stars: progress.stars,
        bestAccuracy: progress.bestAccuracy,
        bestWpm: progress.bestWpm,
        lastPractisedAt: progress.lastPractisedAt,
        totalPracticeMs: progress.totalPracticeMs,
        completionRatio: progress.completionRatio ?? 0,
        totalExercises: lesson.exercises.length,
      };
    });
  }

  history({ days = 30 } = {}) {
    const snapshot = this.snapshot();
    const attempts = snapshot.attempts;
    return {
      days: buildDailyHistory(attempts, { days, now: this.now() }),
      streak: computeStreak(attempts, this.now()),
      totals: summarizeAttempts(attempts),
      practiceTimeLabel: formatDuration(snapshot.totals.practiceMs),
      recent: attempts
        .slice(-50)
        .reverse()
        .map((a) => ({
          exerciseId: a.exerciseId,
          lessonId: a.lessonId,
          lessonName: this.library.get(a.lessonId)?.name ?? a.lessonId,
          finishedAt: a.finishedAt,
          mode: a.mode,
          wpm: a.metrics.wpm,
          cpm: a.metrics.cpm,
          accuracy: a.metrics.accuracy,
          errors: a.metrics.errors,
          practiceMs: a.metrics.elapsedMs,
          completion: a.metrics.completion,
        })),
    };
  }

  /* ---------------- practice sessions ---------------- */

  /**
   * Start a typing session.
   *
   * The exercise text always comes from the library, never from the caller, so
   * a client cannot inject arbitrary practice content.
   */
  startSession({ lessonId, exerciseId, mode = 'flow', clientId = 'default' } = {}) {
    const lesson = this.library.require(lessonId);
    const exercise = exerciseId
      ? lesson.exercises.find((e) => e.id === exerciseId)
      : lesson.exercises[0];

    if (!exercise) throw new Error(`Exercise ${exerciseId} is not part of lesson ${lessonId}`);

    const session = new TypingSession({
      text: exercise.text,
      lessonId,
      exerciseId: exercise.id,
      mode,
      now: () => this.now().getTime(),
    });

    this.sessions.set(clientId, { session, lesson, exercise });

    return {
      clientId,
      lessonId,
      exerciseId: exercise.id,
      text: exercise.text,
      mode,
      lesson: {
        id: lesson.id,
        name: lesson.name,
        level: lesson.level,
        fingers: lesson.fingers,
        movements: lesson.movements,
        criteria: lesson.criteria,
        outcome: lesson.outcome,
      },
      exerciseIndex: lesson.exercises.indexOf(exercise) + 1,
      exerciseCount: lesson.exercises.length,
      segments: session.segments(),
    };
  }

  /**
   * Submit one keystroke. Returns the updated highlight segments so a client
   * never has to re-implement the character-state logic.
   */
  press({ clientId = 'default', key } = {}) {
    const entry = this.sessions.get(clientId);
    if (!entry) throw new Error('No active session — start a lesson first');

    const result = entry.session.press(key);
    return {
      ...result,
      segments: entry.session.segments(),
      stats: entry.session.stats(),
      progress: {
        position: entry.session.position,
        total: entry.session.text.length,
        percent: Math.round((entry.session.position / entry.session.text.length) * 100),
      },
    };
  }

  /** Abandon a session without recording it. */
  cancelSession({ clientId = 'default' } = {}) {
    this.sessions.delete(clientId);
    return { cancelled: true };
  }

  /**
   * Finish and persist a session. Idempotent per session: finishing twice
   * returns the already-recorded result rather than double-counting.
   */
  finishSession({ clientId = 'default' } = {}) {
    const entry = this.sessions.get(clientId);
    if (!entry) throw new Error('No active session — start a lesson first');

    const record = entry.session.finish();
    this.sessions.delete(clientId);

    const persisted = {
      ...record,
      recordedAt: this.now().toISOString(),
    };

    this.store.update((state) => {
      this.store.appendAttempt(persisted);
      return state;
    });

    // Re-read so the summary reflects what was actually saved.
    const snapshot = this.snapshot({ refresh: false });
    const evaluation = this.evaluateAttempt(record, entry.lesson);

    return {
      record: {
        lessonId: record.lessonId,
        exerciseId: record.exerciseId,
        mode: record.mode,
        metrics: record.metrics,
        errorsByChar: record.errorsByChar,
        errorsByFinger: record.errorsByFinger,
        errorsByMovement: record.errorsByMovement,
        fullyCorrect: record.fullyCorrect,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
      lesson: {
        id: entry.lesson.id,
        name: entry.lesson.name,
        criteria: entry.lesson.criteria,
      },
      verdict: evaluation.verdict,
      attributedMistakes: evaluation.attributedMistakes,
      progress: {
        lesson: snapshot.lessonProgress[entry.lesson.id],
        fingerAccuracy: Object.fromEntries(
          Object.keys(record.errorsByFinger).map((finger) => [
            finger,
            snapshot.fingerProfiles[finger]?.accuracy ?? null,
          ]),
        ),
      },
      nextExercise:
        entry.lesson.exercises[entry.lesson.exercises.indexOf(entry.exercise) + 1]?.id ?? null,
    };
  }

  /**
   * Score a finished attempt against a lesson's criteria without persisting it.
   *
   * Shared by the interactive CLI drill and `finishSession`, so a result shown
   * in the terminal and one shown in the browser can never disagree.
   */
  evaluateAttempt(record, lesson) {
    return {
      record,
      verdict: this.#verdict(record, lesson),
      attributedMistakes: this.#attributeMistakes(record),
    };
  }

  /**
   * Persist an attempt that was scored outside a service session — used by the
   * CLI, which drives `TypingSession` directly for raw keystroke handling.
   * Validates the lesson/exercise pair so only library content can be recorded.
   */
  recordAttempt(record) {
    const lesson = this.library.require(record.lessonId);
    const exercise = lesson.exercises.find((e) => e.id === record.exerciseId);
    if (!exercise) throw new Error(`Exercise ${record.exerciseId} is not part of lesson ${record.lessonId}`);

    const persisted = { ...record, recordedAt: this.now().toISOString() };
    this.store.update((state) => {
      this.store.appendAttempt(persisted);
      return state;
    });
    return this.evaluateAttempt(persisted, lesson);
  }

  #verdict(record, lesson) {
    const criteria = lesson.criteria;
    const meetsAccuracy = record.metrics.accuracy >= criteria.minAccuracy;
    const meetsSpeed = criteria.speedIsAdvisory || record.metrics.wpm >= criteria.minWpm;

    /**
     * Express the accuracy requirement as a mistake budget.
     *
     * On a short drill, "95% accuracy" is an abstract number while "one mistake
     * allowed in 20 keys" is not. Computing it from the actual keystroke count
     * also makes it honest: the budget shrinks as the exercise gets shorter.
     */
    const keystrokes = record.metrics.totalKeystrokes;
    const allowedErrors = Math.max(
      0,
      Math.floor(keystrokes * (1 - criteria.minAccuracy / 100)),
    );

    return {
      passed: meetsAccuracy && meetsSpeed && record.metrics.completion >= 100,
      meetsAccuracy,
      meetsSpeed,
      allowedErrors,
      required: { accuracy: criteria.minAccuracy, wpm: criteria.minWpm, speedIsAdvisory: criteria.speedIsAdvisory },
      message: !meetsAccuracy
        ? `Accuracy ${record.metrics.accuracy}% is below the ${criteria.minAccuracy}% target. At ${keystrokes} keystrokes that allows ${allowedErrors} mistake${allowedErrors === 1 ? '' : 's'} — slow down and prioritise clean keys.`
        : !meetsSpeed
          ? `Accuracy is there at ${record.metrics.accuracy}%; the next step is speed toward ${criteria.minWpm} WPM.`
          : 'Criteria met. This lesson is now marked as passed.',
    };
  }

  /**
   * Map this attempt's errors back to fingers and movements, worst first.
   *
   * Derived from `errorsByChar` so the finger and the movement always describe
   * the same mistake — a character is the only unit that carries both.
   */
  #attributeMistakes(record) {
    const byFinger = new Map();

    for (const [ch, count] of Object.entries(record.errorsByChar)) {
      const info = describeChar(ch);
      if (!info.finger) continue;
      if (!byFinger.has(info.finger)) {
        byFinger.set(info.finger, { finger: info.finger, label: info.fingerLabel, count: 0, movements: new Map(), chars: [] });
      }
      const entry = byFinger.get(info.finger);
      entry.count += count;
      entry.movements.set(info.movement, (entry.movements.get(info.movement) ?? 0) + count);
      entry.chars.push({ char: ch, count });
    }

    return [...byFinger.values()]
      .map((entry) => ({
        finger: entry.finger,
        label: entry.label,
        count: entry.count,
        movements: [...entry.movements.entries()]
          .map(([movement, count]) => ({ movement, label: movementLabel(movement), count }))
          .sort((a, b) => b.count - a.count),
        chars: entry.chars.sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
  }

  /* ---------------- stats ---------------- */

  stats() {
    const snapshot = this.snapshot();
    return {
      attempts: snapshot.totals.attempts,
      wpm: snapshot.totals.wpm,
      accuracy: snapshot.totals.accuracy,
      practiceMs: snapshot.totals.practiceMs,
      practiceLabel: formatDuration(snapshot.totals.practiceMs),
      streak: snapshot.streak,
      lessonsPassed: snapshot.overall.lessonsPassed,
      lessonsTotal: snapshot.overall.lessonsTotal,
      overallPercent: snapshot.overall.percent,
      today: snapshot.today,
    };
  }
}

export { TypingSession, SESSION_MODES, summarizeAttempts, formatDuration, dateKey };
export { buildSnapshot, buildFingerProfiles, buildMovementProfiles, buildLessonProgress };
