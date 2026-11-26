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
