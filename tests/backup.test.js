/**
 * Backup and restore tests.
 *
 * Import is the one place untrusted data enters the app, and export is the only
 * copy of a user's history that survives a browser reset. Both are covered hard:
 * validation must reject junk, merging must never duplicate or lose attempts, and
 * replace must be explicit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExport,
  validateExport,
  parseImport,
  mergeStates,
  replaceState,
  attemptKey,
  exportFilename,
  summarise,
  EXPORT_FORMAT,
  EXPORT_VERSION,
} from '../web/core/backup.js';
import { emptyState, STATE_VERSION } from '../web/core/db.js';
import { buildFixtureLibrary, attempt } from './fixtures.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const library = buildFixtureLibrary();

/** A state with a couple of attempts, for export tests. */
function sampleState(lessonIds = ['T-INDEX-HOME', 'T-RING-HOME']) {
  return {
    ...emptyState(),
    attempts: lessonIds.map((lessonId, i) =>
      attempt({
        lessonId,
        finishedAt: new Date(NOW.getTime() - (lessonIds.length - i) * 60000).toISOString(),
      }),
    ),
    plans: { '2026-11-15': { date: '2026-11-15', items: [] } },
    tasks: { '2026-11-15': { date: '2026-11-15', tasks: [] } },
  };
}

/** Serialise a state as an export file, as the UI does. */
function toFile(state, overrides = {}) {
  return JSON.stringify({ ...buildExport(state, { now: () => NOW, library }), ...overrides });
}

describe('export', () => {
  test('carries the format marker, both versions and a timestamp', () => {
    const payload = buildExport(sampleState(), { now: () => NOW, library });
    assert.equal(payload.format, EXPORT_FORMAT);
    assert.equal(payload.exportVersion, EXPORT_VERSION);
    assert.equal(payload.schemaVersion, STATE_VERSION);
    assert.equal(payload.exportedAt, NOW.toISOString());
  });

  test('includes the attempt history, which is the irreplaceable part', () => {
    const payload = buildExport(sampleState(), { now: () => NOW });
    assert.equal(payload.data.attempts.length, 2);
    assert.ok(payload.data.attempts[0].metrics, 'metrics must survive the round trip');
  });

  test('includes plans and task state so the same day can be resumed', () => {
    const payload = buildExport(sampleState(), { now: () => NOW });
    assert.ok(payload.data.plans['2026-11-15']);
    assert.ok(payload.data.tasks['2026-11-15']);
  });

  test('includes a human-readable summary', () => {
    const payload = buildExport(sampleState(), { now: () => NOW });
    assert.equal(payload.summary.attempts, 2);
    assert.equal(payload.summary.lessons, 2);
    assert.ok(payload.summary.practiceMs > 0);
  });

  test('an empty profile still exports cleanly', () => {
    const payload = buildExport(emptyState(), { now: () => NOW });
    assert.equal(payload.summary.attempts, 0);
    assert.deepEqual(payload.data.attempts, []);
  });

  test('the export is valid JSON that survives a round trip', () => {
    const text = toFile(sampleState());
    const parsed = JSON.parse(text);
    assert.equal(parsed.data.attempts.length, 2);
  });

  test('filename is chronological and names the content', () => {
    const name = exportFilename(NOW, 42);
    assert.match(name, /^typebreak-progress-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-42attempts\.json$/);
  });

  test('summarise handles attempts without timestamps', () => {
    const state = { ...emptyState(), attempts: [{ lessonId: 'L', exerciseId: 'E', metrics: { elapsedMs: 100 } }] };
    const summary = summarise(state);
    assert.equal(summary.attempts, 1);
    assert.equal(summary.firstAttemptAt, null);
  });
});

