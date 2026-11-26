/**
 * Application service — the single surface the web application calls.
 *
 * Every method returns plain JSON-serialisable data, and all learning logic
 * (scoring, finger attribution, weakness detection, planning) lives in the
 * sibling core modules. This file only wires them to storage and to sessions.
 *
 * Runs entirely in the browser: the lesson library is fetched from a static
 * JSON file and all progress is persisted to IndexedDB.
 */

import { loadLibrary } from './library.js';
import { IndexedDbStore } from './db.js';
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
import {
  buildExport,
  parseImport,
  mergeStates,
  replaceState,
  summarise,
  attemptKey,
  IMPORT_MODES,
} from './backup.js';
import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel, KEYBOARD_ROWS, HAND_LABEL, describeChar } from './keyboard.js';

/** Fetch the predefined library (a static asset, safe to cache offline). */
export async function loadLibraryFromUrl(url = './data/lessons.json') {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load the lesson library (${response.status})`);
  return loadLibrary(await response.json());
}

export class AppService {
  /**
   * @param {object} options
   * @param {object} [options.library]  Pre-built library (tests pass a fixture).
   * @param {() => Date} [options.now]
   * @param {IndexedDbStore} [options.store] Injectable store (tests pass a fake).
   * @param {() => Promise<object>} [options.libraryLoader]
   */
  constructor({ library, now = () => new Date(), store = null, libraryLoader = loadLibraryFromUrl } = {}) {
    this.now = now;
    this.store = store ?? new IndexedDbStore({ now });
    this.library = library ?? null;
    this.libraryLoader = libraryLoader;
    /** In-flight session per interface id, so two tabs do not clash. */
    this.sessions = new Map();
  }

  /**
   * Load the library and open the database. Must be awaited before any other
   * method is used.
   */
  async init() {
    if (!this.library) this.library = await this.libraryLoader();
    await this.store.init();
    return this;
  }


  /* ---------------- state ---------------- */

  getState() {
    return this.store.getState();
  }

  /** Current derived snapshot (finger profiles, streak, history, ...). */
  snapshot() {
    return buildSnapshot({ state: this.store.getState(), library: this.library, now: this.now() });
  }

  settings() {
    return this.store.getState().profile?.settings ?? {};
  }

  /** Settings live in the store, so every change persists immediately. */
  updateSettings(patch) {
    return this.store.update((state) => {
      state.profile.settings = { ...state.profile.settings, ...patch };
      return state.profile.settings;
    });
  }

  resetProgress() {
    this.sessions.clear();
    return this.store.clear();
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
    // Persist the generated plan so it stays fixed for the rest of the day.
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
   * Start a timed free-practice run.
   *
   * Text is supplied by the Practice tab word bank, not the lesson library, and
   * the attempt is never written to progress. Import and lesson history stay
   * the only records that Progress can show.
   */
  startFreeSession({ text, mode = 'flow', clientId = 'default' } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Free practice needs target text');
    }

    const session = new TypingSession({
      text,
      lessonId: null,
      exerciseId: null,
      mode,
      now: () => this.now().getTime(),
    });

    this.sessions.set(clientId, { session, lesson: null, exercise: null, ephemeral: true });

    return {
      clientId,
      ephemeral: true,
      text,
      mode,
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

    if (entry.ephemeral) {
      return {
        ephemeral: true,
        record: {
          lessonId: null,
          exerciseId: null,
          mode: record.mode,
          metrics: record.metrics,
          errorsByChar: record.errorsByChar,
          errorsByFinger: record.errorsByFinger,
          errorsByMovement: record.errorsByMovement,
          fullyCorrect: record.fullyCorrect,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
        lesson: null,
        verdict: null,
        attributedMistakes: [],
        progress: null,
        nextExercise: null,
      };
    }

    this.store.appendAttempt({
      ...record,
      recordedAt: this.now().toISOString(),
    });

    const snapshot = this.snapshot();
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
   * Score an attempt against a lesson's criteria.
   */
  evaluateAttempt(record, lesson) {
    return {
      record,
      verdict: this.#verdict(record, lesson),
      attributedMistakes: this.#attributeMistakes(record),
    };
  }

  /**
   * Persist an attempt scored outside a service session (an imported record or
   * a replayed one). Validates the lesson/exercise pair so only library content
   * can be recorded.
   */
  recordAttempt(record) {
    const lesson = this.library.require(record.lessonId);
    const exercise = lesson.exercises.find((e) => e.id === record.exerciseId);
    if (!exercise) throw new Error(`Exercise ${record.exerciseId} is not part of lesson ${record.lessonId}`);

    const persisted = { ...record, recordedAt: this.now().toISOString() };
    this.store.appendAttempt(persisted);
    return this.evaluateAttempt(persisted, lesson);
  }

  /* ---------------- backup and restore ---------------- */

  /** Build a complete, versioned backup of the current progress. */
  createExport() {
    return buildExport(this.store.getState(), { now: this.now, library: this.library });
  }

  /**
   * Validate a candidate import without applying it.
   *
   * Lets the UI show what the file contains and what would change *before* the
   * user commits, so a merge-vs-replace choice is informed rather than blind.
   */
  inspectImport(text) {
    const result = parseImport(text, { library: this.library });
    if (!result.ok) return result;

    const current = this.store.getState();
    const existingKeys = new Set((current.attempts ?? []).map(attemptKey));
    const incoming = result.data.attempts ?? [];
    const incomingKeys = new Set(incoming.map(attemptKey));

    const duplicatesAgainstCurrent = incoming.filter((a) => existingKeys.has(attemptKey(a))).length;
    const newFromFile = incoming.length - duplicatesAgainstCurrent;

    return {
      ...result,
      preview: {
        incoming: summarise(result.data),
        current: summarise(current),
        newAttempts: newFromFile,
        duplicateAttempts: duplicatesAgainstCurrent,
        importedAlreadyKnown: duplicatesAgainstCurrent,
        // Whether replacing would lose data the file does not contain.
        wouldLoseAttempts: (current.attempts ?? []).filter((a) => !incomingKeys.has(attemptKey(a))).length,
        incomingSettings: result.data.profile?.settings ?? null,
      },
    };
  }

  /**
   * Apply a validated import.
   *
   * @param {object} params
   * @param {string} params.text   Raw file contents.
   * @param {'merge'|'replace'} [params.mode]
   */
  async applyImport({ text, mode = 'merge' } = {}) {
    if (!IMPORT_MODES[mode]) throw new Error(`Unknown import mode: ${mode}`);

    const inspected = this.inspectImport(text);
    if (!inspected.ok) {
      const error = new Error('The file could not be imported.');
      error.details = inspected.errors;
      throw error;
    }

    const result =
      mode === 'replace'
        ? replaceState(inspected.data, { now: this.now })
        : mergeStates(this.store.getState(), inspected.data, { now: this.now });

    await this.store.replaceState(result.state);
    await this.store.flush();

    return {
      mode,
      added: result.added,
      duplicates: result.duplicates,
      replaced: result.replaced,
      totalAttempts: this.store.getState().attempts.length,
      warnings: inspected.warnings,
      summary: summarise(this.store.getState()),
    };
  }

  /** Resolve once every queued write has landed. */
  async flush() {
    await this.store.flush();
  }

  /** Most recent recoverable snapshot, for the "restore last backup" action. */
  async lastBackup() {
    return this.store.lastBackup();
  }

  /** Approximate local storage usage, for the settings screen. */
  async storageUsage() {
    return this.store.estimateUsage();
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
