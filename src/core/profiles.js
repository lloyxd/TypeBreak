/**
 * Derived analytics.
 *
 * Raw attempts are the source of truth; everything here is a pure function of
 * the state document. Nothing is cached into storage, so rollups can be
 * recomputed after an algorithm change without migrating user data.
 *
 * All functions accept an explicit `now` date so streaks and "days since"
 * values are deterministic in tests.
 */

import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel } from './keyboard.js';
import { round, summarizeAttempts } from './engine.js';

/** Local-date key (YYYY-MM-DD), not UTC — "today" should mean the user's today. */
export function dateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a date key by whole days. */
export function shiftDateKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** Whole days between two date keys (b - a). */
export function daysBetween(aKey, bKey) {
  const toUTC = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(bKey) - toUTC(aKey)) / 86400000);
}

/**
 * Attempts grouped by date key.
 */
export function attemptsByDate(attempts) {
  const map = new Map();
  for (const attempt of attempts) {
    if (!attempt.finishedAt) continue;
    const key = dateKey(new Date(attempt.finishedAt));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(attempt);
  }
  return map;
}

/**
 * A per-finger profile built from every attempt's attributed keystrokes.
 *
 * `accuracy` here is character-level over the target text, which is a different
 * (and more honest) measure than keystroke accuracy: it says "how often does
 * this finger land correctly", not "how often did the user press anything".
 */
export function buildFingerProfiles(attempts) {
  const profiles = {};

  for (const finger of Object.keys(FINGER_INFO)) {
    profiles[finger] = {
      id: finger,
      label: fingerLabel(finger),
      hand: FINGER_INFO[finger].hand,
      correct: 0,
      wrong: 0,
      total: 0,
      accuracy: null,
      attempts: 0,
      lastPractisedAt: null,
      proficiency: 0,
      trend: 'insufficient-data',
      recentAccuracy: null,
      previousAccuracy: null,
    };
  }

  const chronological = [...attempts].sort((a, b) => new Date(a.finishedAt ?? 0) - new Date(b.finishedAt ?? 0));

  // Track a rolling window so "recent" and "previous" accuracy can be compared.
  const windows = {};
  for (const finger of Object.keys(FINGER_INFO)) windows[finger] = [];

  for (const attempt of chronological) {
    const stats = attempt.fingerStats ?? {};
    for (const [finger, stat] of Object.entries(stats)) {
      const profile = profiles[finger];
      if (!profile || !stat.total) continue;
      profile.correct += stat.correct ?? 0;
      profile.wrong += stat.wrong ?? 0;
      profile.total += stat.total ?? 0;
      profile.attempts += 1;
      profile.lastPractisedAt = attempt.finishedAt ?? profile.lastPractisedAt;
      windows[finger].push(stat.total ? (stat.correct ?? 0) / stat.total : 1);
    }
  }

  for (const finger of Object.keys(FINGER_INFO)) {
    const profile = profiles[finger];
    if (profile.total > 0) {
      profile.accuracy = round((profile.correct / profile.total) * 100);
      // Proficiency is accuracy-weighted by demonstration: a finger practised
      // only a handful of times is not "mastered" however clean those keys were.
      const evidence = Math.min(1, profile.total / 150);
      profile.proficiency = round(profile.accuracy * evidence);
    }

    const series = windows[finger];
    if (series.length >= 4) {
      const half = Math.floor(series.length / 2);
      profile.previousAccuracy = round((series.slice(0, half).reduce((a, b) => a + b, 0) / half) * 100);
      const recentSlice = series.slice(half);
      profile.recentAccuracy = round((recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length) * 100);
      const delta = profile.recentAccuracy - profile.previousAccuracy;
      profile.trend = delta > 1.5 ? 'improving' : delta < -1.5 ? 'declining' : 'stable';
    } else if (series.length > 0) {
      profile.recentAccuracy = round((series.reduce((a, b) => a + b, 0) / series.length) * 100);
    }
  }

  return profiles;
}

