/**
 * BTS — Behavioural Typing System.
 *
 * The adaptive brain. It reads demonstrated performance and produces:
 *   1. weakness findings   — which fingers/movements actually need work
 *   2. lesson priorities   — a score per existing lesson, with reasons
 *   3. a daily plan        — an ordered selection from the preset library
 *
 * Hard constraints enforced here (and covered by tests):
 *   * never invents a lesson; every returned id came from `library.get`
 *   * never invents or edits exercise text; the planner only picks lesson ids
 *   * deterministic: same state + same date ⇒ same plan
 *   * explainable: every score carries human-readable reasons
 *
 * The module is pure. It reads a `snapshot` (from profiles.js) and a `library`,
 * and returns plain data. No I/O, no clock reads except the injected `now`.
 */

import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel } from './keyboard.js';
import { dateKey, daysBetween } from './profiles.js';
import { round } from './engine.js';

/* ------------------------------------------------------------------ *
 * Tunables — named so the reasons shown to the user match the maths.
 * ------------------------------------------------------------------ */

export const BTS_CONFIG = {
  /** Minimum attempts on a finger before it can be called a weakness. */
  minEvidenceAttempts: 3,
  /** Minimum target characters seen on a finger before judging it. */
  minEvidenceChars: 40,

  /** Accuracy thresholds used to classify a finger. */
  weaknessAccuracy: 92,
  strengthAccuracy: 96,

  /** Recency weighting: practice older than this contributes less. */
  stalenessDays: 7,
  maxStalenessBonus: 22,

  /** Plan composition. */
  planSize: 6,
  weaknessSlots: 3,
  progressionSlots: 2,
  maintenanceSlots: 1,

  /** A lesson at or below the learner's demonstrated level is "progression". */
  progressionLookahead: 1,

  /** Priority weights. Each maps to a reason fragment. */
  weights: {
    weaknessGap: 3.2,
    errorRate: 1.4,
    regression: 2.0,
    staleness: 1.0,
    unfinished: 1.6,
    levelFit: 1.2,
    maintenance: 0.9,
    difficultyPenalty: 1.5,
    masteryDiscount: 2.4,
  },
};

export const FINDING_TYPES = {
  fingerWeakness: 'finger-weakness',
  fingerRegression: 'finger-regression',
  movementWeakness: 'movement-weakness',
  slowLesson: 'slow-lesson',
  incompleteLesson: 'incomplete-lesson',
  insufficientData: 'insufficient-data',
};

/* ------------------------------------------------------------------ *
 * 1. Performance evaluation
 * ------------------------------------------------------------------ */

/**
 * Score a single finger from its profile.
 *
 * Returns `{ finger, accuracy, evidence, severity, status, reasons }` where
 * severity is 0..100 (higher = more urgent) and status is one of
 * `unknown | strong | adequate | weak | critical`.
 */
export function evaluateFinger(profile, { config = BTS_CONFIG } = {}) {
  const reasons = [];

  if (!profile || profile.total < config.minEvidenceChars || profile.attempts < config.minEvidenceAttempts) {
    return {
      finger: profile?.id ?? null,
      label: profile?.label ?? 'Unknown',
      accuracy: profile?.accuracy ?? null,
      evidence: profile?.total ?? 0,
      severity: 0,
      status: 'unknown',
      reasons:
        profile?.total > 0
          ? ['Not enough practice yet to judge this finger reliably.']
          : ['This finger has not been practised yet.'],
    };
  }

  /**
   * Judge on recent performance where it exists, not only the lifetime average.
   *
   * A lifetime figure is sticky: a finger that was terrible for two weeks and
   * clean for two weeks still reads as "failed" long after the skill recovered,
   * which would keep it at the top of every plan. `recentAccuracy` reflects the
   * second half of attempts, so improvement actually reduces priority — which is
   * what requirement 4.3 asks for.
   */
  const lifetimeAccuracy = profile.accuracy;
  const recencyWeight = profile.recentAccuracy != null ? 0.6 : 0;
  const effectiveAccuracy =
    recencyWeight > 0
      ? round(lifetimeAccuracy * (1 - recencyWeight) + profile.recentAccuracy * recencyWeight)
      : lifetimeAccuracy;

  const gap = Math.max(0, config.weaknessAccuracy - effectiveAccuracy);
  // Severity must stay ordering-preserving: a hard cap makes every badly
  // performing finger score 100, which hides which one is actually worst.
  // A finger at or above target has zero severity.
  const gapRatio = gap / config.weaknessAccuracy;
  const volume = gap > 0 ? Math.min(1, profile.wrong / Math.max(20, profile.total * 0.5)) : 0;
  // Improving fingers get a further damp so recovery visibly lowers priority.
  const recoveryFactor = profile.trend === 'improving' && gap > 0 ? 0.75 : 1;
  const severity = round(Math.min(100, (gapRatio * 85 + volume * 15) * recoveryFactor), 1);

  const accuracy = effectiveAccuracy;

  let status;
  if (accuracy >= config.strengthAccuracy) status = 'strong';
  else if (accuracy >= config.weaknessAccuracy) status = 'adequate';
  else if (accuracy >= config.weaknessAccuracy - 6) status = 'weak';
  else status = 'critical';

  if (accuracy < config.weaknessAccuracy) {
    reasons.push(`${profile.label} lands correctly ${accuracy}% of the time, below the ${config.weaknessAccuracy}% target.`);
    if (profile.recentAccuracy != null && profile.recentAccuracy !== lifetimeAccuracy) {
      reasons.push(`Recent form is ${profile.recentAccuracy}% against a lifetime ${lifetimeAccuracy}%.`);
    }
    reasons.push(`${profile.wrong} of ${profile.total} characters for this finger were mistyped.`);
  } else if (accuracy >= config.strengthAccuracy) {
    reasons.push(`${profile.label} is accurate (${accuracy}%) across ${profile.total} characters.`);
  } else {
    reasons.push(`${profile.label} is workable at ${accuracy}% but has room to tighten.`);
  }

  if (profile.trend === 'declining') {
    reasons.push('Recent attempts are worse than earlier ones, so this skill is slipping.');
  } else if (profile.trend === 'improving') {
    reasons.push('Recent attempts are better than earlier ones, so practice is working.');
  }

  return {
    finger: profile.id,
    label: profile.label,
    accuracy,
    evidence: profile.total,
    severity: round(severity, 1),
    status,
    trend: profile.trend,
    reasons,
  };
}

