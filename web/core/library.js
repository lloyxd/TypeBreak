/**
 * Lesson library access.
 *
 * The library is immutable and predefined: it is loaded from `data/lessons.json`
 * and never generated at runtime. This module is the only place that knows how
 * to find lessons, so the planner physically cannot invent one — it can only
 * receive objects that came from this file.
 *
 * `loadLibrary` is pure: pass a parsed JSON object and get a query facade back.
 * That makes the planner testable with a fixture library.
 */

import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel } from './keyboard.js';

export const CATEGORIES = {
  'finger-isolation': { id: 'finger-isolation', label: 'Finger isolation', order: 0 },
  'movement-variation': { id: 'movement-variation', label: 'Movement variation', order: 1 },
  'finger-combination': { id: 'finger-combination', label: 'Finger combination', order: 2 },
  pattern: { id: 'pattern', label: 'Typing patterns', order: 3 },
  coordination: { id: 'coordination', label: 'Coordination', order: 4 },
};

/** Depth-first freeze so a caller cannot mutate the shared library. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export class LibraryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibraryError';
  }
}

/**
 * Validate the shape of a library document. Throws rather than silently
 * accepting a malformed library, because every downstream calculation trusts it.
 */
export function validateLibrary(doc) {
  if (!doc || typeof doc !== 'object') throw new LibraryError('Library document is not an object');
  if (!Array.isArray(doc.lessons) || doc.lessons.length === 0) {
    throw new LibraryError('Library has no lessons');
  }

  const lessons = new Map();
  const exercises = new Map();
  const problems = [];

  for (const lesson of doc.lessons) {
    if (!lesson.id) problems.push('A lesson is missing an id');
    if (lessons.has(lesson.id)) problems.push(`Duplicate lesson id: ${lesson.id}`);
    if (!lesson.name) problems.push(`Lesson ${lesson.id} is missing a name`);
    if (!Array.isArray(lesson.fingers) || lesson.fingers.length === 0) {
      problems.push(`Lesson ${lesson.id} targets no fingers`);
    }
    if (!Array.isArray(lesson.movements) || lesson.movements.length === 0) {
      problems.push(`Lesson ${lesson.id} targets no movements`);
    }
    if (!Number.isInteger(lesson.level) || lesson.level < 1 || lesson.level > 10) {
      problems.push(`Lesson ${lesson.id} has an invalid level: ${lesson.level}`);
    }
    if (!Array.isArray(lesson.exercises) || lesson.exercises.length === 0) {
      problems.push(`Lesson ${lesson.id} has no exercises`);
    }
    for (const finger of lesson.fingers ?? []) {
      if (!FINGER_INFO[finger]) problems.push(`Lesson ${lesson.id} references unknown finger ${finger}`);
    }
    for (const movement of lesson.movements ?? []) {
      if (!MOVEMENTS[movement]) problems.push(`Lesson ${lesson.id} references unknown movement ${movement}`);
    }
    for (const exercise of lesson.exercises ?? []) {
      if (!exercise.id) problems.push(`Lesson ${lesson.id} has an exercise without an id`);
      if (exercises.has(exercise.id)) problems.push(`Duplicate exercise id: ${exercise.id}`);
      if (typeof exercise.text !== 'string' || !exercise.text.trim()) {
        problems.push(`Exercise ${exercise.id} has empty text`);
      }
    }
    lessons.set(lesson.id, lesson);
  }

  for (const lesson of doc.lessons) {
    for (const related of lesson.related ?? []) {
      if (!lessons.has(related)) {
        problems.push(`Lesson ${lesson.id} references missing related lesson ${related}`);
      }
    }
  }

  if (problems.length) {
    throw new LibraryError(`Invalid lesson library:\n- ${problems.join('\n- ')}`);
  }

  return doc;
}

/**
 * Build a queryable library from a parsed lesson document.
 */
