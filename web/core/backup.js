/**
 * Progress backup and restore.
 *
 * The export format is versioned and self-describing so a file written by any
 * released version can be read by a later one. Import validates before touching
 * anything and never silently overwrites: the caller must choose merge or
 * replace, and this module reports exactly what would or did change.
 *
 * Nothing here touches the network. A backup is a local file the user owns.
 */

import { STATE_VERSION, emptyState, migrate } from './db.js';
import { FINGER_INFO, MOVEMENTS } from './keyboard.js';

/** Identifies our files in a sea of random JSON. */
export const EXPORT_FORMAT = 'typebreak-progress';
export const EXPORT_VERSION = 1;

/** Files above this are refused — a guard against a wrong file or a runaway log. */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export const IMPORT_MODES = {
  merge: {
    id: 'merge',
    label: 'Merge',
    description: 'Keep your current progress and add anything new from the file.',
  },
  replace: {
    id: 'replace',
    label: 'Replace',
    description: 'Delete your current progress and restore only what is in the file.',
  },
};

/**
 * Build a backup object from the live state.
 *
 * Attempts are the irreplaceable part — everything else (finger profiles,
 * weaknesses, plans) is derived from them — so the export includes them in full
 * and does not include derived caches that could go stale.
 */
export function buildExport(state, { now = () => new Date(), library = null } = {}) {
  const exportedAt = now().toISOString();

  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    // Document schema version, distinct from the file format version: the format
    // may stay stable while the document schema evolves.
    schemaVersion: STATE_VERSION,
    exportedAt,
    application: {
      name: 'TypeBreak',
      lessons: library ? library.size : undefined,
    },
    summary: summarise(state),
    data: {
      profile: state.profile,
      attempts: state.attempts,
      // Plans and task state are per-day; keeping recent ones lets an import
      // resume the same day without a plan reshuffle.
      plans: state.plans,
      tasks: state.tasks,
      assessments: state.assessments,
    },
  };
}

/** A readable digest of what a file contains, shown before importing. */
export function summarise(state) {
  // Tolerate a partially corrupt document: summarising must never throw, since
  // it runs on export (the user's backup) as well as on import.
  const attempts = Array.isArray(state?.attempts) ? state.attempts.filter((a) => a && typeof a === 'object') : [];
  const dates = attempts
    .map((a) => a.finishedAt)
    .filter((d) => typeof d === 'string')
    .sort();

  const practiceMs = attempts.reduce((sum, a) => {
    const elapsed = a.metrics?.elapsedMs;
    return sum + (typeof elapsed === 'number' && Number.isFinite(elapsed) ? elapsed : 0);
  }, 0);
  const lessons = new Set(attempts.map((a) => a.lessonId).filter(Boolean));

  return {
    attempts: attempts.length,
    lessons: lessons.size,
    practiceMs,
    firstAttemptAt: dates[0] ?? null,
    lastAttemptAt: dates[dates.length - 1] ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validate a parsed file.
 *
 * Returns `{ ok, errors, warnings, data }`. Errors block import; warnings do
 * not. The aim is to be strict about structure (so a corrupt file cannot poison
 * the store) and forgiving about content (so a slightly older export still
 * works).
 */
export function validateExport(parsed, { library = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['The file does not contain a JSON object.'], warnings, data: null };
  }

  if (parsed.format !== EXPORT_FORMAT) {
    errors.push(
      parsed.format
        ? `This looks like a "${parsed.format}" file, not a TypeBreak progress export.`
        : 'This file is missing the TypeBreak format marker, so it is probably not a progress export.',
    );
  }

  if (typeof parsed.exportVersion !== 'number') {
    errors.push('The file has no export version, so it cannot be interpreted safely.');
  } else if (parsed.exportVersion > EXPORT_VERSION) {
    errors.push(
      `This file was created by a newer version of TypeBreak (export format ${parsed.exportVersion}; this build understands up to ${EXPORT_VERSION}). Update the app, then import again.`,
    );
  }

  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > STATE_VERSION + 1) {
    errors.push(
      `The file uses data schema ${parsed.schemaVersion}, which is newer than this build supports (${STATE_VERSION}).`,
    );
  }

  const data = parsed.data;
  if (!data || typeof data !== 'object') {
    errors.push('The file contains no "data" section.');
    return { ok: false, errors, warnings, data: null };
  }

  if (!Array.isArray(data.attempts)) {
    errors.push('The file\'s attempt history is missing or is not a list, so performance cannot be restored.');
  }

  if (errors.length) return { ok: false, errors, warnings, data: null };

  // Content checks: drop unusable attempts rather than failing the whole file.
  const valid = [];
  let discarded = 0;
  let unknownLessons = 0;

  for (const attempt of data.attempts) {
    if (!attempt || typeof attempt !== 'object' || !attempt.metrics || !attempt.exerciseId || !attempt.lessonId) {
      discarded += 1;
      continue;
    }
    if (library && !library.has(attempt.lessonId)) {
      unknownLessons += 1;
      continue;
    }
    // A record with a metrics object is kept even if individual figures are
    // unusable: `sanitiseAttempt` coerces them, and discarding a whole attempt
    // over one bad field would quietly shorten the user's history.
    if (typeof attempt.metrics !== 'object' || attempt.metrics === null) {
      discarded += 1;
      continue;
    }
    valid.push(sanitiseAttempt(attempt));
  }

  if (discarded) {
    warnings.push(`${discarded} record${discarded === 1 ? '' : 's'} could not be read and will be skipped.`);
  }
  if (unknownLessons) {
    warnings.push(
      `${unknownLessons} attempt${unknownLessons === 1 ? '' : 's'} refer to lessons this version of TypeBreak does not have, and will be skipped.`,
    );
  }

  const sanitised = migrate({
    ...emptyState(),
    ...data,
    attempts: valid,
  });

  return { ok: true, errors: [], warnings, data: sanitised };
}

