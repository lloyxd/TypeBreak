/**
 * Page-facing data access.
 *
 * A thin adapter over the local `AppService`. Pages call these methods and
 * nothing else; every one of them delegates immediately, so there is no
 * business logic here — the point is to keep the pages free of import
 * plumbing and to have a single place where a page's needs are visible.
 *
 * Everything is synchronous over in-memory state except storage operations,
 * which are awaited. No network calls exist in this file.
 */

import { getService, storageAvailable, storageError } from './core/context.js';
import { EXPORT_VERSION, EXPORT_FORMAT, IMPORT_MODES } from './core/backup.js';

const service = () => getService();

export const client = {
  /* ---- library ---- */

  lessons(filters = {}) {
    // Page filters arrive straight from URL query params, so "not set" is an
    // empty string. Normalise those away rather than passing '' down to the
    // library, where '' is a real (and unmatchable) value.
    const clean = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      clean[key] = key === 'difficulty' && typeof value === 'string' ? Number.parseInt(value, 10) : value;
    }
    return service().lessons(clean);
  },

  lesson(id) {
    const found = service().lesson(id);
    if (!found) return null;
    const progress = service().lessonProgress().find((p) => p.lessonId === id) ?? null;
    return { lesson: found, progress };
  },

  libraryOverview() {
    return service().libraryOverview();
  },

  reference() {
    return service().reference();
  },

  /* ---- dashboard and progress ---- */

  dashboard() {
    return service().dashboard();
  },

  stats() {
    return service().stats();
  },

  fingers() {
    return service().fingerProgress();
  },

  movements() {
    return service().movementProgress();
  },

  lessonProgress() {
    return service().lessonProgress();
  },

  history(days = 30) {
    return service().history({ days });
  },

  /* ---- adaptive ---- */

  adaptive() {
    return service().assessment();
  },

  regeneratePlan() {
    return service().assessment({ forcePlan: true });
  },

  recommendations(limit = 10) {
    return service().recommendations(limit);
  },

  weaknesses() {
    return service().weaknesses();
  },

  /* ---- practice sessions ---- */

  startSession({ lessonId, exerciseId, mode }) {
    return service().startSession({ lessonId, exerciseId, mode });
  },

  press(key) {
    return service().press({ key });
  },

  finish() {
    return service().finishSession();
  },

  cancel() {
    return service().cancelSession();
  },

  /** Resolve once every queued write has landed. */
  flush() {
    return service().flush();
  },

  /* ---- settings ---- */

  settings() {
    return service().settings();
  },

  updateSettings(patch) {
    return service().updateSettings(patch);
  },

  async reset() {
    await service().resetProgress();
    await service().flush();
    return { reset: true };
  },

  /* ---- backup ---- */

  /** Everything the backup UI needs, without serialising the whole history. */
  backupInfo() {
    const payload = service().createExport();
    return {
      format: payload.format,
      exportVersion: payload.exportVersion,
      schemaVersion: payload.schemaVersion,
      summary: payload.summary,
      attempts: payload.summary.attempts,
      lessons: payload.summary.lessons,
    };
  },

  /** Build and serialise a backup; returns `{ filename, text, summary }`. */
  createBackup() {
    const payload = service().createExport();
    return {
      filename: backupFilename(payload.summary.attempts),
      text: `${JSON.stringify(payload, null, 2)}\n`,
      summary: payload.summary,
      exportVersion: payload.exportVersion,
      schemaVersion: payload.schemaVersion,
    };
  },

  /** Validate a file's text and preview the effect of importing it. */
  inspectImport(text) {
    return service().inspectImport(text);
  },

  /** Apply a validated import in merge or replace mode. */
  applyImport({ text, mode }) {
    return service().applyImport({ text, mode });
  },

  async storageUsage() {
    return service().storageUsage();
  },

  /** Storage health, surfaced when IndexedDB is unavailable. */
  storage() {
    return { available: storageAvailable(), error: storageError() };
  },

  constants() {
    return { EXPORT_VERSION, EXPORT_FORMAT, IMPORT_MODES };
  },
};

/** `typebreak-progress-2026-11-25T17-30-00-124attempts.json` */
function backupFilename(attempts) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `typebreak-progress-${stamp}-${attempts}attempts.json`;
}