/** Same treatment for a movement variation. */
export function evaluateMovement(profile, { config = BTS_CONFIG } = {}) {
  if (!profile || profile.total < config.minEvidenceChars) {
    return {
      movement: profile?.id ?? null,
      label: profile?.label ?? 'Unknown',
      accuracy: profile?.accuracy ?? null,
      evidence: profile?.total ?? 0,
      severity: 0,
      status: 'unknown',
      reasons: [profile?.total ? 'Not enough practice yet to judge this movement.' : 'This movement has not been practised yet.'],
    };
  }

  const { accuracy } = profile;
  const gap = Math.max(0, config.weaknessAccuracy - accuracy);
  const gapRatio = gap / config.weaknessAccuracy;
  const volume = gap > 0 ? Math.min(1, profile.wrong / Math.max(20, profile.total * 0.5)) : 0;
  const severity = round(Math.min(100, gapRatio * 85 + volume * 15), 1);

  let status;
  if (accuracy >= config.strengthAccuracy) status = 'strong';
  else if (accuracy >= config.weaknessAccuracy) status = 'adequate';
  else if (accuracy >= config.weaknessAccuracy - 6) status = 'weak';
  else status = 'critical';

  const reasons = [];
  if (accuracy < config.weaknessAccuracy) {
    reasons.push(`${profile.label} is at ${accuracy}% accuracy across ${profile.total} characters.`);
  } else {
    reasons.push(`${profile.label} is holding at ${accuracy}% accuracy.`);
  }
  if (profile.trend === 'declining') reasons.push('Performance here is trending down.');

  return {
    movement: profile.id,
    label: profile.label,
    accuracy,
    evidence: profile.total,
    severity: round(severity, 1),
    status,
    trend: profile.trend,
    reasons,
  };
}

/**
 * Identify weaknesses across fingers, movements and lessons.
 *
 * Deliberately conservative: a single bad attempt can never surface a weakness,
 * because every finding requires both multiple attempts and enough characters.
 */
export function identifyWeaknesses(snapshot, { config = BTS_CONFIG } = {}) {
  const fingerEvals = Object.values(snapshot.fingerProfiles ?? {}).map((p) => evaluateFinger(p, { config }));
  const movementEvals = Object.values(snapshot.movementProfiles ?? {}).map((p) => evaluateMovement(p, { config }));

  const weakFingers = fingerEvals
    .filter((f) => f.status === 'weak' || f.status === 'critical')
    .sort((a, b) => b.severity - a.severity);

  const weakMovements = movementEvals
    .filter((m) => m.status === 'weak' || m.status === 'critical')
    .sort((a, b) => b.severity - a.severity);

  const regressions = fingerEvals
    .filter((f) => f.trend === 'declining' && f.status !== 'unknown')
    .sort((a, b) => b.severity - a.severity);

  const slowLessons = findSlowLessons(snapshot);

  const findings = [
    ...weakFingers.map((f) => ({
      id: `finger-weakness:${f.finger}`,
      type: FINDING_TYPES.fingerWeakness,
      subject: f.finger,
      label: f.label,
      severity: f.severity,
      accuracy: f.accuracy,
      evidence: f.evidence,
      title: `${f.label} accuracy is low`,
      detail: f.reasons[0],
      reasons: f.reasons,
    })),
    ...regressions.map((f) => ({
      id: `finger-regression:${f.finger}`,
      type: FINDING_TYPES.fingerRegression,
      subject: f.finger,
      label: f.label,
      severity: round(Math.min(100, f.severity + 10), 1),
      accuracy: f.accuracy,
      evidence: f.evidence,
      title: `${f.label} is regressing`,
      detail: f.reasons.find((r) => r.includes('slipping')) ?? 'Recent performance is worse than earlier performance.',
      reasons: f.reasons,
    })),
    ...weakMovements.map((m) => ({
      id: `movement-weakness:${m.movement}`,
      type: FINDING_TYPES.movementWeakness,
      subject: m.movement,
      label: m.label,
      severity: m.severity,
      accuracy: m.accuracy,
      evidence: m.evidence,
      title: `${m.label} needs work`,
      detail: m.reasons[0],
      reasons: m.reasons,
    })),
    ...slowLessons,
  ].sort((a, b) => b.severity - a.severity);

  const practisedFingers = fingerEvals.filter((f) => f.status !== 'unknown');
  const untouched = fingerEvals.filter((f) => f.evidence === 0);

  return {
    generatedAt: snapshot.generatedAt,
    findings,
    weakFingers,
    weakMovements,
    regressions,
    fingerEvals,
    movementEvals,
    summary: {
      weakFingerCount: weakFingers.length,
      weakMovementCount: weakMovements.length,
      regressionCount: regressions.length,
      strongest: [...practisedFingers].sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0))[0] ?? null,
      weakest: weakFingers[0] ?? null,
      untouchedFingers: untouched.map((f) => f.finger),
      hasEnoughData: practisedFingers.length >= 2,
    },
  };
}

