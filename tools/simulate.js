/**
 * Long-run simulation of the BTS algorithm.
 *
 * A behavioural check, not a test: it drives a learner whose weak finger improves
 * over several weeks and prints what the planner does in response. Useful for
 * confirming that weakness priority actually decays as skills recover.
 *
 *   node tools/simulate.js
 */

import { AppService } from '../web/core/service.js';
import { MemoryStore } from '../tests/memory-store.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadLibrary } from '../web/core/library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const library = loadLibrary(JSON.parse(readFileSync(join(HERE, '..', 'web', 'data', 'lessons.json'), 'utf8')));

let clock = new Date('2026-10-01T09:00:00');
const store = new MemoryStore({ now: () => clock });
const service = new AppService({ library, now: () => clock, store });

/** Keys owned by each finger, for injecting finger-specific errors. */
const KEY_BY_FINGER = {
  LPINKY: ['a', 'q', 'z'],
  LRING: ['s', 'w', 'x'],
  LMIDDLE: ['d', 'e', 'c'],
  LINDEX: ['f', 'g', 'r', 't', 'v', 'b'],
  RINDEX: ['j', 'h', 'u', 'y', 'n', 'm'],
  RMIDDLE: ['k', 'i', ','],
  RRING: ['l', 'o', '.'],
  RPINKY: [';', 'p', '/'],
};

/** Type one exercise, mistyping only characters belonging to `weakFinger`. */
function practise(lessonId, { weakFinger = null, errorRate = 0 } = {}) {
  const lesson = service.lesson(lessonId);
  const exercise = lesson.exercises[0];
  const session = service.startSession({ lessonId, exerciseId: exercise.id, mode: 'flow' });
  const weakKeys = weakFinger ? KEY_BY_FINGER[weakFinger] ?? [] : [];

  let index = 0;
  for (const ch of session.text) {
    // Deterministic pseudo-random error injection keyed to position.
    const wantsError = errorRate > 0 && ((index * 7919) % 100) / 100 < errorRate;
    const isWeakKey = weakKeys.includes(ch.toLowerCase());
    service.press({ key: wantsError && isWeakKey ? 'z' : ch });
    index += 1;
    clock = new Date(clock.getTime() + 180);
  }
  return service.finishSession();
}

const ringPlanCounts = [];
const ringAccuracies = [];
let day = 0;

// Weeks 1-2: the left ring is genuinely bad.
for (; day < 14; day += 1) {
  const plan = service.todaysPlan({ force: true });
  const ringLessons = plan.items.filter((i) => service.lesson(i.lessonId).fingers.includes('LRING'));
  for (const item of plan.items.slice(0, 4)) practise(item.lessonId, { weakFinger: 'LRING', errorRate: 0.7 });
  ringPlanCounts.push(ringLessons.length);

  const ring = service.fingerProgress().find((f) => f.finger === 'LRING');
  if (ring?.accuracy != null) ringAccuracies.push(ring.accuracy);
  clock = new Date(clock.getTime() + 86400000);
}

console.log('=== After 2 weeks of ring-focused practice ===');
const weakPhase = service.weaknesses();
console.log('weak fingers:', weakPhase.weakFingers.map((f) => `${f.label} ${f.accuracy}%`));
console.log('ring accuracy trajectory:', ringAccuracies.filter((_, i) => i % 2 === 0).map((a) => `${a.toFixed(0)}%`).join(' → '));
console.log('ring lessons per plan (last 5 days):', ringPlanCounts.slice(-5).join(', '));

// Weeks 3-4: the learner improves. Errors drop steadily.
console.log('\n=== Weeks 3-4: practising accurately ===');
for (; day < 28; day += 1) {
  const plan = service.todaysPlan({ force: true });
  for (const item of plan.items.slice(0, 4)) practise(item.lessonId, { weakFinger: 'LRING', errorRate: 0.05 });
  clock = new Date(clock.getTime() + 86400000);
}

const improved = service.weaknesses();
console.log('weak fingers now:', improved.weakFingers.map((f) => `${f.label} ${f.accuracy}%`).join(', ') || 'none');
const ringNow = service.fingerProgress().find((f) => f.finger === 'LRING');
console.log('ring accuracy now:', `${ringNow.accuracy}%`, '· trend:', ringNow.trend);

const finalPlan = service.todaysPlan({ force: true });
const ringTargets = finalPlan.items.filter((i) => service.lesson(i.lessonId).fingers.includes('LRING'));
console.log('ring lessons in final plan:', ringTargets.length, 'of', finalPlan.items.length);
console.log('plan composition:', {
  weakness: finalPlan.buckets.weakness.length,
  progression: finalPlan.buckets.progression.length,
  maintenance: finalPlan.buckets.maintenance.length,
});

console.log('\n=== Totals ===');
console.log(service.stats());
console.log('\nOverall:', service.dashboard().overall);

console.log('\n=== Finger table ===');
for (const f of service.fingerProgress().filter((f) => f.total > 0)) {
  console.log(`  ${f.label.padEnd(16)} ${String(f.accuracy).padStart(5)}%  ${String(f.total).padStart(5)} chars  ${f.trend}`);
}

console.log('\n=== Backup round trip ===');
const backup = service.createExport();
console.log(`export: ${backup.summary.attempts} attempts, ${backup.summary.lessons} lessons, format ${backup.exportVersion}/${backup.schemaVersion}`);
const inspected = service.inspectImport(JSON.stringify(backup));
console.log(`re-import inspect: ok=${inspected.ok} new=${inspected.preview.newAttempts} duplicate=${inspected.preview.duplicateAttempts}`);