describe('validation — rejected files', () => {
  test('rejects non-JSON text', () => {
    const result = parseImport('this is not json');
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /not valid JSON/i);
  });

  test('rejects a JSON document that is not an object', () => {
    assert.equal(parseImport('[1,2,3]').ok, false);
    assert.equal(parseImport('"hello"').ok, false);
    assert.equal(parseImport('null').ok, false);
  });

  test('rejects a file with the wrong format marker', () => {
    const result = validateExport({ format: 'some-other-app', exportVersion: 1, data: { attempts: [] } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /not a TypeBreak progress export/);
  });

  test('rejects a file with no format marker at all', () => {
    const result = validateExport({ data: { attempts: [] } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /missing the TypeBreak format marker/);
  });

  test('rejects a file from a newer version', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      exportVersion: EXPORT_VERSION + 1,
      data: { attempts: [] },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /newer version/);
  });

  test('rejects a newer data schema than this build understands', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      exportVersion: EXPORT_VERSION,
      schemaVersion: STATE_VERSION + 5,
      data: { attempts: [] },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /newer than this build supports/);
  });

  test('rejects a file with no data section', () => {
    const result = validateExport({ format: EXPORT_FORMAT, exportVersion: 1 });
    assert.equal(result.ok, false);
  });

  test('rejects a file whose attempts are not a list', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      exportVersion: 1,
      data: { attempts: { not: 'a list' } },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /attempt history is missing/);
  });

  test('an oversized file is refused before parsing', () => {
    const huge = 'x'.repeat(33 * 1024 * 1024);
    const result = parseImport(huge);
    assert.equal(result.ok, false);
  });
});

describe('validation — accepted files', () => {
  test('accepts a file this app just produced', () => {
    const result = parseImport(toFile(sampleState()), { library });
    assert.equal(result.ok, true, result.errors?.join(' '));
    assert.equal(result.data.attempts.length, 2);
  });

  test('warns about, and skips, records with missing fields', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [
        attempt({ lessonId: 'T-INDEX-HOME' }),
        { lessonId: 'T-INDEX-HOME' }, // no exerciseId or metrics
        null,
      ],
    });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    assert.equal(result.data.attempts.length, 1);
    assert.match(result.warnings.join(' '), /could not be read/);
  });

  test('skips attempts for lessons this build does not have', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [attempt({ lessonId: 'T-INDEX-HOME' }), attempt({ lessonId: 'LESSON-FROM-THE-FUTURE' })],
    });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    assert.equal(result.data.attempts.length, 1);
    assert.match(result.warnings.join(' '), /does not have/);
  });

  test('coerces bad numeric values instead of propagating NaN', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [
        {
          lessonId: 'T-INDEX-HOME',
          exerciseId: 'T-INDEX-HOME-E1',
          finishedAt: NOW.toISOString(),
          metrics: { wpm: 'not a number', accuracy: 999, elapsedMs: null, errors: undefined },
        },
      ],
    });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    const metrics = result.data.attempts[0].metrics;
    assert.equal(metrics.wpm, 0, 'a bad number becomes 0, not NaN');
    assert.equal(metrics.accuracy, 100, 'accuracy is clamped to 100');
    assert.equal(Number.isFinite(metrics.elapsedMs), true);
  });

  test('keeps finger and movement tallies that the analytics need', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [
        attempt({
          lessonId: 'T-INDEX-HOME',
          fingerStats: { LINDEX: { correct: 90, wrong: 10, total: 100 } },
          movementStats: { home: { correct: 90, wrong: 10, total: 100 } },
        }),
      ],
    });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    assert.equal(result.data.attempts[0].fingerStats.LINDEX.wrong, 10);
    assert.equal(result.data.attempts[0].movementStats.home.total, 100);
  });

  test('drops keystroke samples, which no analytics read', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [
        {
          ...attempt({ lessonId: 'T-INDEX-HOME' }),
          keystrokes: Array.from({ length: 500 }, (_, i) => ({ t: i, correct: true })),
        },
      ],
    });
    const result = parseImport(file, { library });
    assert.deepEqual(result.data.attempts[0].keystrokes, []);
  });

  test('a file with an older but compatible schema is accepted', () => {
    const file = toFile(sampleState(), { schemaVersion: 1 });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
  });
});

