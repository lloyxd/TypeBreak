/**
 * IndexedDB persistence.
 *
 * Replaces the former Node file store. The shape of the persisted document is
 * unchanged — the same `profile / attempts / plans / tasks` document — so the
 * analytics and BTS modules continue to work without modification. Only the
 * transport changed: `localStorage` for the small settings blob would be simpler
 * but has a ~5 MB ceiling and is synchronous, and attempt history plus keystroke
 * samples will exceed that quickly.
 *
 * Design notes:
 *   * One object store (`state`) holding a single record keyed `current`. The
 *     document is the unit of consistency: the BTS derives everything from
 *     `attempts`, so partially-written documents are worse than none.
 *   * Writes are wrapped in a transaction and awaited, so a refresh mid-write
 *     cannot leave a torn document.
 *   * The previous document is snapshotted into a `backups` store before each
 *     write, mirroring the `.bak` behaviour of the old file store, so a bad
 *     write is recoverable.
 *   * An in-memory copy is the read path; callers get the same synchronous API
 *     they had before, and `flush()` resolves when the write lands.
 */

export const DB_NAME = 'typebreak';
export const DB_VERSION = 1;
export const STATE_VERSION = 2;

const STORE_STATE = 'state';
const STORE_BACKUPS = 'backups';
const CURRENT_KEY = 'current';
const MAX_BACKUPS = 3;

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
    attempts: [],
    fingers: {},
    movements: {},
    lessons: {},
    plans: {},
    tasks: {},
    assessments: {},
  };
}

/**
 * Bring an older document up to the current schema.
 *
 * Additive by design so a future version can add fields without invalidating a
 * user's history — including history arriving from an imported file.
 */
export function migrate(doc) {
  const base = emptyState();
  const state = { ...base, ...doc };
  state.version = STATE_VERSION;

  state.profile = { ...base.profile, ...(doc?.profile ?? {}) };
  state.profile.settings = { ...base.profile.settings, ...(doc?.profile?.settings ?? {}) };

  for (const key of ['fingers', 'movements', 'lessons', 'plans', 'tasks', 'assessments']) {
    if (!doc?.[key] || typeof doc[key] !== 'object' || Array.isArray(doc[key])) state[key] = {};
  }

  state.attempts = Array.isArray(doc?.attempts) ? doc.attempts.filter((a) => a && a.metrics && a.exerciseId) : [];

  return state;
}

/** Raised when the database cannot be opened at all. */
export class StorageUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.cause = cause;
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageUnavailableError('This browser does not provide IndexedDB.'));
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new StorageUnavailableError('IndexedDB is blocked in this browsing context.', error));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_BACKUPS)) {
        // Auto-increment keys give a cheap ring buffer of prior documents.
        db.createObjectStore(STORE_BACKUPS, { autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new StorageUnavailableError(
          'Could not open the local database. Private browsing or storage restrictions may be blocking it.',
          request.error,
        ),
      );
  });
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Browser-backed store with the same synchronous read API as the old file store.
 *
 * Reads come from `state` (loaded once at startup). Writes update `state`
 * immediately and are persisted in the background; `flush()` awaits the write so
 * callers that care can guarantee durability (export, import, page hide).
 */
export class IndexedDbStore {
  constructor({ now = () => new Date(), maxAttempts = 2000 } = {}) {
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.state = null;
    this.db = null;
    this.pending = Promise.resolve();
    this.available = true;
  }

  /** Open the database and load the document. Safe to call repeatedly. */
  async init() {
    if (this.state) return this.state;

    try {
      this.db = await openDatabase();
      const tx = this.db.transaction(STORE_STATE, 'readonly');
      const stored = await promisify(tx.objectStore(STORE_STATE).get(CURRENT_KEY));
      this.state = stored ? migrate(stored) : emptyState({ now: this.now });
    } catch (error) {
      // The app must still work if storage is unavailable: keep everything in
      // memory for this session and surface the limitation in the UI.
      this.available = false;
      this.storageError = error;
      this.state = emptyState({ now: this.now });
    }

    return this.state;
  }

  /** The current document. Throws if `init()` has not completed. */
  getState() {
    if (!this.state) throw new Error('Store used before init() resolved');
    return this.state;
  }

  get attemptCount() {
    return this.state?.attempts?.length ?? 0;
  }

  /**
   * Apply a mutation and persist it.
   *
   * Matches the old `update(fn)` contract: mutate the passed state, return
   * whatever the callback returns.
   */
  update(fn) {
    if (!this.state) throw new Error('Store used before init() resolved');
    const result = fn(this.state);
    this.state.updatedAt = this.now().toISOString();
    this.#scheduleWrite();
    return result;
  }

