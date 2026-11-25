/**
 * Store tests: atomic persistence, crash recovery, schema migration.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Store, emptyState, migrate, STATE_VERSION } from '../src/core/store.js';
import { attempt } from './fixtures.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typebreak-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newStore(name = 'state.json', opts = {}) {
  return new Store(join(dir, name), opts);
}

describe('store basics', () => {
  test('a missing file yields an empty state without error', () => {
    const store = newStore();
    const state = store.load();
    assert.equal(state.version, STATE_VERSION);
    assert.deepEqual(state.attempts, []);
    assert.ok(state.profile.settings);
  });

  test('save then load round-trips', () => {
    const store = newStore();
    store.load();
    store.appendAttempt(attempt({ lessonId: 'L1' }));
    store.save();

    const reopened = newStore();
    const state = reopened.load();
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].lessonId, 'L1');
  });

  test('update applies a change and persists in one step', () => {
    const store = newStore();
    store.update((state) => {
      state.profile.name = 'changed';
      return state;
    });
    const reopened = newStore();
    assert.equal(reopened.load().profile.name, 'changed');
  });

  test('attempt history is capped', () => {
    const store = newStore('state.json', { maxAttempts: 5 });
    store.load();
    for (let i = 0; i < 10; i += 1) store.appendAttempt(attempt({ lessonId: `L${i}` }));
    const state = store.getState();
    assert.equal(state.attempts.length, 5);
    assert.equal(state.attempts[0].lessonId, 'L5', 'the oldest attempts should be dropped');
  });

  test('updatedAt is refreshed on save', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new Store(join(dir, 'state.json'), { now: () => now });
    store.load();
    const before = store.getState().updatedAt;
    now = new Date('2026-01-02T00:00:00Z');
    store.save();
    assert.notEqual(store.getState().updatedAt, before);
  });

  test('reset clears progress', () => {
    const store = newStore();
    store.load();
    store.appendAttempt(attempt({ lessonId: 'L1' }));
    store.save();
    store.reset();
    assert.equal(store.getState().attempts.length, 0);
  });
});

describe('durability', () => {
  test('a write leaves a backup of the previous document', () => {
    const store = newStore();
    store.load();
    store.appendAttempt(attempt({ lessonId: 'first' }));
    store.save();
    // Second save should back up the file containing the first attempt.
    store.appendAttempt(attempt({ lessonId: 'second' }));
    store.save();
    assert.ok(existsSync(store.backupPath), 'a .bak file should exist after the second save');
  });

  test('a corrupt primary file is recovered from the backup', () => {
    const store = newStore();
    store.load();
    store.appendAttempt(attempt({ lessonId: 'survivor' }));
    store.save();
    store.appendAttempt(attempt({ lessonId: 'second' }));
    store.save();

    // Corrupt the primary file; the backup holds the earlier good state.
    writeFileSync(store.path, '{ this is not json', 'utf8');

    const reopened = newStore();
    const state = reopened.load();
    assert.ok(state.attempts.length >= 1, 'progress should survive a corrupt primary file');
  });

  test('a corrupt file with no backup is quarantined, not silently overwritten', () => {
    const store = newStore();
    writeFileSync(store.path, 'broken', 'utf8');
    const state = store.load();
    assert.equal(state.attempts.length, 0);
    // A copy of the damaged file must be kept for inspection.
    const quarantined = readdirSync(dir).filter((f) => f.includes('corrupt'));
    assert.equal(quarantined.length, 1, 'the damaged file should be preserved');
  });

  test('an empty file is treated as missing, not corrupt', () => {
    const store = newStore();
    writeFileSync(store.path, '', 'utf8');
    const state = store.load();
    assert.equal(state.attempts.length, 0);
  });

  test('the saved document is valid JSON with a trailing newline', () => {
    const store = newStore();
    store.load();
    store.save();
    const raw = readFileSync(store.path, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.doesNotThrow(() => JSON.parse(raw));
  });
});

describe('migration', () => {
  test('migrate fills in missing sections', () => {
    const migrated = migrate({ version: 0 });
    assert.equal(migrated.version, STATE_VERSION);
    for (const key of ['attempts', 'fingers', 'movements', 'lessons', 'plans', 'tasks', 'assessments']) {
      assert.ok(key in migrated, `migration should add ${key}`);
    }
    assert.ok(Array.isArray(migrated.attempts));
  });

  test('migrate preserves existing settings and adds new defaults', () => {
    const migrated = migrate({ version: 0, profile: { settings: { mode: 'strict' } } });
    assert.equal(migrated.profile.settings.mode, 'strict', 'existing settings survive');
    assert.ok(migrated.profile.settings.dailyGoalExercises, 'new defaults are added');
  });

  test('migrate drops uninterpretable attempt records', () => {
    const migrated = migrate({
      version: 0,
      attempts: [
        { lessonId: 'ok', exerciseId: 'ok-E1', metrics: { wpm: 10 } },
        { lessonId: 'no-metrics', exerciseId: 'x' },
        { metrics: { wpm: 5 } },
        null,
        { lessonId: 'no-exercise', metrics: { wpm: 1 } },
      ],
    });
    assert.equal(migrated.attempts.length, 1, 'only records with an exercise and metrics survive');
    assert.equal(migrated.attempts[0].lessonId, 'ok');
  });

  test('emptyState produces an independent object each call', () => {
    const a = emptyState();
    const b = emptyState();
    a.profile.name = 'x';
    assert.notEqual(b.profile.name, 'x');
  });
});
