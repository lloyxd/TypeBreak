/**
 * Persistence and backup tests.
 *
 * The real store uses IndexedDB, which Node does not provide. Rather than adding
 * a fake-IDB dependency, these tests cover two things:
 *
 *   1. `IndexedDbStore` against a minimal in-memory IndexedDB stand-in that
 *      implements exactly the surface the store uses, so the store's own logic
 *      (migration, backups, write serialisation, fallback) stays under test.
 *   2. `migrate()` directly, which holds the schema rules that must survive
 *      across versions and imports.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { IndexedDbStore, emptyState, migrate, STATE_VERSION, DB_NAME } from '../web/core/db.js';
import { attempt } from './fixtures.js';

/* ------------------------------------------------------------------ *
 * A deliberately small IndexedDB stand-in
 * ------------------------------------------------------------------ */

/**
 * Implements only what `db.js` touches: open, object stores with autoIncrement,
 * get/put/add/delete/getAllKeys/clear, and transactions that fire oncomplete.
 * Requests resolve on microtasks so ordering bugs in the store still surface.
 */
function installFakeIndexedDb() {
  const databases = new Map();

  function makeStore() {
    const data = new Map();
    let nextKey = 1;
    return {
      data,
      put(value, key) {
        const actualKey = key === undefined ? nextKey++ : key;
        data.set(actualKey, structuredClone(value));
        return { result: actualKey };
      },
      add(value) {
        const key = nextKey++;
        data.set(key, structuredClone(value));
        return { result: key };
      },
      get(key) {
        return { result: data.has(key) ? structuredClone(data.get(key)) : undefined };
      },
      getAllKeys() {
        return { result: [...data.keys()] };
      },
      delete(key) {
        data.delete(key);
        return { result: undefined };
      },
      clear() {
        data.clear();
        return { result: undefined };
      },
    };
  }

  const fake = {
    open(name) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };

      queueMicrotask(() => {
        const existing = databases.get(name);
        if (existing) {
          request.result = existing;
          request.onsuccess?.({ target: request });
          return;
        }

        const stores = new Map();
        const db = {
          name,
          version: 1,
          stores,
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore(storeName) {
            const store = makeStore();
            stores.set(storeName, store);
            return store;
          },
          transaction(storeNames) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            tx.objectStore = (storeName) => {
              const store = stores.get(storeName);
              if (!store) throw new Error(`No object store ${storeName}`);
              const wrap = (method) => (...args) => {
                const result = store[method](...args);
                // Attach onsuccess scheduling to the returned request. A
                // macrotask (not a microtask) so callers can attach their
                // handler after receiving the request, as the real API allows.
                const request2 = { ...result, onsuccess: null, onerror: null };
                setTimeout(() => request2.onsuccess?.({ target: request2 }), 0);
                return request2;
              };
              return {
                put: wrap('put'),
                add: wrap('add'),
                get: wrap('get'),
                getAllKeys: wrap('getAllKeys'),
                delete: wrap('delete'),
                clear: wrap('clear'),
              };
            };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        };

        databases.set(name, db);
        request.result = db;
        request.onupgradeneeded?.({ target: request });
        // Defer so the caller can attach onsuccess after `open()` returns.
        setTimeout(() => request.onsuccess?.({ target: request }), 0);
      });

      return request;
    },
  };

  globalThis.indexedDB = fake;
  return {
    reset() {
      databases.clear();
    },
    databases,
  };
}

let idb;

beforeEach(() => {
  idb = installFakeIndexedDb();
  idb.reset();
});

/* ------------------------------------------------------------------ *
 * State shape and migration
 * ------------------------------------------------------------------ */

describe('state document', () => {
  test('emptyState has every section the analytics read', () => {
    const state = emptyState();
    assert.equal(state.version, STATE_VERSION);
    for (const key of ['attempts', 'fingers', 'movements', 'lessons', 'plans', 'tasks', 'assessments']) {
      assert.ok(key in state, `state should have ${key}`);
    }
    assert.deepEqual(state.attempts, []);
    assert.ok(state.profile.settings.mode);
  });

  test('emptyState returns independent objects', () => {
    const a = emptyState();
    const b = emptyState();
    a.profile.settings.mode = 'strict';
    assert.notEqual(b.profile.settings.mode, 'strict');
  });

  test('migrate fills in missing sections', () => {
    const migrated = migrate({ version: 0 });
    assert.equal(migrated.version, STATE_VERSION);
    for (const key of ['attempts', 'fingers', 'movements', 'lessons', 'plans', 'tasks', 'assessments']) {
      assert.ok(key in migrated);
    }
    assert.ok(Array.isArray(migrated.attempts));
  });

  test('migrate preserves existing settings and adds new defaults', () => {
    const migrated = migrate({ version: 0, profile: { settings: { mode: 'strict' } } });
    assert.equal(migrated.profile.settings.mode, 'strict');
    assert.ok(migrated.profile.settings.dailyGoalExercises, 'missing defaults are added');
  });

  test('migrate drops uninterpretable attempts', () => {
    const migrated = migrate({
      version: 0,
      attempts: [
        { lessonId: 'ok', exerciseId: 'ok-E1', metrics: { wpm: 10 } },
        { lessonId: 'no-metrics', exerciseId: 'x' },
        { metrics: { wpm: 5 } },
        null,
      ],
    });
    assert.equal(migrated.attempts.length, 1);
    assert.equal(migrated.attempts[0].lessonId, 'ok');
  });

  test('migrate replaces a non-object section with a default', () => {
    const migrated = migrate({ version: 0, plans: ['not', 'an', 'object'], fingers: 42 });
    assert.deepEqual(migrated.plans, {});
    assert.deepEqual(migrated.fingers, {});
  });
});