/**
 * Normalise a timestamp to an ISO string.
 *
 * Records written by earlier builds stored epoch milliseconds; newer ones store
 * ISO strings. Both must import correctly, because a user's backup may predate
 * an upgrade. Numbers are converted rather than dropped — treating a valid
 * number as invalid here would silently reset an attempt's date to 1970 and
 * corrupt the user's streak.
 */
function toIsoString(value) {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Coerce an attempt into a known-good shape.
 *
 * Imported data is untrusted input: it may be hand-edited, truncated, or from a
 * future version. Only fields the analytics actually read are kept, with types
 * enforced, so a malformed value cannot produce `NaN` in a report later.
 */
function sanitiseAttempt(attempt) {
  const metrics = attempt.metrics ?? {};
  const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

  const cleanStats = (table) => {
    if (!table || typeof table !== 'object') return {};
    const out = {};
    for (const [key, stats] of Object.entries(table)) {
      if (!stats || typeof stats !== 'object') continue;
      const total = num(stats.total);
      if (total <= 0) continue;
      out[key] = { correct: num(stats.correct), wrong: num(stats.wrong), total };
    }
    return out;
  };

  const finishedAt = toIsoString(attempt.finishedAt) ?? toIsoString(attempt.recordedAt) ?? new Date(0).toISOString();
  const startedAt = toIsoString(attempt.startedAt);

  return {
    lessonId: String(attempt.lessonId),
    exerciseId: String(attempt.exerciseId),
    mode: attempt.mode === 'strict' ? 'strict' : 'flow',
    text: typeof attempt.text === 'string' ? attempt.text : '',
    metrics: {
      wpm: num(metrics.wpm),
      cpm: num(metrics.cpm),
      grossWpm: num(metrics.grossWpm),
      accuracy: Math.max(0, Math.min(100, num(metrics.accuracy))),
      errors: num(metrics.errors),
      correctChars: num(metrics.correctChars),
      totalKeystrokes: num(metrics.totalKeystrokes),
      elapsedMs: num(metrics.elapsedMs),
      completion: Math.max(0, Math.min(100, num(metrics.completion))),
    },
    errorsByChar: typeof attempt.errorsByChar === 'object' && attempt.errorsByChar ? attempt.errorsByChar : {},
    errorsByFinger: typeof attempt.errorsByFinger === 'object' && attempt.errorsByFinger ? attempt.errorsByFinger : {},
    errorsByMovement: typeof attempt.errorsByMovement === 'object' && attempt.errorsByMovement ? attempt.errorsByMovement : {},
    fingerStats: cleanStats(attempt.fingerStats),
    movementStats: cleanStats(attempt.movementStats),
    // Keystroke samples are a large part of a file and are not read by any
    // analytics, so they are dropped on import to keep the store lean.
    keystrokes: [],
    startedAt,
    finishedAt,
    fullyCorrect: Boolean(attempt.fullyCorrect),
    recordedAt: toIsoString(attempt.recordedAt) ?? finishedAt ?? null,
    imported: true,
  };
}

/* ------------------------------------------------------------------ *
 * Merging
 * ------------------------------------------------------------------ */

/**
 * A stable identity for an attempt, so re-importing the same file (or a file
 * that overlaps current progress) cannot double-count.
 *
 * Timestamps are normalised to ISO before comparison: a record written by an
 * older build stored epoch milliseconds, and without this the same attempt read
 * back from a file would look new. Metrics are deliberately excluded — the same
 * exercise finishing at the same instant is the same attempt even if a re-export
 * rounded a figure.
 */
export function attemptKey(attempt) {
  const stamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    return '';
  };
  return `${attempt.lessonId}|${attempt.exerciseId}|${stamp(attempt.finishedAt)}|${stamp(attempt.startedAt)}`;
}

