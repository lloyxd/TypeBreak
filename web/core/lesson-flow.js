/**
 * What happens after an exercise finishes.
 *
 * The prompt is delayed so the summary can land, then a short countdown
 * advances by default. Tab restarts the same lesson; Space skips to the next.
 */

export const PROMPT_DELAY_MS = 2000;
export const REDO_SECONDS = 5;
export const REDO_WINDOW_MS = REDO_SECONDS * 1000;

export function decideLessonComplete({
  tabPressed = false,
  spacePressed = false,
  elapsedMs = 0,
  windowMs = REDO_WINDOW_MS,
} = {}) {
  if (tabPressed) return 'restart';
  if (spacePressed) return 'next-lesson';
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