/* ------------------------------------------------------------------ *
 * IndexedDbStore
 * ------------------------------------------------------------------ */

describe('IndexedDbStore', () => {
  test('a fresh database yields an empty document', async () => {
    const store = new IndexedDbStore();
    const state = await store.init();
    assert.equal(state.attempts.length, 0);
    assert.equal(store.available, true);
  });

  test('appending an attempt persists it', async () => {
    const store = new IndexedDbStore();
    await store.init();
    store.appendAttempt(attempt({ lessonId: 'L1' }));
    await store.flush();

    const reopened = new IndexedDbStore();
    await reopened.init();
    assert.equal(reopened.getState().attempts.length, 1);
    assert.equal(reopened.getState().attempts[0].lessonId, 'L1');
  });

  test('history is capped at maxAttempts, keeping the newest', async () => {
    const store = new IndexedDbStore({ maxAttempts: 5 });
    await store.init();
    for (let i = 0; i < 10; i += 1) store.appendAttempt(attempt({ lessonId: `L${i}` }));
    await store.flush();

    const attempts = store.getState().attempts;
    assert.equal(attempts.length, 5);
    assert.equal(attempts[0].lessonId, 'L5');
  });

  test('updatedAt advances on update', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new IndexedDbStore({ now: () => now });
    await store.init();
    const before = store.getState().updatedAt;
    now = new Date('2026-01-02T00:00:00Z');
    store.update((state) => {
      state.profile.name = 'changed';
    });
    await store.flush();
    assert.notEqual(store.getState().updatedAt, before);
  });

  test('replaceState swaps the whole document', async () => {
    const store = new IndexedDbStore();
    await store.init();
    store.appendAttempt(attempt({ lessonId: 'old' }));
    await store.flush();

    await store.replaceState({ ...emptyState(), attempts: [attempt({ lessonId: 'new' })] });
    assert.equal(store.getState().attempts.length, 1);
    assert.equal(store.getState().attempts[0].lessonId, 'new');

    const reopened = new IndexedDbStore();
    await reopened.init();
    assert.equal(reopened.getState().attempts[0].lessonId, 'new');
  });

  test('clear empties the document and the persisted copy', async () => {
    const store = new IndexedDbStore();
    await store.init();
    store.appendAttempt(attempt({ lessonId: 'L1' }));
    await store.flush();

    await store.clear();
    assert.equal(store.getState().attempts.length, 0);

    const reopened = new IndexedDbStore();
    await reopened.init();
    assert.equal(reopened.getState().attempts.length, 0);
  });

  test('writes are serialised, so rapid updates cannot interleave', async () => {
    const store = new IndexedDbStore();
    await store.init();
    for (let i = 0; i < 20; i += 1) store.appendAttempt(attempt({ lessonId: `L${i}` }));
    await store.flush();

    const reopened = new IndexedDbStore();
    await reopened.init();
    assert.equal(reopened.getState().attempts.length, 20, 'every write should have landed');
    assert.equal(reopened.getState().attempts[19].lessonId, 'L19');
  });

  test('a backup of the previous document is kept', async () => {
    const store = new IndexedDbStore();
    await store.init();
    store.appendAttempt(attempt({ lessonId: 'first' }));
    await store.flush();
    store.appendAttempt(attempt({ lessonId: 'second' }));
    await store.flush();

    const backup = await store.lastBackup();
    assert.ok(backup, 'a backup should exist after writes');
    assert.ok(backup.state.attempts.length >= 1);
  });

  test('backups are pruned so storage does not grow without bound', async () => {
    const store = new IndexedDbStore();
    await store.init();
    for (let i = 0; i < 10; i += 1) {
      store.appendAttempt(attempt({ lessonId: `L${i}` }));
      await store.flush();
    }
    const db = idb.databases.get(DB_NAME);
    const backups = db.stores.get('backups');
    assert.ok(backups.data.size <= 3, `expected at most 3 backups, found ${backups.data.size}`);
  });

  test('falls back to memory when IndexedDB is unavailable', async () => {
    // Simulate a browser that blocks storage (private mode).
    globalThis.indexedDB = {
      open() {
        const request = { error: new Error('blocked'), onsuccess: null, onerror: null, onupgradeneeded: null };
        setTimeout(() => request.onerror?.({ target: request }), 0);
        return request;
      },
    };

    const store = new IndexedDbStore();
    await store.init();
    assert.equal(store.available, false);
    assert.ok(store.storageError, 'the reason should be recorded');

    // The app must still work in-memory.
    store.appendAttempt(attempt({ lessonId: 'memory-only' }));
    assert.equal(store.getState().attempts.length, 1);
    await store.flush(); // must not throw
  });

  test('using the store before init is a clear error', () => {
    const store = new IndexedDbStore();
    assert.throws(() => store.getState(), /before init/);
    assert.throws(() => store.update((s) => s), /before init/);
  });
});