export function loadLibrary(doc) {
  validateLibrary(doc);

  const byId = new Map(doc.lessons.map((lesson) => [lesson.id, deepFreeze(lesson)]));
  const exerciseIndex = new Map();
  for (const lesson of doc.lessons) {
    for (const exercise of lesson.exercises) {
      exerciseIndex.set(exercise.id, { lessonId: lesson.id, exercise });
    }
  }

  const all = [...byId.values()];

  const api = {
    meta: {
      schemaVersion: doc.schemaVersion ?? 1,
      counts: doc.counts ?? {},
      generatedBy: doc.generatedBy ?? null,
    },

    /** Every lesson, in library order. */
    all: () => all,

    size: all.length,

    /** Look up one lesson; returns null rather than throwing. */
    get(id) {
      return byId.get(id) ?? null;
    },

    /** Look up one lesson or throw — use when the id came from persisted state. */
    require(id) {
      const lesson = byId.get(id);
      if (!lesson) throw new LibraryError(`Unknown lesson: ${id}`);
      return lesson;
    },

    /** Resolve an exercise id to `{ lesson, exercise }`. */
    exercise(exerciseId) {
      const hit = exerciseIndex.get(exerciseId);
      if (!hit) throw new LibraryError(`Unknown exercise: ${exerciseId}`);
      return { lesson: byId.get(hit.lessonId), exercise: hit.exercise };
    },

    has: (id) => byId.has(id),

    /** Lessons ordered by level then library order. */
    byLevel() {
      return [...all].sort((a, b) => a.level - b.level || a.order - b.order);
    },

    /** Filter with any combination of criteria. All filters are ANDed. */
    filter({ finger, movement, category, difficulty, maxLevel, minLevel, search } = {}) {
      // Treat an empty string as "not specified". Query-param-driven UIs pass ''
      // for unset filters, and '' must never be interpreted as a real value.
      const has = (value) => value !== undefined && value !== null && value !== '';
      return all.filter((lesson) => {
        if (has(finger) && !lesson.fingers.includes(finger)) return false;
        if (has(movement) && !lesson.movements.includes(movement)) return false;
        if (has(category) && lesson.category !== category) return false;
        if (has(difficulty) && lesson.level !== Number(difficulty)) return false;
        if (has(maxLevel) && lesson.level > Number(maxLevel)) return false;
        if (has(minLevel) && lesson.level < Number(minLevel)) return false;
        if (has(search)) {
          const haystack = `${lesson.name} ${lesson.description} ${lesson.id}`.toLowerCase();
          if (!haystack.includes(String(search).toLowerCase())) return false;
        }
        return true;
      });
    },

    /** Lessons that train a specific finger. */
    forFinger(finger) {
      return all.filter((lesson) => lesson.fingers.includes(finger));
    },

    /** Lessons that train a specific movement variation. */
    forMovement(movement) {
      return all.filter((lesson) => lesson.movements.includes(movement));
    },

    /** A lesson's related lessons, resolved and de-duplicated. */
    related(id) {
      const lesson = byId.get(id);
      if (!lesson) return [];
      return [...new Set(lesson.related ?? [])]
        .filter((rid) => rid !== id && byId.has(rid))
        .map((rid) => byId.get(rid));
    },

    /** Total exercise count across the library. */
    exerciseCount() {
      return all.reduce((n, lesson) => n + lesson.exercises.length, 0);
    },

    /** Which fingers the library covers as explicit lesson targets. */
    coveredFingers() {
      const set = new Set(all.flatMap((lesson) => lesson.fingers));
      return Object.keys(FINGER_INFO).filter((finger) => set.has(finger));
    },

    /** Which movements the library covers. */
    coveredMovements() {
      const set = new Set(all.flatMap((lesson) => lesson.movements));
      return Object.keys(MOVEMENTS).filter((movement) => set.has(movement));
    },

    /** Facets for building filter UIs. */
    facets() {
      const fingerCounts = {};
      const movementCounts = {};
      const levelCounts = {};
      for (const lesson of all) {
        for (const finger of lesson.fingers) fingerCounts[finger] = (fingerCounts[finger] ?? 0) + 1;
        for (const movement of lesson.movements) movementCounts[movement] = (movementCounts[movement] ?? 0) + 1;
        levelCounts[lesson.level] = (levelCounts[lesson.level] ?? 0) + 1;
      }
      return {
        fingers: Object.keys(FINGER_INFO)
          .map((finger) => ({
            id: finger,
            label: fingerLabel(finger),
            count: fingerCounts[finger] ?? 0,
          }))
          .filter((f) => f.count > 0),
        movements: Object.values(MOVEMENTS)
          .map((movement) => ({
            id: movement.id,
            label: movementLabel(movement.id),
            kind: movement.kind,
            count: movementCounts[movement.id] ?? 0,
          }))
          .filter((m) => m.count > 0),
        categories: Object.values(CATEGORIES)
          .map((category) => ({
            id: category.id,
            label: category.label,
            count: all.filter((l) => l.category === category.id).length,
          }))
          .filter((c) => c.count > 0),
        levels: Object.keys(levelCounts)
          .map(Number)
          .sort((a, b) => a - b)
          .map((level) => ({ level, count: levelCounts[level] })),
      };
    },
  };

  return Object.freeze(api);
}
