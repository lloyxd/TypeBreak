import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideLessonComplete,
  nextLessonId,
  remainingSeconds,
  pickResumeLesson,
  REDO_WINDOW_MS,
  PROMPT_DELAY_MS,
  REDO_SECONDS,
} from '../web/core/lesson-flow.js';

describe('lesson complete timing', () => {
  test('the overlay waits two seconds, then counts five', () => {
    assert.equal(PROMPT_DELAY_MS, 2000);
    assert.equal(REDO_SECONDS, 5);
    assert.equal(REDO_WINDOW_MS, 5000);
  });
});

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
    assert.equal(remainingSeconds(0), 5);
    assert.equal(remainingSeconds(100), 5);
    assert.equal(remainingSeconds(REDO_WINDOW_MS - 1), 1);
    assert.equal(remainingSeconds(REDO_WINDOW_MS), 0);
  });
});

describe('pickResumeLesson', () => {
  const lessons = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];

  test('starts the first lesson when nothing is recorded', () => {
    const pick = pickResumeLesson(lessons, []);
    assert.equal(pick.action, 'start');
    assert.equal(pick.lesson.id, 'a');
  });

  test('continues the most recently practised unfinished lesson', () => {
    const pick = pickResumeLesson(lessons, [
      { lessonId: 'a', attempts: 2, passed: true, lastPractisedAt: '2026-01-01T00:00:00Z' },
      { lessonId: 'b', attempts: 1, passed: false, lastPractisedAt: '2026-01-02T00:00:00Z' },
    ]);
    assert.equal(pick.action, 'continue');
    assert.equal(pick.lesson.id, 'b');
  });

  test('starts the next unpassed lesson after the last one was cleared', () => {
    const pick = pickResumeLesson(lessons, [
      { lessonId: 'a', attempts: 1, passed: true, lastPractisedAt: '2026-01-03T00:00:00Z' },
    ]);
    assert.equal(pick.action, 'start');
    assert.equal(pick.lesson.id, 'b');
  });

  test('continues the last lesson when the whole library is passed', () => {
    const pick = pickResumeLesson(lessons, [
      { lessonId: 'a', attempts: 1, passed: true, lastPractisedAt: '2026-01-01T00:00:00Z' },
      { lessonId: 'b', attempts: 1, passed: true, lastPractisedAt: '2026-01-02T00:00:00Z' },
      { lessonId: 'c', attempts: 1, passed: true, lastPractisedAt: '2026-01-03T00:00:00Z' },
    ]);
    assert.equal(pick.action, 'continue');
    assert.equal(pick.lesson.id, 'c');
  });
});