/** Same idea as finger profiles, for movement variations. */
export function buildMovementProfiles(attempts) {
  const profiles = {};

  for (const movement of Object.values(MOVEMENTS)) {
    profiles[movement.id] = {
      id: movement.id,
      label: movementLabel(movement.id),
      kind: movement.kind,
      description: movement.description,
      correct: 0,
      wrong: 0,
      total: 0,
      accuracy: null,
      attempts: 0,
      lastPractisedAt: null,
      proficiency: 0,
      trend: 'insufficient-data',
    };
  }

  const chronological = [...attempts].sort((a, b) => new Date(a.finishedAt ?? 0) - new Date(b.finishedAt ?? 0));
  const windows = {};
  for (const id of Object.keys(profiles)) windows[id] = [];

  for (const attempt of chronological) {
    for (const [movement, stat] of Object.entries(attempt.movementStats ?? {})) {
      const profile = profiles[movement];
      if (!profile || !stat.total) continue;
      profile.correct += stat.correct ?? 0;
      profile.wrong += stat.wrong ?? 0;
      profile.total += stat.total ?? 0;
      profile.attempts += 1;
      profile.lastPractisedAt = attempt.finishedAt ?? profile.lastPractisedAt;
      windows[movement].push(stat.total ? (stat.correct ?? 0) / stat.total : 1);
    }
  }

  for (const id of Object.keys(profiles)) {
    const profile = profiles[id];
    if (profile.total > 0) {
      profile.accuracy = round((profile.correct / profile.total) * 100);
      const evidence = Math.min(1, profile.total / 150);
      profile.proficiency = round(profile.accuracy * evidence);
    }
    const series = windows[id];
    if (series.length >= 4) {
      const half = Math.floor(series.length / 2);
      const prev = series.slice(0, half);
      const recent = series.slice(half);
      const previousAccuracy = (prev.reduce((a, b) => a + b, 0) / prev.length) * 100;
      const recentAccuracy = (recent.reduce((a, b) => a + b, 0) / recent.length) * 100;
      const delta = recentAccuracy - previousAccuracy;
      profile.trend = delta > 1.5 ? 'improving' : delta < -1.5 ? 'declining' : 'stable';
    }
  }

  return profiles;
}

/**
 * Lesson-level progress. A lesson counts as completed only when a real
 * performance bar was met — not merely when it was opened.
 */
export function buildLessonProgress(attempts, library) {
  const progress = {};

  for (const lesson of library.all()) {
    progress[lesson.id] = {
      lessonId: lesson.id,
      attempts: 0,
      completedExercises: [],
      bestAccuracy: 0,
      bestWpm: 0,
      lastAccuracy: null,
      lastWpm: null,
      lastPractisedAt: null,
      totalPracticeMs: 0,
      passed: false,
      stars: 0,
    };
  }

  const chronological = [...attempts].sort((a, b) => new Date(a.finishedAt ?? 0) - new Date(b.finishedAt ?? 0));

  for (const attempt of chronological) {
    const entry = progress[attempt.lessonId];
    if (!entry) continue;

    const lesson = library.get(attempt.lessonId);
    entry.attempts += 1;
    entry.totalPracticeMs += attempt.metrics.elapsedMs ?? 0;
    entry.lastPractisedAt = attempt.finishedAt ?? entry.lastPractisedAt;
    entry.lastAccuracy = attempt.metrics.accuracy;
    entry.lastWpm = attempt.metrics.wpm;
    entry.bestAccuracy = Math.max(entry.bestAccuracy, attempt.metrics.accuracy);
    entry.bestWpm = Math.max(entry.bestWpm, attempt.metrics.wpm);

    if (attempt.metrics.completion >= 100 && !entry.completedExercises.includes(attempt.exerciseId)) {
      entry.completedExercises.push(attempt.exerciseId);
    }

    if (lesson) {
      const criteria = lesson.criteria;
      const meetsAccuracy = attempt.metrics.accuracy >= criteria.minAccuracy;
      // WPM is advisory: a slow but clean attempt still passes.
      const meetsSpeed = criteria.speedIsAdvisory || attempt.metrics.wpm >= criteria.minWpm;
      if (meetsAccuracy && meetsSpeed && attempt.metrics.completion >= 100) entry.passed = true;
    }
  }

  for (const entry of Object.values(progress)) {
    const lesson = library.get(entry.lessonId);
    const totalExercises = lesson?.exercises.length ?? 1;
    const completionRatio = entry.completedExercises.length / totalExercises;

    // Stars reward breadth of exercises plus demonstrated accuracy, so one
    // lucky early attempt cannot max a lesson out.
    let stars = 0;
    if (entry.attempts > 0) stars = 1;
    if (completionRatio >= 1) stars = 2;
    if (completionRatio >= 1 && entry.bestAccuracy >= (lesson?.criteria.minAccuracy ?? 95)) stars = 3;
    entry.stars = stars;
    entry.completionRatio = round(completionRatio * 100);
    entry.totalExercises = totalExercises;
  }

  return progress;
}

