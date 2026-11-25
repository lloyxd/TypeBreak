/**
 * Typing engine.
 *
 * A `TypingSession` consumes keystrokes one at a time and produces a
 * performance record. It knows nothing about lessons, storage or the UI — it
 * receives text and characters, and reports what happened. That separation is
 * what lets the CLI, the web client and the tests all use exactly the same
 * scoring maths.
 *
 * Timing is injected (`now`), so tests are deterministic and wall-clock free.
 */

import { describeChar, FINGER_INFO } from './keyboard.js';

export const SESSION_MODES = {
  /**
   * Errors must be corrected before the caret advances. Best for learning a
   * new movement, because it prevents practising the wrong finger motion.
   */
  strict: {
    id: 'strict',
    label: 'Strict',
    description: 'You must fix a mistake before moving on.',
    allowAdvanceOnError: false,
  },
  /**
   * The caret advances regardless, and each wrong key is recorded. Closer to
   * real typing and better for measuring speed.
   */
  flow: {
    id: 'flow',
    label: 'Flow',
    description: 'Keep typing through mistakes; every error is recorded.',
    allowAdvanceOnError: true,
  },
};

const WORDS_PER_MINUTE_CHARS = 5;

/** Round to `places` decimals without float noise. */
export function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Standard typing metrics.
 *
 * WPM uses the conventional "word = 5 characters" definition and counts only
 * characters typed correctly, so it cannot be inflated by mashing keys.
 * Accuracy is over keystrokes, not characters, so repeated corrections cost
 * accuracy the way they should.
 *
 * `completion` is the share of the exercise the caret got through — *not* the
 * share typed correctly. Conflating the two would make 100% completion
 * unreachable after a single mistake, which would in turn make a lesson
 * impossible to pass however clean the rest of it was. Correctness is the job of
 * `accuracy`.
 */
export function computeMetrics({ correctChars, totalKeystrokes, errors, elapsedMs, totalChars, position = null }) {
  // A sub-second attempt cannot produce a meaningful rate; without this floor a
  // tiny drill typed instantly reports an absurd WPM.
  const minutes = Math.max(elapsedMs, 1000) / 60000;
  const grossChars = totalKeystrokes;
  const reached = position === null ? correctChars : position;
  return {
    wpm: round(correctChars / WORDS_PER_MINUTE_CHARS / minutes),
    cpm: round(correctChars / minutes),
    grossWpm: round(grossChars / WORDS_PER_MINUTE_CHARS / minutes),
    accuracy: totalKeystrokes === 0 ? 100 : round((1 - errors / totalKeystrokes) * 100),
    errors,
    correctChars,
    totalKeystrokes,
    elapsedMs: Math.round(elapsedMs),
    completion: totalChars === 0 ? 0 : round((Math.min(reached, totalChars) / totalChars) * 100),
  };
}

/**
 * A single typing attempt over one exercise.
 */
