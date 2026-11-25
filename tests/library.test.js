/**
 * Library tests.
 *
 * These assert the structural guarantees the rest of the system depends on:
 * a fixed, complete, self-consistent lesson library that covers all ten fingers
 * and every movement variation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadLibrary, validateLibrary, LibraryError } from '../src/core/library.js';
import { FINGERS, FINGER_INFO, MOVEMENTS, describeChar } from '../src/core/keyboard.js';
import { buildFixtureLibrary, loadRealLibrary } from './fixtures.js';

describe('library validation', () => {
  test('accepts the real generated library', async () => {
    const library = await loadRealLibrary();
    assert.ok(library.size > 0);
  });

  test('rejects a document with no lessons', () => {
    assert.throws(() => loadLibrary({ lessons: [] }), LibraryError);
    assert.throws(() => loadLibrary({}), LibraryError);
    assert.throws(() => loadLibrary(null), LibraryError);
  });

  test('rejects duplicate lesson ids', () => {
    const doc = {
      lessons: [
        { id: 'X', name: 'a', fingers: ['LINDEX'], movements: ['home'], level: 1, exercises: [{ id: 'E1', text: 'ff' }] },
        { id: 'X', name: 'b', fingers: ['LINDEX'], movements: ['home'], level: 1, exercises: [{ id: 'E2', text: 'ff' }] },
      ],
    };
    assert.throws(() => validateLibrary(doc), /Duplicate lesson id/);
  });

  test('rejects a lesson with no exercises', () => {
    const doc = {
      lessons: [{ id: 'X', name: 'a', fingers: ['LINDEX'], movements: ['home'], level: 1, exercises: [] }],
    };
    assert.throws(() => validateLibrary(doc), /no exercises/);
  });

  test('rejects an out-of-range level', () => {
    const doc = {
      lessons: [{ id: 'X', name: 'a', fingers: ['LINDEX'], movements: ['home'], level: 99, exercises: [{ id: 'E', text: 'ff' }] }],
    };
    assert.throws(() => validateLibrary(doc), /invalid level/);
  });

  test('rejects a dangling related-lesson reference', () => {
    const doc = {
      lessons: [
        { id: 'X', name: 'a', fingers: ['LINDEX'], movements: ['home'], level: 1, exercises: [{ id: 'E', text: 'ff' }], related: ['NOPE'] },
      ],
    };
    assert.throws(() => validateLibrary(doc), /missing related lesson/);
  });

  test('the library is frozen against mutation', () => {
    const library = buildFixtureLibrary();
    const lesson = library.get('T-INDEX-HOME');
    assert.throws(() => {
      'use strict';
      lesson.name = 'hacked';
    });
  });
});

describe('real library completeness', () => {
  let library;

  test('loads', async () => {
    library = await loadRealLibrary();
    assert.ok(library.size >= 40, `expected a substantial library, got ${library.size}`);
  });

  test('covers all ten fingers as explicit lesson targets', async () => {
    library ??= await loadRealLibrary();
    const covered = new Set(library.coveredFingers());
    for (const finger of FINGERS) {
      assert.ok(covered.has(finger), `no lesson targets ${FINGER_INFO[finger].label}`);
    }
  });

  test('covers every movement variation', async () => {
    library ??= await loadRealLibrary();
    const covered = new Set(library.coveredMovements());
    for (const movement of Object.keys(MOVEMENTS)) {
      assert.ok(covered.has(movement), `no lesson trains the ${movement} movement`);
    }
  });

  test('every exercise uses only mappable characters', async () => {
    library ??= await loadRealLibrary();
    for (const lesson of library.all()) {
      for (const exercise of lesson.exercises) {
        for (const ch of exercise.text) {
          const info = describeChar(ch);
          assert.ok(info.mapped, `${lesson.id}/${exercise.id} contains unmappable character ${JSON.stringify(ch)}`);
        }
      }
    }
  });

  test('lesson ids and exercise ids are globally unique', async () => {
    library ??= await loadRealLibrary();
    const lessonIds = new Set();
    const exerciseIds = new Set();
    for (const lesson of library.all()) {
      assert.ok(!lessonIds.has(lesson.id), `duplicate lesson id ${lesson.id}`);
      lessonIds.add(lesson.id);
      for (const exercise of lesson.exercises) {
        assert.ok(!exerciseIds.has(exercise.id), `duplicate exercise id ${exercise.id}`);
        exerciseIds.add(exercise.id);
      }
    }
  });

  test('every lesson has the full metadata the planner needs', async () => {
    library ??= await loadRealLibrary();
    for (const lesson of library.all()) {
      assert.ok(lesson.name, `${lesson.id} name`);
      assert.ok(lesson.description, `${lesson.id} description`);
      assert.ok(lesson.outcome, `${lesson.id} outcome`);
      assert.ok(lesson.fingers.length, `${lesson.id} fingers`);
      assert.ok(lesson.movements.length, `${lesson.id} movements`);
      assert.ok(lesson.criteria, `${lesson.id} criteria`);
      assert.equal(typeof lesson.criteria.minAccuracy, 'number', `${lesson.id} minAccuracy`);
      assert.ok(lesson.level >= 1 && lesson.level <= 10, `${lesson.id} level`);
      assert.ok(lesson.estimatedSeconds > 0, `${lesson.id} duration`);
    }
  });

  test('levels start easy and the library contains a beginner entry point', async () => {
    library ??= await loadRealLibrary();
    const levels = library.all().map((l) => l.level);
    assert.equal(Math.min(...levels), 1, 'the library should start at level 1');
    assert.ok(Math.max(...levels) >= 7, 'the library should reach advanced material');
  });

  test('filtering by finger only returns lessons targeting that finger', async () => {
    library ??= await loadRealLibrary();
    for (const finger of FINGERS) {
      const lessons = library.filter({ finger });
      assert.ok(lessons.length > 0, `filter returned nothing for ${finger}`);
      for (const lesson of lessons) {
        assert.ok(lesson.fingers.includes(finger), `${lesson.id} does not target ${finger}`);
      }
    }
  });

  test('filtering by movement only returns lessons training that movement', async () => {
    library ??= await loadRealLibrary();
    for (const movement of Object.keys(MOVEMENTS)) {
      const lessons = library.filter({ movement });
      for (const lesson of lessons) {
        assert.ok(lesson.movements.includes(movement), `${lesson.id} does not train ${movement}`);
      }
    }
  });

  test('related lessons resolve and never self-reference', async () => {
    library ??= await loadRealLibrary();
    for (const lesson of library.all()) {
      for (const related of lesson.related) {
        assert.notEqual(related, lesson.id, `${lesson.id} relates to itself`);
        assert.ok(library.has(related), `${lesson.id} relates to unknown ${related}`);
      }
    }
  });

  test('facet counts sum to the lesson count', async () => {
    library ??= await loadRealLibrary();
    const facets = library.facets();
    const categoryTotal = facets.categories.reduce((n, c) => n + c.count, 0);
    assert.equal(categoryTotal, library.size, 'every lesson must belong to exactly one category');
  });
});

describe('library queries', () => {
  test('get returns null for an unknown id and throws on require', () => {
    const library = buildFixtureLibrary();
    assert.equal(library.get('NOPE'), null);
    assert.throws(() => library.require('NOPE'), LibraryError);
  });

  test('exercise lookup resolves to its owning lesson', () => {
    const library = buildFixtureLibrary();
    const { lesson, exercise } = library.exercise('T-INDEX-HOME-E2');
    assert.equal(lesson.id, 'T-INDEX-HOME');
    assert.equal(exercise.id, 'T-INDEX-HOME-E2');
  });

  test('unknown exercise lookup throws', () => {
    const library = buildFixtureLibrary();
    assert.throws(() => library.exercise('NOPE'), LibraryError);
  });

  test('search matches name and description', () => {
    const library = buildFixtureLibrary();
    assert.ok(library.filter({ search: 'Ring' }).length >= 2);
    assert.equal(library.filter({ search: 'zzzzz' }).length, 0);
  });

  test('filters combine with AND semantics', () => {
    const library = buildFixtureLibrary();
    // T-RING-UP is the only lesson that is both LRING and *exclusively* level 4.
    const lessons = library.filter({ finger: 'LRING', movement: 'up', difficulty: 4 });
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].id, 'T-RING-UP');
    // Without the level filter, the combination lesson also matches.
    assert.equal(library.filter({ finger: 'LRING', movement: 'up' }).length, 2);
  });

  test('byLevel sorts ascending by level', () => {
    const library = buildFixtureLibrary();
    const levels = library.byLevel().map((l) => l.level);
    const sorted = [...levels].sort((a, b) => a - b);
    assert.deepEqual(levels, sorted);
  });

  test('exerciseCount counts every exercise', () => {
    const library = buildFixtureLibrary();
    const manual = library.all().reduce((n, l) => n + l.exercises.length, 0);
    assert.equal(library.exerciseCount(), manual);
  });
});