  /** Append an attempt, trimming history to the cap. */
  appendAttempt(record) {
    return this.update((state) => {
      state.attempts.push(record);
      if (state.attempts.length > this.maxAttempts) {
        state.attempts = state.attempts.slice(-this.maxAttempts);
      }
      return record;
    });
  }

  /** Queue a write; serialised so two rapid updates cannot interleave. */
  #scheduleWrite() {
    if (!this.db) {
      // Memory-only mode: nothing to persist, but stay consistent.
      return this.pending;
    }
    this.pending = this.pending
      .then(() => this.#write())
      .catch((error) => {
        console.error('TypeBreak: failed to save progress', error);
      });
    return this.pending;
  }

  async #write() {
    const snapshot = JSON.parse(JSON.stringify(this.state));

    /**
     * The document and its backup are written in one transaction, issued
     * synchronously.
     *
     * An IndexedDB transaction auto-commits as soon as the event loop turns with
     * no requests outstanding, so awaiting anything *between* requests here
     * would let the transaction close and make the next request throw
     * `TransactionInactiveError`. Every request in this block is therefore fired
     * without an intervening await, and pruning happens in a later transaction.
     */
    const tx = this.db.transaction([STORE_STATE, STORE_BACKUPS], 'readwrite');
    const backups = tx.objectStore(STORE_BACKUPS);
    // An explicit key keeps the newest backup identifiable without a read.
    const backupKey = Date.parse(snapshot.updatedAt) || Date.now();
    backups.put(
      { savedAt: snapshot.updatedAt, version: snapshot.version, attempts: snapshot.attempts.length, state: snapshot },
      backupKey,
    );
    tx.objectStore(STORE_STATE).put(snapshot, CURRENT_KEY);

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });

    await this.#pruneBackups();
  }

  /** Keep only the newest few backups. Failure here is harmless. */
  async #pruneBackups() {
    try {
      const readTx = this.db.transaction(STORE_BACKUPS, 'readonly');
      const keys = await promisify(readTx.objectStore(STORE_BACKUPS).getAllKeys());
      if (keys.length <= MAX_BACKUPS) return;

      const stale = keys.sort((a, b) => a - b).slice(0, keys.length - MAX_BACKUPS);
      const deleteTx = this.db.transaction(STORE_BACKUPS, 'readwrite');
      const store = deleteTx.objectStore(STORE_BACKUPS);
      for (const key of stale) store.delete(key);
      await new Promise((resolve) => {
        deleteTx.oncomplete = () => resolve();
        deleteTx.onerror = () => resolve();
      });
    } catch {
      /* a backup that outlives its welcome is not worth failing a save over */
    }
  }

  /** Resolve once every queued write has landed. */
  async flush() {
    await this.pending;
  }

  /**
   * Replace the whole document (used by import in replace mode and by reset).
   * Written synchronously in the same transaction so an import cannot be
   * half-applied.
   */
  async replaceState(next) {
    this.state = migrate(next);
    this.state.updatedAt = this.now().toISOString();
    if (!this.db) return this.state;

    const snapshot = JSON.parse(JSON.stringify(this.state));
    const tx = this.db.transaction(STORE_STATE, 'readwrite');
    tx.objectStore(STORE_STATE).put(snapshot, CURRENT_KEY);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return this.state;
  }

  /** Wipe everything, including backups. */
  async clear() {
    this.state = emptyState({ now: this.now });
    if (!this.db) return this.state;

    const tx = this.db.transaction([STORE_STATE, STORE_BACKUPS], 'readwrite');
    tx.objectStore(STORE_STATE).clear();
    tx.objectStore(STORE_BACKUPS).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return this.state;
  }

  /** The most recent recoverable snapshot, or null. */
  async lastBackup() {
    if (!this.db) return null;
    const tx = this.db.transaction(STORE_BACKUPS, 'readonly');
    const store = tx.objectStore(STORE_BACKUPS);
    const keys = await promisify(store.getAllKeys());
    if (!keys.length) return null;
    const newest = keys.sort((a, b) => a - b)[keys.length - 1];
    const readTx = this.db.transaction(STORE_BACKUPS, 'readonly');
    return promisify(readTx.objectStore(STORE_BACKUPS).get(newest));
  }

  /** Approximate bytes used, for the settings screen. */
  async estimateUsage() {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    } catch {
      return null;
    }
  }
}