export class TypingSession {
  /**
   * @param {object} params
   * @param {string} params.text          Target text, verbatim from the library.
   * @param {string} params.lessonId
   * @param {string} params.exerciseId
   * @param {string} [params.mode]        'strict' | 'flow'
   * @param {() => number} [params.now]   Injectable clock (ms).
   */
  constructor({ text, lessonId, exerciseId, mode = 'flow', now = () => Date.now() }) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('TypingSession requires non-empty target text');
    }
    if (!SESSION_MODES[mode]) throw new Error(`Unknown session mode: ${mode}`);

    this.text = text;
    this.lessonId = lessonId;
    this.exerciseId = exerciseId;
    this.mode = mode;
    this.now = now;

    /** Index of the next character to type. */
    this.position = 0;
    /** Per-position state: null = untouched, true = correct, false = wrong. */
    this.results = new Array(text.length).fill(null);
    /** What the user actually pressed at each position (for review). */
    this.typed = new Array(text.length).fill(null);

    this.correctChars = 0;
    this.totalKeystrokes = 0;
    this.errors = 0;
    /** Errors keyed by the target character. */
    this.errorsByChar = Object.create(null);
    /** Errors keyed by the finger responsible for the target character. */
    this.errorsByFinger = Object.create(null);
    /** Errors keyed by the movement the target character required. */
    this.errorsByMovement = Object.create(null);
    /** Every keystroke for a timing graph, capped to keep memory bounded. */
    this.keystrokes = [];

    this.startedAt = null;
    this.finishedAt = null;
    this.completed = false;
  }

  get started() {
    return this.startedAt !== null;
  }

  get elapsedMs() {
    if (this.startedAt === null) return 0;
    return (this.finishedAt ?? this.now()) - this.startedAt;
  }

  /** The character the user should type next, or null when finished. */
  get nextChar() {
    if (this.completed) return null;
    return this.text[this.position] ?? null;
  }

  /** Live metrics for a HUD. Recomputed on demand; cheap enough for a HUD. */
  stats() {
    return computeMetrics({
      correctChars: this.correctChars,
      totalKeystrokes: this.totalKeystrokes,
      errors: this.errors,
      elapsedMs: this.elapsedMs,
      totalChars: this.text.length,
      position: this.position,
    });
  }

  /**
   * Apply one keystroke.
   *
   * Returns a result object describing what happened so the caller can render
   * feedback without duplicating engine logic:
   *   { accepted, correct, expected, typed, position, finished }
   */
  press(input) {
    if (this.completed) {
      return { accepted: false, correct: false, expected: null, typed: input, position: this.position, finished: true };
    }

    if (this.startedAt === null) this.startedAt = this.now();

    // Normalise line endings from terminals; a stray \r is never a real key.
    const ch = input === '\r' ? '\n' : input;

    const expected = this.text[this.position];
    const correct = ch === expected;

    this.totalKeystrokes += 1;
    this.keystrokes.push({ t: this.elapsedMs, correct, expected, typed: ch });

    if (correct) {
      this.results[this.position] = true;
      this.typed[this.position] = ch;
      this.correctChars += 1;
      this.position += 1;
    } else {
      this.errors += 1;
      this.recordError(expected);
      const modeConf = SESSION_MODES[this.mode];
      if (modeConf.allowAdvanceOnError) {
        this.results[this.position] = false;
        this.typed[this.position] = ch;
        this.position += 1;
      }
      // In strict mode the position stays put so the user retries the same key.
    }

    if (this.position >= this.text.length) {
      this.finishedAt = this.now();
      this.completed = true;
    }

    return {
      accepted: correct || SESSION_MODES[this.mode].allowAdvanceOnError,
      correct,
      expected,
      typed: ch,
      position: this.position,
      finished: this.completed,
    };
  }

  /** Attribute an error to the character, finger and movement that were expected. */
  recordError(expected) {
    const info = describeChar(expected);
    this.errorsByChar[expected] = (this.errorsByChar[expected] ?? 0) + 1;
    if (info.finger) this.errorsByFinger[info.finger] = (this.errorsByFinger[info.finger] ?? 0) + 1;
    if (info.movement) this.errorsByMovement[info.movement] = (this.errorsByMovement[info.movement] ?? 0) + 1;
  }

  /**
   * Undo the last successful character. Only meaningful in strict mode, where
   * the caret cannot advance past an error anyway. Kept deliberately narrow: we
   * do not rewind `totalKeystrokes`, because the mistaken keystrokes did happen.
   */
  backspace() {
    if (this.completed || this.position === 0) return false;
    const target = this.position - 1;
    if (this.results[target] !== true) return false;
    this.results[target] = null;
    this.typed[target] = null;
    this.position = target;
    this.correctChars -= 1;
    return true;
  }

  /**
   * Final performance record, in the shape the store persists.
   *
   * `fingerStats` and `movementStats` are per-keystroke tallies over the target
   * text, which is what makes finger-level weakness detection possible.
   */
  finish() {
    if (!this.completed) {
      this.finishedAt = this.now();
      this.completed = true;
    }
    const metrics = this.stats();
    const { fingerStats, movementStats } = this.attributeTargets();

    /**
     * Timestamps are emitted as ISO strings.
     *
     * Internally the session works in epoch milliseconds (cheap arithmetic), but
     * a persisted record is read back by date grouping, streak calculation,
     * export and import. A numeric field that some consumers treat as a string
     * is exactly the kind of ambiguity that silently corrupts an import, so the
     * record carries one canonical type.
     */
    const toIso = (value) => (typeof value === 'number' ? new Date(value).toISOString() : value ?? null);

    return {
      lessonId: this.lessonId,
      exerciseId: this.exerciseId,
      mode: this.mode,
      text: this.text,
      metrics,
      errorsByChar: { ...this.errorsByChar },
      errorsByFinger: { ...this.errorsByFinger },
      errorsByMovement: { ...this.errorsByMovement },
      fingerStats,
      movementStats,
      keystrokes: this.keystrokes,
      startedAt: toIso(this.startedAt),
      finishedAt: toIso(this.finishedAt),
      // Full completion means every character was eventually correct.
      fullyCorrect: this.results.every((r) => r === true),
    };
  }

  /**
   * For every character in the target text, count successes and failures per
   * finger and per movement. This is the raw material for BTS: it describes the
   * *work the exercise demanded*, not just how the user felt about it.
   */
  attributeTargets() {
    const fingerStats = {};
    const movementStats = {};

    const bump = (table, key, field) => {
      if (!key) return;
      const entry = (table[key] ??= { correct: 0, wrong: 0, total: 0 });
      entry[field] += 1;
      entry.total += 1;
    };

    for (let i = 0; i < this.text.length; i += 1) {
      const info = describeChar(this.text[i]);
      const outcome = this.results[i];
      if (outcome === null) continue;
      const field = outcome ? 'correct' : 'wrong';
      bump(fingerStats, info.finger, field);
      bump(movementStats, info.movement, field);
    }

    return { fingerStats, movementStats };
  }

  /**
   * Progress of the text as renderable segments. Used by both UIs so the
   * correct/incorrect/current/upcoming colouring cannot drift apart.
   */
  segments() {
    const out = [];
    let run = null;
    for (let i = 0; i < this.text.length; i += 1) {
      const state = this.results[i] === true ? 'correct' : this.results[i] === false ? 'wrong' : i === this.position ? 'current' : 'pending';
      if (run && run.state === state) {
        run.text += this.text[i];
      } else {
        run = { state, text: this.text[i] };
        out.push(run);
      }
    }
    return out;
  }
}

