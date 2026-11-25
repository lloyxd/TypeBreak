/**
 * Long-run simulation: a learner whose weak finger improves over several weeks.
 *
 * This is not a test — it is a behavioural check that BTS actually responds to
 * improvement the way the brief describes (prioritise weakness → reduce
 * priority once sufficient improvement is demonstrated).
 *
 *   node tools/simulate.js
 */

import { AppService } from '../src/core/service.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'typebreak-sim-'));

let clock = new Date('2026-10-01T09:00:00');
const service = new AppService({
  rootDir: join(HERE, '..'),
  statePath: join(dir, 'state.json'),
  now: () => clock,
});

/**
 * Simulate typing an exercise. `weakFinger` and `errorRate` control accuracy;
 * only characters belonging to the weak finger are mistyped, which is what a
 * real finger-specific weakness looks like.
 */
function practise(lessonId, { weakFinger = null, errorRate = 0 } = {}) {
  const lesson = service.lesson(lessonId);
  const exercise = lesson.exercises[0];
  const session = service.startSession({ lessonId, exerciseId: exercise.id, mode: 'flow' });
  const keyByFinger = {
    LPINKY: ['a', 'q', 'z'],
    LRING: ['s', 'w', 'x'],
    LMIDDLE: ['d', 'e', 'c'],
    LINDEX: ['f', 'g', 'r', 't', 'v', 'b'],
    RINDEX: ['j', 'h', 'u', 'y', 'n', 'm'],
    RMIDDLE: ['k', 'i', ','],
    RRING: ['l', 'o', '.'],
    RPINKY: [';', 'p', '/'],
  };
  const weakKeys = weakFinger ? keyByFinger[weakFinger] ?? [] : [];

  let index = 0;
  for (const ch of session.text) {
    // Deterministic pseudo-random error injection based on position.
    const wantsError = errorRate > 0 && ((index * 7919) % 100) / 100 < errorRate;
    const isWeakKey = weakKeys.includes(ch.toLowerCase());
    const typed = wantsError && isWeakKey ? 'z' : ch;
    index += 1;
    service.press({ key: typed });
    clock = new Date(clock.getTime() + 180);
  }
  return service.finishSession();
}

const ringPlanCounts = [];
const ringAccuracies = [];
let day = 0;

// Week 1-2: the left ring is genuinely bad.
for (day = 0; day < 14; day += 1) {
  const plan = service.todaysPlan({ force: true });
  const ringLessons = plan.items.filter((i) => service.lesson(i.lessonId).fingers.includes('LRING'));

  for (const item of plan.items.slice(0, 4)) {
    practise(item.lessonId, { weakFinger: 'LRING', errorRate: 0.7 });
  }
  ringPlanCounts.push(ringLessons.length);

  const ring = service.fingerProgress().find((f) => f.finger === 'LRING');
  if (ring?.accuracy != null) ringAccuracies.push(ring.accuracy);
  clock = new Date(clock.getTime() + 86400000);
}

console.log('=== After 2 weeks of ring-focused practice ===');
const weakPhase = service.weaknesses();
console.log('weak fingers:', weakPhase.weakFingers.map((f) => `${f.label} ${f.accuracy}%`));
console.log('ring accuracy trajectory:', ringAccuracies.filter((_, i) => i % 2 === 0).map((a) => `${a.toFixed(0)}%`).join(' → '));
console.log('ring lessons per plan:', ringPlanCounts.slice(-5).join(', '));

// Weeks 3-4: the learner improves. Errors drop steadily.
console.log('\n=== Weeks 3-4: practising accurately ===');
for (; day < 28; day += 1) {
  const plan = service.todaysPlan({ force: true });
  for (const item of plan.items.slice(0, 4)) {
    practise(item.lessonId, { weakFinger: 'LRING', errorRate: 0.05 });
  }
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
const stats = service.stats();
console.log(stats);
console.log('\nOverall progress:', service.dashboard().overall);

console.log('\n=== Finger table ===');
for (const f of service.fingerProgress().filter((f) => f.total > 0)) {
  console.log(`  ${f.label.padEnd(16)} ${String(f.accuracy).padStart(5)}%  ${String(f.total).padStart(5)} chars  ${f.trend}`);
}

rmSync(dir, { recursive: true, force: true });
