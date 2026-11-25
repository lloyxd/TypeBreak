/**
 * Persistence.
 *
 * One JSON document holds all mutable user data so the CLI and the web app
 * always read and write the same state. Writes are atomic (temp file + rename)
 * and the previous document is kept as a `.bak`, so an interrupted write can
 * never corrupt progress.
 *
 * The store is deliberately dumb: it holds and mutates a plain object. All
 * interpretation lives in the profiles/BTS/planner modules, which makes the
 * persistence layer trivially swappable for tests.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;

/** A brand-new state document. */
export function emptyState({ now = () => new Date() } = {}) {
  const iso = now().toISOString();
  return {
    version: STATE_VERSION,
    createdAt: iso,
    updatedAt: iso,
    profile: {
      name: 'typist',
      createdAt: iso,
      settings: {
        mode: 'flow',
        dailyGoalExercises: 6,
        dailyGoalMinutes: 12,
        sessionLessons: 4,
        theme: 'dark',
      },
    },
    /** Every completed attempt, newest last. Capped by the store. */
    attempts: [],
    /** Per-finger rollups, keyed by finger id. */
    fingers: {},
    /** Per-movement rollups, keyed by movement id. */
    movements: {},
    /** Per-lesson rollups, keyed by lesson id. */
    lessons: {},
    /** Daily plans, keyed by ISO date (YYYY-MM-DD). */
    plans: {},
    /** Daily task completion, keyed by ISO date. */
    tasks: {},
    /** Cached BTS assessments, keyed by ISO date. */
    assessments: {},
  };
}

const MAX_ATTEMPTS = 2000;

export class Store {
  /**
   * @param {string} path      Path to `state.json`.
   * @param {object} [options]
   * @param {() => Date} [options.now]
   */
  constructor(path, { now = () => new Date(), maxAttempts = MAX_ATTEMPTS } = {}) {
    this.path = path;
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.state = null;
  }

  get backupPath() {
    return `${this.path}.bak`;
  }

  get tempPath() {
    return `${this.path}.tmp`;
  }

  get exists() {
    return existsSync(this.path);
  }

  /**
   * Load from disk, recovering from a corrupt file when a backup exists.
   * A missing file yields a fresh state, which is not an error.
   */
  load() {
    if (existsSync(this.path)) {
      const parsed = this.#tryRead(this.path);
      if (parsed) {
        this.state = migrate(parsed);
        return this.state;
      }
      // Primary file unreadable: prefer the backup over losing all progress.
      const backup = this.#tryRead(this.backupPath);
      if (backup) {
        this.state = migrate(backup);
        this.save();
        return this.state;
      }
      // Both unreadable: preserve the damaged file instead of silently
      // overwriting it, then start clean.
      const quarantine = `${this.path}.corrupt-${this.now().getTime()}`;
      try {
        copyFileSync(this.path, quarantine);
      } catch {
        /* best effort */
      }
    }

    this.state = emptyState({ now: this.now });
    return this.state;
  }

  #tryRead(path) {
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Reload from disk, discarding in-memory changes. */
  reload() {
    return this.load();
  }

  /**
   * Persist atomically: write temp, copy current to backup, rename temp over
   * current. On POSIX the rename is atomic; on Windows `renameSync` overwrites.
   */
  save() {
    if (!this.state) throw new Error('Cannot save before load');
    this.state.updatedAt = this.now().toISOString();

    mkdirSync(dirname(this.path), { recursive: true });
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    writeFileSync(this.tempPath, payload, 'utf8');

    if (existsSync(this.path)) {
      try {
        copyFileSync(this.path, this.backupPath);
      } catch {
        /* a missing backup is survivable */
      }
    }

    renameSync(this.tempPath, this.path);
    return this.state;
  }

  /** Load if needed, then apply `fn` to the state and save once. */
  update(fn) {
    const state = this.#ensure();
    const result = fn(state);
    this.save();
    return result;
  }

  #ensure() {
    if (!this.state) this.load();
    return this.state;
  }

  /** Read-only access to the state, loading on first use. */
  getState() {
    return this.#ensure();
  }

  /**
   * Append an attempt record and trim the history. Callers are responsible for
   * deriving rollups; see `profiles.js` for that.
   */
  appendAttempt(record) {
    const state = this.#ensure();
    state.attempts.push(record);
    if (state.attempts.length > this.maxAttempts) {
      state.attempts = state.attempts.slice(-this.maxAttempts);
    }
    return record;
  }

  /** Wipe the state document and its backup. */
  reset() {
    this.state = emptyState({ now: this.now });
    this.save();
    for (const path of [this.backupPath, this.tempPath]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* best effort */
      }
    }
    return this.state;
  }
}

/**
 * Bring an older document up to the current schema.
 *
 * Each step is additive so a future version can add fields without breaking
 * existing progress files.
 */
export function migrate(doc) {
  const state = { ...emptyState(), ...doc };
  state.version = STATE_VERSION;

  state.profile = { ...emptyState().profile, ...(doc.profile ?? {}) };
  state.profile.settings = { ...emptyState().profile.settings, ...(doc.profile?.settings ?? {}) };

  for (const key of ['attempts', 'fingers', 'movements', 'lessons', 'plans', 'tasks', 'assessments']) {
    if (!doc[key] || typeof doc[key] !== 'object') {
      state[key] = key === 'attempts' ? [] : {};
    }
  }

  if (!Array.isArray(state.attempts)) state.attempts = [];
  // Drop records that cannot be interpreted rather than failing the whole load.
  state.attempts = state.attempts.filter((a) => a && a.metrics && a.exerciseId);

  return state;
}

/** Convenience helper for the default data directory. */
export function defaultStatePath(rootDir) {
  return join(rootDir, 'data', 'state.json');
}