/**
 * Aggregate several attempt records into one summary.
 * Used for lesson-level and day-level rollups.
 */
export function summarizeAttempts(attempts) {
  if (!attempts || attempts.length === 0) {
    return { attempts: 0, wpm: 0, cpm: 0, accuracy: 0, errors: 0, practiceMs: 0, completion: 0 };
  }
  const total = attempts.reduce(
    (acc, a) => {
      acc.wpm += a.metrics.wpm;
      acc.cpm += a.metrics.cpm;
      acc.accuracy += a.metrics.accuracy;
      acc.errors += a.metrics.errors;
      acc.practiceMs += a.metrics.elapsedMs;
      acc.completion += a.metrics.completion;
      acc.keystrokes += a.metrics.totalKeystrokes;
      return acc;
    },
    { wpm: 0, cpm: 0, accuracy: 0, errors: 0, practiceMs: 0, completion: 0, keystrokes: 0 },
  );
  const n = attempts.length;
  return {
    attempts: n,
    wpm: round(total.wpm / n),
    cpm: round(total.cpm / n),
    accuracy: round(total.accuracy / n),
    errors: total.errors,
    practiceMs: total.practiceMs,
    completion: round(total.completion / n),
    keystrokes: total.keystrokes,
  };
}

/** Format milliseconds as `m:ss` for display. */
export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Percentage of finger keys that got through cleanly. */
export function fingerAccuracy(stats) {
  if (!stats || stats.total === 0) return null;
  return round((stats.correct / stats.total) * 100);
}

/** Human summary line for a finished attempt. */
export function describeAttempt(record) {
  const { metrics } = record;
  return `${metrics.wpm} WPM · ${metrics.accuracy}% accuracy · ${metrics.errors} error${metrics.errors === 1 ? '' : 's'} · ${formatDuration(metrics.elapsedMs)}`;
}

export { FINGER_INFO };