describe('merging', () => {
  test('adds new attempts and keeps the existing ones', () => {
    const current = { ...emptyState(), attempts: [attempt({ lessonId: 'T-INDEX-HOME' })] };
    const incoming = {
      ...emptyState(),
      attempts: [attempt({ lessonId: 'T-RING-HOME', finishedAt: new Date(NOW.getTime() + 60000).toISOString() })],
    };

    const result = mergeStates(current, incoming, { now: () => NOW });
    assert.equal(result.added, 1);
    assert.equal(result.state.attempts.length, 2);
  });

  test('re-importing the same file adds nothing', () => {
    const state = sampleState();
    const result = mergeStates(state, state, { now: () => NOW });
    assert.equal(result.added, 0);
    assert.equal(result.duplicates, 2);
    assert.equal(result.state.attempts.length, 2);
  });

  test('partially overlapping files add only the new records', () => {
    const shared = attempt({ lessonId: 'T-INDEX-HOME' });
    const current = { ...emptyState(), attempts: [shared] };
    const incoming = {
      ...emptyState(),
      attempts: [shared, attempt({ lessonId: 'T-RING-HOME', finishedAt: new Date(NOW.getTime() + 60000).toISOString() })],
    };

    const result = mergeStates(current, incoming, { now: () => NOW });
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.state.attempts.length, 2);
  });

  test('merged attempts end up in chronological order', () => {
    const current = {
      ...emptyState(),
      attempts: [attempt({ lessonId: 'T-INDEX-HOME', finishedAt: '2026-11-15T12:00:00.000Z' })],
    };
    const incoming = {
      ...emptyState(),
      attempts: [attempt({ lessonId: 'T-RING-HOME', finishedAt: '2026-11-15T09:00:00.000Z' })],
    };

    const result = mergeStates(current, incoming, { now: () => NOW });
    const times = result.state.attempts.map((a) => new Date(a.finishedAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test('merging preserves local settings rather than adopting the file\'s', () => {
    const current = { ...emptyState(), profile: { ...emptyState().profile, settings: { mode: 'strict', dailyGoalExercises: 10 } } };
    const incoming = { ...emptyState(), profile: { ...emptyState().profile, settings: { mode: 'flow', dailyGoalExercises: 2 } } };

    const result = mergeStates(current, incoming, { now: () => NOW });
    assert.equal(result.state.profile.settings.mode, 'strict', 'the local typing mode wins');
    assert.equal(result.state.profile.settings.dailyGoalExercises, 10);
  });

  test('merging keeps the existing day plan rather than the file\'s', () => {
    const current = { ...emptyState(), plans: { '2026-11-15': { date: '2026-11-15', marker: 'mine' } } };
    const incoming = { ...emptyState(), plans: { '2026-11-15': { date: '2026-11-15', marker: 'theirs' }, '2026-11-14': { date: '2026-11-14' } } };

    const result = mergeStates(current, incoming, { now: () => NOW });
    assert.equal(result.state.plans['2026-11-15'].marker, 'mine');
    assert.ok(result.state.plans['2026-11-14'], 'days only in the file are still added');
  });

  test('identity ignores metrics but respects timing', () => {
    const a = { lessonId: 'L', exerciseId: 'E', startedAt: 1, finishedAt: '2026-01-01T00:00:00.000Z' };
    const b = { ...a, metrics: { wpm: 999 } };
    const c = { ...a, finishedAt: '2026-01-02T00:00:00.000Z' };

    assert.equal(attemptKey(a), attemptKey(b), 'the same attempt with different metrics is the same attempt');
    assert.notEqual(attemptKey(a), attemptKey(c), 'a different completion time is a different attempt');
  });

  test('identity treats a numeric and a string timestamp as the same instant', () => {
    // Regression: records written by an earlier build stored epoch milliseconds.
    // Comparing them to ISO strings made every re-import look like new data.
    const epoch = Date.parse('2026-01-01T00:00:00.000Z');
    const numeric = { lessonId: 'L', exerciseId: 'E', startedAt: epoch, finishedAt: epoch };
    const stringy = {
      lessonId: 'L',
      exerciseId: 'E',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(attemptKey(numeric), attemptKey(stringy));
  });

  test('imported attempts are marked so they can be recognised later', () => {
    const result = parseImport(
      toFile({ ...sampleState(), attempts: [attempt({ lessonId: 'T-INDEX-HOME' })] }),
      { library },
    );
    assert.equal(result.data.attempts[0].imported, true);
  });

  test('a numeric timestamp from an older build is preserved, not reset to 1970', () => {
    // Regression: the engine once wrote epoch milliseconds. The sanitiser only
    // accepted strings, so a backup from that build had every attempt dated to
    // the epoch — which silently destroyed streaks and the practice calendar.
    const epoch = Date.parse('2026-11-14T09:30:00.000Z');
    const file = toFile({
      ...sampleState(),
      attempts: [
        {
          lessonId: 'T-INDEX-HOME',
          exerciseId: 'T-INDEX-HOME-E1',
          startedAt: epoch - 60000,
          finishedAt: epoch,
          metrics: { wpm: 30, accuracy: 97, errors: 1, elapsedMs: 60000, completion: 100 },
        },
      ],
    });

    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    assert.equal(result.data.attempts[0].finishedAt, '2026-11-14T09:30:00.000Z');
    assert.equal(result.data.attempts[0].startedAt, '2026-11-14T09:29:00.000Z');
  });

  test('an unparseable timestamp falls back rather than throwing', () => {
    const file = toFile({
      ...sampleState(),
      attempts: [
        {
          lessonId: 'T-INDEX-HOME',
          exerciseId: 'T-INDEX-HOME-E1',
          finishedAt: 'not a date',
          metrics: { wpm: 30, accuracy: 97, elapsedMs: 1, completion: 100 },
        },
      ],
    });
    const result = parseImport(file, { library });
    assert.equal(result.ok, true);
    assert.ok(typeof result.data.attempts[0].finishedAt === 'string');
    assert.equal(Number.isNaN(new Date(result.data.attempts[0].finishedAt).getTime()), false);
  });
});

describe('replacing', () => {
  test('replaces the entire history', () => {
    const incoming = { ...emptyState(), attempts: [attempt({ lessonId: 'T-RING-HOME' })] };
    const result = replaceState(incoming, { now: () => NOW });
    assert.equal(result.replaced, 1);
    assert.equal(result.state.attempts.length, 1);
    assert.equal(result.state.attempts[0].lessonId, 'T-RING-HOME');
  });

  test('replace still applies migration', () => {
    const result = replaceState({ attempts: [attempt({ lessonId: 'T-RING-HOME' })] }, { now: () => NOW });
    assert.equal(result.state.version, STATE_VERSION);
    assert.ok(result.state.plans);
  });
});

describe('import preview', () => {
  test('reports exactly how many attempts are new', () => {
    const shared = attempt({ lessonId: 'T-INDEX-HOME' });
    const current = { ...emptyState(), attempts: [shared] };
    const file = toFile({ ...emptyState(), attempts: [shared, attempt({ lessonId: 'T-RING-HOME', finishedAt: new Date(NOW.getTime() + 1000).toISOString() })] });

    const result = parseImport(file, { library });
    assert.equal(result.ok, true);

    const existing = new Set(current.attempts.map(attemptKey));
    const newOnes = result.data.attempts.filter((a) => !existing.has(attemptKey(a))).length;
    assert.equal(newOnes, 1);
  });

  test('a file containing everything currently held loses nothing on replace', () => {
    const state = sampleState();
    const result = parseImport(toFile(state), { library });
    assert.equal(result.ok, true);

    const incomingKeys = new Set(result.data.attempts.map(attemptKey));
    const wouldLose = state.attempts.filter((a) => !incomingKeys.has(attemptKey(a)));
    assert.equal(wouldLose.length, 0);
  });
});