/**
 * Learning streak: consecutive days with at least one practice attempt.
 * Today counts if practised; a streak that lapsed yesterday is still reported
 * so the user sees what they lost rather than a silent zero.
 */
export function computeStreak(attempts, now = new Date()) {
  const days = new Set(attempts.filter((a) => a.finishedAt).map((a) => dateKey(new Date(a.finishedAt))));
  if (days.size === 0) return { current: 0, best: 0, lastPractised: null, practisedToday: false };

  const today = dateKey(now);
  const practisedToday = days.has(today);

  let current = 0;
  let cursor = practisedToday ? today : shiftDateKey(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  // Best streak over all recorded days.
  const sorted = [...days].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (daysBetween(sorted[i - 1], sorted[i]) === 1) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }

  return {
    current,
    best,
    lastPractised: sorted[sorted.length - 1],
    practisedToday,
  };
}

/**
 * Daily practice history for charts: one row per day that has activity, plus
 * the trailing window the UI asks for.
 */
export function buildDailyHistory(attempts, { days = 30, now = new Date() } = {}) {
  const byDate = attemptsByDate(attempts);
  const out = [];
  const today = dateKey(now);

  for (let i = days - 1; i >= 0; i -= 1) {
    const key = shiftDateKey(today, -i);
    const dayAttempts = byDate.get(key) ?? [];
    const summary = summarizeAttempts(dayAttempts);
    out.push({
      date: key,
      attempts: dayAttempts.length,
      wpm: summary.wpm,
      accuracy: summary.accuracy,
      practiceMs: summary.practiceMs,
      errors: summary.errors,
      lessons: [...new Set(dayAttempts.map((a) => a.lessonId))].length,
    });
  }

  return out;
}

/**
 * Overall progress: a single honest number.
 *
 * Weighted by how much of the library has been genuinely passed, plus the
 * accuracy demonstrated on it. Completing lessons without accuracy cannot
 * reach 100%, which is the point of requirement 10.
 */
export function overallProgress({ library, lessonProgress, fingerProfiles }) {
  const lessons = library.all();
  const passed = lessons.filter((l) => lessonProgress[l.id]?.passed).length;
  const completionShare = lessons.length ? passed / lessons.length : 0;

  const studied = Object.values(fingerProfiles).filter((f) => f.total > 0);
  const fingerShare = Object.keys(FINGER_INFO).length
    ? studied.reduce((sum, f) => sum + (f.accuracy ?? 0) / 100, 0) / Object.keys(FINGER_INFO).length
    : 0;

  // Completion is the gate; finger accuracy decides how much of that gate is
  // actually worth anything.
  const score = completionShare * 0.6 + fingerShare * 0.4;

  return {
    percent: round(score * 100),
    lessonsPassed: passed,
    lessonsTotal: lessons.length,
    fingerShare: round(fingerShare * 100),
  };
}

/**
 * Everything a dashboard needs, derived in one pass.
 */
export function buildSnapshot({ state, library, now = new Date() }) {
  const attempts = state.attempts ?? [];
  const fingerProfiles = buildFingerProfiles(attempts);
  const movementProfiles = buildMovementProfiles(attempts);
  const lessonProgress = buildLessonProgress(attempts, library);
  const streak = computeStreak(attempts, now);
  const history = buildDailyHistory(attempts, { days: 30, now });
  const totals = summarizeAttempts(attempts);

  const today = dateKey(now);
  const todayAttempts = attempts.filter((a) => a.finishedAt && dateKey(new Date(a.finishedAt)) === today);

  return {
    generatedAt: now.toISOString(),
    today,
    attempts,
    totals,
    todaySummary: summarizeAttempts(todayAttempts),
    todayAttempts,
    fingerProfiles,
    movementProfiles,
    lessonProgress,
    streak,
    history,
    overall: overallProgress({ library, lessonProgress, fingerProfiles }),
    settings: state.profile?.settings ?? {},
    // Persisted plans/tasks/assessments are passed through so the planner can
    // reuse today's plan instead of reshuffling it mid-session.
    plans: state.plans ?? {},
    tasks: state.tasks ?? {},
    assessments: state.assessments ?? {},
  };
}

/** Total practice time in ms. */
export function totalPracticeMs(attempts) {
  return attempts.reduce((sum, a) => sum + (a.metrics?.elapsedMs ?? 0), 0);
}
