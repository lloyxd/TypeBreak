/**
 * What happens after the last exercise of a lesson.
 *
 * The prompt lasts a fixed window: Space restarts the same lesson, and silence
 * advances to the next lesson in library order. Pure so the countdown can be
 * tested without a browser.
 */

export const REDO_SECONDS = 10;
export const REDO_WINDOW_MS = REDO_SECONDS * 1000;

export function decideLessonComplete({ spacePressed = false, elapsedMs = 0, windowMs = REDO_WINDOW_MS } = {}) {
  if (spacePressed) return 'restart';
  if (elapsedMs >= windowMs) return 'next';
  return 'wait';
}

export function nextLessonId(lessons, currentId) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const index = lessons.findIndex((lesson) => lesson.id === currentId);
  if (index < 0) return lessons[0].id;
  return lessons[(index + 1) % lessons.length].id;
}

export function remainingSeconds(elapsedMs, windowMs = REDO_WINDOW_MS) {
  return Math.max(0, Math.ceil((windowMs - elapsedMs) / 1000));
}

/**
 * Lesson the Learn page's big Start/Continue button should open.
 *
 * Fresh device (or an import with no attempts): first library lesson, Start.
 * Otherwise resume the most recently practised lesson that is not passed.
 * If that one is already passed, take the next unpassed lesson in library order.
 */
export function pickResumeLesson(lessons, progressList = []) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;

  const byId = new Map((progressList ?? []).map((row) => [row.lessonId, row]));
  const practised = (progressList ?? []).filter((row) => (row.attempts ?? 0) > 0);

  if (practised.length === 0) {
    return { lesson: lessons[0], action: 'start' };
  }

  practised.sort((a, b) => stamp(b.lastPractisedAt) - stamp(a.lastPractisedAt));
  const last = practised[0];
  const lastLesson = lessons.find((lesson) => lesson.id === last.lessonId) ?? lessons[0];

  if (!last.passed) {
    return { lesson: lastLesson, action: 'continue' };
  }

  const lastIndex = lessons.findIndex((lesson) => lesson.id === lastLesson.id);
  const rotated = [...lessons.slice(Math.max(0, lastIndex) + 1), ...lessons.slice(0, Math.max(0, lastIndex) + 1)];
  const nextOpen = rotated.find((lesson) => !byId.get(lesson.id)?.passed);
  if (!nextOpen) {
    return { lesson: lastLesson, action: 'continue' };
  }
  const started = (byId.get(nextOpen.id)?.attempts ?? 0) > 0;
  return { lesson: nextOpen, action: started ? 'continue' : 'start' };
}

function stamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}