/**
 * Merge imported attempts into the current state.
 *
 * @returns {{state, added, duplicates, replaced}}
 */
export function mergeStates(current, incoming, { now = () => new Date() } = {}) {
  const existingKeys = new Set((current.attempts ?? []).map(attemptKey));
  const added = [];
  let duplicates = 0;

  for (const attempt of incoming.attempts ?? []) {
    const key = attemptKey(attempt);
    if (existingKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    existingKeys.add(key);
    added.push(attempt);
  }

  const merged = {
    ...current,
    attempts: [...(current.attempts ?? []), ...added].sort(
      (a, b) => new Date(a.finishedAt ?? 0) - new Date(b.finishedAt ?? 0),
    ),
    // Day plans are keyed by date; the existing ones win so today's plan is not
    // rearranged by an import.
    plans: { ...(incoming.plans ?? {}), ...(current.plans ?? {}) },
    tasks: { ...(incoming.tasks ?? {}), ...(current.tasks ?? {}) },
    assessments: { ...(incoming.assessments ?? {}), ...(current.assessments ?? {}) },
    // Settings stay as the user has them locally; an import must not silently
    // change their typing mode or goals.
    profile: {
      ...current.profile,
      settings: { ...(current.profile?.settings ?? {}) },
    },
    updatedAt: now().toISOString(),
  };

  return { state: migrate(merged), added: added.length, duplicates, replaced: 0 };
}

/** Replace current progress entirely with the imported document. */
export function replaceState(incoming, { now = () => new Date() } = {}) {
  const next = migrate({ ...incoming, updatedAt: now().toISOString() });
  return { state: next, added: next.attempts.length, duplicates: 0, replaced: 1 };
}

/* ------------------------------------------------------------------ *
 * File helpers
 * ------------------------------------------------------------------ */

/** A filename that sorts chronologically and names the content. */
export function exportFilename(date = new Date(), attemptCount = 0) {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `typebreak-progress-${stamp}-${attemptCount}attempts.json`;
}

/** Serialise an export object for download. */
export function serialiseExport(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parse and validate a file's text.
 *
 * Kept separate from the `File` API so it can be unit-tested with a string.
 */
export function parseImport(text, { library = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`The file is not valid JSON: ${error.message}`],
      warnings: [],
      data: null,
    };
  }

  if (typeof text === 'string' && text.length > MAX_IMPORT_BYTES) {
    return { ok: false, errors: ['The file is too large to be a progress backup.'], warnings: [], data: null };
  }

  return validateExport(parsed, { library });
}

/** Reference tables used by the import summary UI. */
export function describeFingers() {
  return Object.values(FINGER_INFO).map((f) => f.label);
}

export function describeMovements() {
  return Object.values(MOVEMENTS).map((m) => m.label);
}
