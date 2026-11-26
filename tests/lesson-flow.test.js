import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideLessonComplete,
  nextLessonId,
  remainingSeconds,
  REDO_WINDOW_MS,
} from '../web/core/lesson-flow.js';

describe('decideLessonComplete', () => {
  test('waits while the window is still open', () => {
    assert.equal(decideLessonComplete({ elapsedMs: 0 }), 'wait');
    assert.equal(decideLessonComplete({ elapsedMs: REDO_WINDOW_MS - 1 }), 'wait');
  });

  test('advances when the window elapses with no answer', () => {
    assert.equal(decideLessonComplete({ elapsedMs: REDO_WINDOW_MS }), 'next');
  });

  test('restarts when space is pressed, even at the last millisecond', () => {
    assert.equal(decideLessonComplete({ spacePressed: true, elapsedMs: REDO_WINDOW_MS }), 'restart');
  });
});

describe('nextLessonId', () => {
  const lessons = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  test('returns the following lesson in library order', () => {
    assert.equal(nextLessonId(lessons, 'a'), 'b');
    assert.equal(nextLessonId(lessons, 'b'), 'c');
  });

  test('wraps from the last lesson to the first', () => {
    assert.equal(nextLessonId(lessons, 'c'), 'a');
  });

  test('falls back to the first lesson when the current id is unknown', () => {
    assert.equal(nextLessonId(lessons, 'missing'), 'a');
  });

  test('returns null for an empty library', () => {
    assert.equal(nextLessonId([], 'a'), null);
  });
});

describe('remainingSeconds', () => {
  test('rounds up so the prompt never shows zero early', () => {
    assert.equal(remainingSeconds(0), 10);
    assert.equal(remainingSeconds(100), 10);
    assert.equal(remainingSeconds(REDO_WINDOW_MS - 1), 1);
    assert.equal(remainingSeconds(REDO_WINDOW_MS), 0);
  });
});