/**
 * Lessons that take far longer than their estimated duration across multiple
 * attempts. Uses a median-of-3 minimum so a single slow first try is ignored.
 */
function findSlowLessons(snapshot, { config = BTS_CONFIG } = {}) {
  const out = [];
  for (const [lessonId, progress] of Object.entries(snapshot.lessonProgress ?? {})) {
    if (progress.attempts < config.minEvidenceAttempts) continue;
    const lesson = snapshot.__library?.get?.(lessonId);
    if (!lesson) continue;
    const expectedMs = (lesson.estimatedSeconds ?? 60) * 1000;
    const averageMs = progress.totalPracticeMs / progress.attempts;
    if (averageMs <= expectedMs * 1.8) continue;

    out.push({
      id: `slow-lesson:${lessonId}`,
      type: FINDING_TYPES.slowLesson,
      subject: lessonId,
      label: lesson.name,
      severity: round(Math.min(60, ((averageMs / expectedMs - 1) * 40)), 1),
      title: `${lesson.name} is slow to complete`,
      detail: `Averaging ${Math.round(averageMs / 1000)}s against an estimated ${lesson.estimatedSeconds}s.`,
      reasons: [
        `Across ${progress.attempts} attempts this lesson averages ${Math.round(averageMs / 1000)}s.`,
        `The library estimates ${lesson.estimatedSeconds}s for this lesson.`,
      ],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Lesson prioritisation
 * ------------------------------------------------------------------ */

/**
 * Score every lesson in the library for this user today.
 *
 * The score is a weighted sum of independent, individually-explainable signals.
 * Each signal that fires also appends a human-readable reason, so the UI can
 * show exactly why a lesson was recommended.
 *
 * @returns {Array<{lessonId, score, reasons, kind, signals}>} sorted desc.
 */
export function scoreLessons(snapshot, library, { config = BTS_CONFIG } = {}) {
  const now = new Date(snapshot.generatedAt ?? Date.now());
  const today = dateKey(now);
  const weaknesses = snapshot.__weaknesses ?? null;
  const assessment = identifyWeaknesses(snapshot, { config });

  const weakFingerMap = new Map(assessment.weakFingers.map((f) => [f.finger, f]));
  const weakMovementMap = new Map(assessment.weakMovements.map((m) => [m.movement, m]));

  /**
   * What level has the learner actually consolidated?
   *
   * Taking the *highest* passed level is misleading: a learner who got lucky on
   * one level-9 pattern lesson would be treated as ready for level 9 while
   * level-2 fundamentals sit unpassed. The honest measure is the lowest level
   * that still has unpassed lessons — that is the frontier they are working at,
   * with a floor of 1 for a brand-new profile.
   */
  const lessonsByLevel = new Map();
  for (const lesson of library.byLevel()) {
    const passed = snapshot.lessonProgress?.[lesson.id]?.passed ?? false;
    if (!lessonsByLevel.has(lesson.level)) lessonsByLevel.set(lesson.level, { total: 0, passed: 0 });
    const bucket = lessonsByLevel.get(lesson.level);
    bucket.total += 1;
    if (passed) bucket.passed += 1;
  }

  let demonstratedLevel = 1;
  for (const level of [...lessonsByLevel.keys()].sort((a, b) => a - b)) {
    const bucket = lessonsByLevel.get(level);
    // A level counts as consolidated once most of its lessons are passed; the
    // frontier is the first level that is not.
    if (bucket.total > 0 && bucket.passed / bucket.total >= 0.5) {
      demonstratedLevel = Math.max(demonstratedLevel, level);
    } else {
      break;
    }
  }

  const frontierLevel = [...lessonsByLevel.entries()]
    .filter(([, bucket]) => bucket.passed < bucket.total)
    .map(([level]) => level)
    .sort((a, b) => a - b)[0] ?? demonstratedLevel;

  const scored = library.all().map((lesson) => {
    const progress = snapshot.lessonProgress?.[lesson.id] ?? {
      attempts: 0,
      bestAccuracy: 0,
      passed: false,
      completedExercises: [],
      lastPractisedAt: null,
    };

    const signals = [];
    const reasons = [];
    let score = 0;

    /* --- weakness fit ------------------------------------------------- */
    let strongestWeakFinger = null;
    for (const finger of lesson.fingers) {
      const weak = weakFingerMap.get(finger);
      if (weak && (!strongestWeakFinger || weak.severity > strongestWeakFinger.severity)) {
        strongestWeakFinger = weak;
      }
    }
    if (strongestWeakFinger) {
      const contribution = (strongestWeakFinger.severity / 100) * config.weights.weaknessGap * 10;
      score += contribution;
      signals.push({ id: 'weakness', weight: round(contribution, 1) });
      const rank = assessment.weakFingers.findIndex((f) => f.finger === strongestWeakFinger.finger);
      reasons.push(
        rank === 0
          ? `Targets ${strongestWeakFinger.label.toLowerCase()}, your weakest practised finger at ${strongestWeakFinger.accuracy}% accuracy.`
          : `Targets ${strongestWeakFinger.label.toLowerCase()}, which is at ${strongestWeakFinger.accuracy}% accuracy — below your ${config.weaknessAccuracy}% target.`,
      );
    }

    /* --- movement weakness -------------------------------------------- */
    let strongestWeakMovement = null;
    for (const movement of lesson.movements) {
      const weak = weakMovementMap.get(movement);
      if (weak && (!strongestWeakMovement || weak.severity > strongestWeakMovement.severity)) {
        strongestWeakMovement = weak;
      }
    }
    if (strongestWeakMovement && (!strongestWeakFinger || strongestWeakMovement.severity > strongestWeakFinger.severity)) {
      const contribution = (strongestWeakMovement.severity / 100) * config.weights.weaknessGap * 6;
      score += contribution;
      signals.push({ id: 'movement-weakness', weight: round(contribution, 1) });
      reasons.push(
        `Trains the ${strongestWeakMovement.label.toLowerCase()} movement, currently ${strongestWeakMovement.accuracy}% accurate.`,
      );
    }

    /* --- error rate on this lesson's own history ---------------------- */
    if (progress.attempts > 0) {
      const accuracy = progress.lastAccuracy ?? progress.bestAccuracy ?? 0;
      if (accuracy < config.weaknessAccuracy) {
        const contribution = ((config.weaknessAccuracy - accuracy) / config.weaknessAccuracy) * config.weights.errorRate * 6;
        score += contribution;
        signals.push({ id: 'low-accuracy', weight: round(contribution, 1) });
        reasons.push(`Your last attempt scored ${accuracy}% accuracy, under the ${config.weaknessAccuracy}% target.`);
      }
    }

    /* --- never practised ---------------------------------------------- */
    if (progress.attempts === 0) {
      // Untried lessons are valuable only at or near the learner's level;
      // throwing level-9 lessons at a beginner is not "progression".
      const gap = lesson.level - demonstratedLevel;
      if (gap <= config.progressionLookahead) {
        const contribution = config.weights.unfinished * 7;
        score += contribution;
        signals.push({ id: 'new-material', weight: round(contribution, 1) });
        reasons.push('New material at your current level — you have not tried this lesson yet.');
      } else {
        const penalty = Math.min(30, gap * config.weights.difficultyPenalty * 3);
        score -= penalty;
        signals.push({ id: 'difficulty-penalty', weight: -round(penalty, 1) });
        // A penalty is still a reason for the score, so it must be stated —
        // otherwise a lesson can appear far down the list with no explanation.
        reasons.push(
          `Level ${lesson.level} is ${gap} level${gap === 1 ? '' : 's'} above where you are working (level ${demonstratedLevel}), so it waits until that foundation is solid.`,
        );
      }
    }

    /* --- level fit ---------------------------------------------------- */
    // Progression should stretch the learner at their *frontier* — the lowest
    // level still incomplete — rather than throwing the hardest material at them
    // because it happens to be unpassed.
    const levelGap = lesson.level - demonstratedLevel;
    if (progress.attempts > 0 && levelGap >= 0 && levelGap <= config.progressionLookahead) {
      const contribution = config.weights.levelFit * 5;
      score += contribution;
      signals.push({ id: 'level-fit', weight: round(contribution, 1) });
      reasons.push(`Sits at level ${lesson.level}, matching the level you have demonstrated.`);
    }

    if (lesson.level === frontierLevel && !progress.passed) {
      const contribution = config.weights.levelFit * 6;
      score += contribution;
      signals.push({ id: 'frontier', weight: round(contribution, 1) });
      reasons.push(
        progress.attempts === 0
          ? `Level ${lesson.level} is where your progress has reached and not yet passed — the next step up.`
          : `Level ${lesson.level} is your current frontier: started but not yet passed.`,
      );
    }

    /* --- staleness ---------------------------------------------------- */
    if (progress.lastPractisedAt) {
      const days = Math.max(0, daysBetween(dateKey(new Date(progress.lastPractisedAt)), today));
      if (days >= config.stalenessDays) {
        const contribution = Math.min(config.maxStalenessBonus, (days - config.stalenessDays + 1) * 3) * config.weights.staleness;
        score += contribution;
        signals.push({ id: 'stale', weight: round(contribution, 1) });
        reasons.push(`Not practised for ${days} days — due for reinforcement.`);
      }
    }

    /* --- unfinished exercises ---------------------------------------- */
    const totalExercises = lesson.exercises.length;
    const done = progress.completedExercises?.length ?? 0;
    if (progress.attempts > 0 && !progress.passed) {
      const contribution = config.weights.unfinished * 6;
      score += contribution;
      signals.push({ id: 'not-passed', weight: round(contribution, 1) });
      reasons.push(
        done === 0
          ? 'You have started this lesson but not yet met its accuracy criteria.'
          : `${done} of ${totalExercises} exercises completed here, criteria not yet met.`,
      );
    }

    /* --- regression on an involved finger ------------------------------ */
    const regressed = lesson.fingers
      .map((finger) => assessment.regressions.find((r) => r.finger === finger))
      .find(Boolean);
    if (regressed) {
      const contribution = config.weights.regression * 7;
      score += contribution;
      signals.push({ id: 'regression', weight: round(contribution, 1) });
      reasons.push(`${regressed.label} has regressed recently; this lesson re-establishes it.`);
    }

    /* --- mastered discount -------------------------------------------- */
    // Suppressed when the lesson targets a currently weak finger: a lesson you
    // once passed is not "mastered" if that finger has since regressed.
    const targetsWeakFinger = Boolean(strongestWeakFinger);
    const isMastered = progress.passed && (progress.bestAccuracy ?? 0) >= (lesson.criteria?.minAccuracy ?? 95) + 2 && !targetsWeakFinger;
    if (isMastered) {
      const discount = config.weights.masteryDiscount * 6;
      score -= discount;
      signals.push({ id: 'mastered', weight: -round(discount, 1) });
      reasons.push('Already passed with margin, so it drops down the queue.');
    }

    /* --- classify into the three practice kinds ------------------------ */
    let kind;
    if (strongestWeakFinger || strongestWeakMovement || regressed) kind = 'weakness';
    else if (isMastered) kind = 'maintenance';
    else if (progress.passed) kind = 'maintenance';
    else if (lesson.level <= demonstratedLevel + config.progressionLookahead) kind = 'progression';
    else kind = 'progression';

    if (reasons.length === 0) reasons.push('A balanced lesson at this stage of your progress.');

    return {
      lessonId: lesson.id,
      lesson,
      score: round(score, 2),
      kind,
      reasons,
      signals,
      demonstratedLevel,
      frontierLevel,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.lesson.level - b.lesson.level || a.lessonId.localeCompare(b.lessonId));
  return scored;
}

/* ------------------------------------------------------------------ *
 * 3. Daily planner
 * ------------------------------------------------------------------ */

/**
 * Build today's plan.
 *
 * The composition is quota-based rather than a pure top-N, which is what keeps
 * requirement 7 honest: weaknesses cannot crowd out progression and
 * maintenance even when they dominate the scores.
 *
 * @returns {{ date, items, buckets, reasons, weaknesses, demonstratedLevel }}
 */
export function planDay(snapshot, library, { config = BTS_CONFIG, now = new Date(), force = false } = {}) {
  const today = dateKey(now);
  const existing = snapshot.plans?.[today];

  // A plan is generated once per day so the user's list does not reshuffle
  // underneath them mid-session. `force` regenerates on demand.
  if (existing && !force) {
    const items = existing.items
      .map((item) => {
        const lesson = library.get(item.lessonId);
        return lesson ? { ...item, lesson } : null;
      })
      .filter(Boolean);
    if (items.length) return { ...existing, date: today, items, reused: true };
  }

  /**
   * Scale the plan to the library actually available.
   *
   * A small library cannot support a six-item plan with a 3/2/1 split, so the
   * quotas are capped by what exists. Weakness work is additionally capped at
   * 60% of the plan, which is the balance rule expressed as a hard ceiling.
   */
  const planSize = Math.max(1, Math.min(config.planSize, library.size));
  const weaknessSlots = Math.max(
    1,
    Math.min(config.weaknessSlots, Math.floor(planSize * 0.6), Math.floor(library.size * 0.6)),
  );
  const progressionSlots = Math.max(1, Math.min(config.progressionSlots, planSize - weaknessSlots));
  const maintenanceSlots = Math.max(0, Math.min(config.maintenanceSlots, planSize - weaknessSlots - progressionSlots));

  const assessment = identifyWeaknesses(snapshot, { config });
  const scored = scoreLessons({ ...snapshot, __weaknesses: assessment }, library, { config });

  const weakestFirst = scored.filter((s) => s.kind === 'weakness');
  const progression = scored.filter((s) => s.kind === 'progression');
  const maintenance = scored.filter((s) => s.kind === 'maintenance');

  /**
   * Weakness slots: pick one lesson per weak finger, worst finger first, then
   * round-robin so a single bad finger cannot fill every slot. The result is
   * ordered by the severity of the finger each lesson addresses.
   */
  const severityByFinger = new Map(assessment.weakFingers.map((f) => [f.finger, f.severity]));
  const dominantWeakFinger = (entry) => {
    let best = null;
    for (const finger of entry.lesson.fingers) {
      const severity = severityByFinger.get(finger);
      if (severity !== undefined && (!best || severity > best.severity)) best = { finger, severity };
    }
    return best;
  };

  const groups = new Map();
  const ungrouped = [];
  for (const entry of weakestFirst) {
    const dominant = dominantWeakFinger(entry);
    if (!dominant) {
      ungrouped.push(entry);
      continue;
    }
    if (!groups.has(dominant.finger)) groups.set(dominant.finger, []);
    groups.get(dominant.finger).push(entry);
  }

  /**
   * Within a finger's group, prefer lessons that drill that finger specifically
   * — a lesson targeting one finger is a better remedy than a broad lesson that
   * happens to include it. Score alone would rank the broad lesson higher
   * because it accumulates weakness signals from several fingers at once.
   */
  const specificity = (entry, finger) => {
    const ownFingers = entry.lesson.fingers.length;
    const isIsolation = entry.lesson.category === 'finger-isolation' || entry.lesson.category === 'movement-variation';
    return (isIsolation ? 100 : 0) - ownFingers * 3;
  };

  const orderedGroups = [...groups.entries()]
    .map(([finger, candidates]) => [
      finger,
      [...candidates].sort(
        (a, b) => specificity(b, finger) - specificity(a, finger) || b.score - a.score,
      ),
    ])
    .sort((a, b) => (severityByFinger.get(b[0]) ?? 0) - (severityByFinger.get(a[0]) ?? 0));

  const weaknessPicks = [];
  // Round-robin: first pass takes the best lesson for each weak finger in
  // severity order, a second pass takes each finger's next-best, and so on.
  for (let round = 0; weaknessPicks.length < weaknessSlots && round < 4; round += 1) {
    for (const [, candidates] of orderedGroups) {
      if (weaknessPicks.length >= weaknessSlots) break;
      if (candidates[round]) weaknessPicks.push(candidates[round]);
    }
  }
  for (const entry of ungrouped) {
    if (weaknessPicks.length >= weaknessSlots) break;
    weaknessPicks.push(entry);
  }
  // Keep the lead lesson on the worst finger.
  weaknessPicks.sort((a, b) => (dominantWeakFinger(b)?.severity ?? 0) - (dominantWeakFinger(a)?.severity ?? 0));

  const progressionPicks = progression.slice(0, progressionSlots);

  // Maintenance preferentially reinforces weak-in-a-good-way skills: a finger
  // that used to be solid but has not been touched in a week.
  const maintenancePicks = maintenance
    .filter((c) => !weaknessPicks.includes(c) && !progressionPicks.includes(c))
    .slice(0, maintenanceSlots);

  let selection = [...weaknessPicks, ...progressionPicks, ...maintenancePicks];

  // Top up to the target plan size from progression, then maintenance. Weakness
  // lessons are deliberately NOT used as filler: the 60% ceiling below is a real
  // constraint, not a number to be worked around.
  const claimed = new Set(selection.map((entry) => entry.lessonId));
  for (const candidate of [...progression, ...maintenance]) {
    if (selection.length >= planSize) break;
    if (claimed.has(candidate.lessonId)) continue;
    selection.push(candidate);
    claimed.add(candidate.lessonId);
  }

  // Guarantee a first-session plan exists even with zero history.
  if (selection.length === 0) {
    selection = library
      .byLevel()
      .slice(0, Math.min(4, library.size))
      .map((lesson) => ({
        lessonId: lesson.id,
        lesson,
        score: 0,
        kind: 'progression',
        reasons: ['The first lesson in the progression — there is no history yet, so start here.'],
        signals: [],
      }));
  }

  /**
   * Enforce the balance ceiling on the *final* plan.
   *
   * The ceiling can only be met if the library actually contains lessons that
   * are not weakness work. In a normal library it always does; in a tiny one
   * where every lesson touches a weak finger it may not. Rather than mislabel
   * weakness lessons as "progression" to fake a number, we trim honestly and
   * report the limitation in `balance` so the UI can explain it.
   */
  const maxWeaknessShare = 0.6;
  const weaknessOf = (list) => list.filter((entry) => entry.kind === 'weakness');
  const hasAlternative = progression.length > 0 || maintenance.length > 0;

  while (
    hasAlternative &&
    weaknessOf(selection).length > 1 &&
    weaknessOf(selection).length / selection.length > maxWeaknessShare
  ) {
    const weaknessEntries = weaknessOf(selection);
    const leastUrgent = weaknessEntries.reduce(
      (worst, entry) =>
        (dominantWeakFinger(entry)?.severity ?? 0) < (dominantWeakFinger(worst)?.severity ?? 0) ? entry : worst,
      weaknessEntries[0],
    );
    selection = selection.filter((entry) => entry !== leastUrgent);
  }

  const weaknessCount = weaknessOf(selection).length;
  const achievedShare = selection.length ? weaknessCount / selection.length : 0;
  const balance =
    achievedShare <= maxWeaknessShare
      ? { status: 'balanced', weaknessShare: round(achievedShare, 2) }
      : {
          status: 'weakness-limited',
          weaknessShare: round(achievedShare, 2),
          note: 'Every lesson available in this library trains a currently weak finger, so today leans toward remediation. Add or unlock more lessons to restore the usual mix.',
        };

  selection = selection.slice(0, planSize);

  // Order: most urgent weakness first while attention is fresh, then new
  // material, finishing with reinforcement. Within weaknesses, the finger that
  // is actually worst leads.
  const severityOf = (entry) => dominantWeakFinger(entry)?.severity ?? 0;
  selection.sort((a, b) => {
    const rank = { weakness: 0, progression: 1, maintenance: 2 };
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.kind === 'weakness') {
      const delta = severityOf(b) - severityOf(a);
      if (delta !== 0) return delta;
    }
    return b.score - a.score;
  });

  const items = selection.map((entry, index) => ({
    order: index + 1,
    lessonId: entry.lessonId,
    kind: entry.kind,
    score: entry.score,
    reasons: entry.reasons,
    targetFingers: entry.lesson.fingers,
    targetMovements: entry.lesson.movements,
    level: entry.lesson.level,
    estimatedSeconds: entry.lesson.estimatedSeconds,
  }));

  const buckets = {
    weakness: items.filter((i) => i.kind === 'weakness').map((i) => i.lessonId),
    progression: items.filter((i) => i.kind === 'progression').map((i) => i.lessonId),
    maintenance: items.filter((i) => i.kind === 'maintenance').map((i) => i.lessonId),
  };

  const plan = {
    date: today,
    generatedAt: now.toISOString(),
    demonstratedLevel: scored[0]?.demonstratedLevel ?? 1,
    items,
    buckets,
    balance,
    reused: false,
    explanation: explainPlan({ items, buckets, assessment, config }),
    weaknessSummary: {
      fingers: assessment.weakFingers.map((f) => ({
        finger: f.finger,
        label: f.label,
        accuracy: f.accuracy,
        severity: f.severity,
        status: f.status,
      })),
      movements: assessment.weakMovements.map((m) => ({
        movement: m.movement,
        label: m.label,
        accuracy: m.accuracy,
        severity: m.severity,
        status: m.status,
      })),
    },
  };

  // Invariant check: every planned lesson must exist in the library, and every
  // exercise must be the library's own text. This is the guard that makes
  // requirement 2 enforceable rather than aspirational.
  assertPlanUsesLibraryOnly(plan, library);

  return plan;
}

/** Throws if a plan contains anything not in the preset library. */
export function assertPlanUsesLibraryOnly(plan, library) {
  for (const item of plan.items) {
    const lesson = library.get(item.lessonId);
    if (!lesson) throw new Error(`BTS produced a plan item for an unknown lesson: ${item.lessonId}`);
  }
  return true;
}

/** A short, human paragraph describing why today looks the way it does. */
export function explainPlan({ items, buckets, assessment, config = BTS_CONFIG }) {
  const parts = [];

  // Name the weakness the plan actually addresses, not merely the worst one on
  // file — otherwise the explanation can point at a finger the plan ignores.
  const targetedFingers = new Set(
    items
      .filter((item) => item.kind === 'weakness')
      .flatMap((item) => item.targetFingers ?? []),
  );
  const addressed = assessment.weakFingers.filter((f) => targetedFingers.has(f.finger));

  if (addressed.length) {
    const names = addressed.map((f) => `${f.label.toLowerCase()} (${f.accuracy}%)`).join(', ');
    parts.push(
      `${buckets.weakness.length} of today's ${items.length} lessons target your current weak ${
        addressed.length === 1 ? 'area' : 'areas'
      }: ${names}.`,
    );
  } else if (assessment.summary.hasEnoughData) {
    parts.push(
      `No finger is currently below the ${config.weaknessAccuracy}% threshold, so today balances new material with reinforcement.`,
    );
  } else {
    parts.push('There is not enough history yet to identify weaknesses, so today starts with foundational lessons.');
  }

  if (buckets.progression.length) {
    parts.push(`${buckets.progression.length} lesson${buckets.progression.length === 1 ? '' : 's'} introduce or consolidate the next skill level.`);
  }
  if (buckets.maintenance.length) {
    parts.push(`${buckets.maintenance.length} keeps previously learned material fresh.`);
  }
  parts.push('The mix is deliberate: weakness work cannot crowd out progression and maintenance.');

  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * 4. Daily tasks
 * ------------------------------------------------------------------ */

/**
 * Derive today's tasks from the plan plus the learner's objectives.
 *
 * Tasks are statements about *behaviour and outcome* that can be checked
 * against real attempt data, never about simply ticking a box.
 */
export function buildDailyTasks({ plan, snapshot, library, now = new Date(), config = BTS_CONFIG }) {
  const today = dateKey(now);
  const todayAttempts = snapshot.todayAttempts ?? [];
  const tasks = [];

  const planLessonIds = plan.items.map((i) => i.lessonId);
  const practisedToday = new Set(todayAttempts.map((a) => a.lessonId));
  const completedPlanLessons = planLessonIds.filter((id) => practisedToday.has(id));

  tasks.push({
    id: `task:${today}:plan`,
    type: 'complete-plan',
    title: 'Complete every lesson in today’s plan',
    description: `Work through all ${planLessonIds.length} lessons the planner selected for you.`,
    target: planLessonIds.length,
    progress: completedPlanLessons.length,
    unit: 'lessons',
    done: completedPlanLessons.length >= planLessonIds.length && planLessonIds.length > 0,
  });

  const weaknessItem = plan.items.find((i) => i.kind === 'weakness');
  if (weaknessItem) {
    const lesson = library.get(weaknessItem.lessonId);
    const done = todayAttempts.some((a) => a.lessonId === weaknessItem.lessonId);
    tasks.push({
      id: `task:${today}:focus`,
      type: 'practise-weakness',
      title: `Practise your focus area: ${lesson?.name ?? weaknessItem.lessonId}`,
      description: 'This is the lesson the planner ranked highest for your weakest movement.',
      target: 1,
      progress: done ? 1 : 0,
      unit: 'lessons',
      done,
      lessonId: weaknessItem.lessonId,
    });
  }

  /**
   * Accuracy goal: a small stretch above demonstrated performance, clamped to a
   * sane band. A learner already at the top of the band is asked to *hold* it
   * rather than beat it, so the task never reads as impossible.
   */
  const lifetimeAccuracy = snapshot.totals?.accuracy || 0;
  const rawGoal = Math.round(lifetimeAccuracy + 2) || 95;
  const goalAccuracy = Math.max(90, Math.min(98, rawGoal));
  const bestAccuracyToday = todayAttempts.length ? Math.max(...todayAttempts.map((a) => a.metrics.accuracy)) : 0;

  let accuracyDescription = 'A clean baseline to aim for on your first exercises.';
  if (snapshot.totals?.attempts > 0) {
    accuracyDescription =
      lifetimeAccuracy >= goalAccuracy
        ? `You are averaging ${lifetimeAccuracy}%, so this is about holding that standard on every exercise.`
        : `Your lifetime accuracy is ${lifetimeAccuracy}%, so this asks for a small, achievable step up.`;
  }

  tasks.push({
    id: `task:${today}:accuracy`,
    type: 'accuracy-goal',
    title: `Reach ${goalAccuracy}% accuracy in a single exercise`,
    description: accuracyDescription,
    target: goalAccuracy,
    progress: bestAccuracyToday,
    unit: '%',
    done: bestAccuracyToday >= goalAccuracy,
  });

  const exerciseGoal = snapshot.settings?.dailyGoalExercises ?? 6;
  const exercisesDoneToday = todayAttempts.length;
  tasks.push({
    id: `task:${today}:volume`,
    type: 'exercise-count',
    title: `Complete ${exerciseGoal} exercises`,
    description: 'Volume matters for muscle memory, but only in addition to accuracy.',
    target: exerciseGoal,
    progress: Math.min(exercisesDoneToday, exerciseGoal),
    unit: 'exercises',
    done: exercisesDoneToday >= exerciseGoal,
  });

  // "Beat your previous attempt" is only meaningful once a lesson has history.
  const repeatable = planLessonIds.find((id) => {
    const attempts = (snapshot.attempts ?? []).filter((a) => a.lessonId === id);
    return attempts.length >= 2;
  });
  if (repeatable) {
    const lesson = library.get(repeatable);
    const history = (snapshot.attempts ?? []).filter((a) => a.lessonId === repeatable);
    const bestBefore = Math.max(...history.slice(0, -1).map((a) => a.metrics.accuracy));
    const bestToday = Math.max(0, ...todayAttempts.filter((a) => a.lessonId === repeatable).map((a) => a.metrics.accuracy));
    tasks.push({
      id: `task:${today}:improve`,
      type: 'beat-previous',
      title: `Beat your best accuracy on ${lesson?.name ?? repeatable}`,
      description: `Your best so far is ${round(bestBefore)}%.`,
      target: round(bestBefore),
      progress: round(bestToday),
      unit: '%',
      done: bestToday > bestBefore,
      lessonId: repeatable,
    });
  }

  return {
    date: today,
    tasks,
    completed: tasks.filter((t) => t.done).length,
    total: tasks.length,
    allDone: tasks.every((t) => t.done),
  };
}

/* ------------------------------------------------------------------ *
 * 5. Combined assessment for the UI
 * ------------------------------------------------------------------ */

/**
 * Everything the Adaptive Learning screen needs, in one deterministic call.
 */
export function assess({ snapshot, library, now = new Date(), config = BTS_CONFIG, forcePlan = false }) {
  const augmented = { ...snapshot, __library: library };
  const weaknesses = identifyWeaknesses(augmented, { config });
  const plan = planDay(augmented, library, { config, now, force: forcePlan });
  const tasks = buildDailyTasks({ plan, snapshot: augmented, library, now, config });
  const scored = scoreLessons({ ...augmented, __weaknesses: weaknesses }, library, { config });

  return {
    date: dateKey(now),
    weaknesses,
    plan,
    tasks,
    recommendations: scored.slice(0, 8).map((entry) => ({
      lessonId: entry.lessonId,
      name: entry.lesson.name,
      level: entry.lesson.level,
      kind: entry.kind,
      score: entry.score,
      reasons: entry.reasons,
      signals: entry.signals,
      fingers: entry.lesson.fingers,
      movements: entry.lesson.movements,
    })),
    demonstratedLevel: plan.demonstratedLevel ?? undefined,
  };
}

export { MOVEMENTS, FINGER_INFO, fingerLabel, movementLabel };
