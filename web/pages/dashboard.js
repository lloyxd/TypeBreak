/**
 * Dashboard — the landing page.
 *
 * Overview, today's plan, tasks, streak and a compact performance readout.
 */

import { h, statsStrip, card, barRow, pill, empty, duration, relativeTime } from '../dom.js';
import { client as api } from '../client.js';
import { navigate } from '../router.js';
import { pageHead } from './shared.js';

export async function dashboardPage() {
  const data = await api.dashboard();

  const hasHistory = data.totals.attempts > 0;

  const strip = statsStrip([
    { label: 'Streak', value: `${data.streak.current}d`, sub: `best ${data.streak.best}` },
    { label: 'Accuracy', value: hasHistory ? `${data.totals.accuracy}%` : '—', sub: `${data.totals.attempts} exercises` },
    { label: 'Speed', value: hasHistory ? `${data.totals.wpm}` : '—', sub: 'words per minute' },
    { label: 'Practice', value: duration(data.totals.practiceMs), sub: 'total time' },
    { label: 'Lessons', value: `${data.overall.lessonsPassed}/${data.overall.lessonsTotal}`, sub: 'passed' },
    { label: 'Overall', value: `${data.overall.percent}%`, sub: 'demonstrated ability' },
  ]);

  /* --- today's plan --- */

  const planItems = data.plan.items.map((item) =>
    h(
      'div.lesson-row',
      { style: { cursor: 'pointer' }, onClick: () => navigate(`/lesson/${encodeURIComponent(item.lessonId)}`) },
      h('div.lesson-index', null, String(item.order)),
      h(
        'div',
        null,
        h('div.lesson-name', null, item.name ?? item.lessonId),
        h('div.lesson-meta', null, pill(item.kind, item.kind), h('span', null, `Level ${item.level}`), h('span', null, `~${Math.round((item.estimatedSeconds ?? 60) / 60)} min`)),
        h('div.lesson-why', null, item.reasons[0]),
      ),
      h(
        'button.primary',
        {
          onClick: (event) => {
            event.stopPropagation();
            navigate(`/practice?lesson=${encodeURIComponent(item.lessonId)}&mode=${data.settings?.mode ?? 'flow'}`);
          },
        },
        'Start',
      ),
    ),
  );

  const planCard = h(
    'div.card',
    { style: { padding: '0', overflow: 'hidden' } },
    h(
      'div',
      { style: { padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } },
        h('h2', { style: { margin: 0 } }, "Today's plan"),
        h('button.ghost', { onClick: () => navigate('/adaptive') }, 'Why these?'),
      ),
      h('p.prose', { style: { margin: '6px 0 0', fontSize: '12.5px' } }, data.plan.explanation),
    ),
    planItems.length ? planItems : empty('No plan for today yet.'),
  );

  /* --- tasks --- */

  const taskList = h(
    'ul.list',
    null,
    data.tasks.tasks.map((task) =>
      h(
        'li.list-check',
        null,
        h(`div.check${task.done ? '.done' : ''}`, { 'aria-hidden': 'true' }, task.done ? '✓' : ''),
        h(
          'div',
          { style: { flex: '1', minWidth: '0' } },
          h('div.task-title', null, task.title),
          h('div.task-desc', null, task.description),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px' } },
            h('div.bar', { style: { flex: '1', maxWidth: '120px' } },
              h(`div.bar-fill${task.done ? '.green' : ''}`, { style: { width: `${Math.min(100, (task.progress / Math.max(1, task.target)) * 100)}%` } }),
            ),
            h('span.faint', { style: { fontSize: '11px' } }, `${task.progress}/${task.target}${task.unit === '%' ? '%' : ''}`),
          ),
        ),
      ),
    ),
  );

  const tasksCard = card(
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      h('h2', { style: { marginBottom: '12px' } }, 'Daily tasks'),
      h('span.faint', { style: { fontSize: '12px' } }, `${data.tasks.completed}/${data.tasks.total}`),
    ),
    taskList,
  );

  /* --- weaknesses --- */

  const weaknessPanel = data.weaknesses.findings.length
    ? h(
        'ul.list',
        null,
        data.weaknesses.findings.slice(0, 3).map((finding) =>
          h(
            'li',
            null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' } },
              h('strong', { style: { fontSize: '12.5px' } }, finding.title),
              pill(`severity ${finding.severity}`, finding.severity > 55 ? 'red' : 'yellow'),
            ),
            h('div.task-desc', { style: { marginTop: '2px' } }, finding.detail),
          ),
        ),
      )
    : h('p.muted', { style: { fontSize: '12.5px', margin: 0 } },
        data.weaknesses.summary.hasEnoughData
          ? 'No weaknesses detected — all practised fingers are above target.'
          : 'Not enough history yet for a reliable assessment.');

  const weaknessCard = card(
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      h('h2', { style: { marginBottom: '12px' } }, 'Weaknesses'),
      h('button.ghost', { onClick: () => navigate('/adaptive') }, 'Details'),
    ),
    weaknessPanel,
  );

  /* --- fingers --- */

  const practised = data.fingers.filter((f) => f.total > 0);
  const fingerCard = practised.length
    ? card(
        h('h2', null, 'Finger proficiency'),
        practised.map((finger) => barRow(finger.label, finger.accuracy ?? 0, { hint: `${finger.correct}/${finger.total} characters` })),
        h('p.faint', { style: { fontSize: '11.5px', margin: '10px 0 0' } },
          `${practised.length} of 10 fingers practised · based on character accuracy`),
      )
    : card(h('h2', null, 'Finger proficiency'), empty('Complete an exercise to see per-finger accuracy.'));

  /* --- recent attempts --- */

  const recentCard = data.recentAttempts.length
    ? card(
        h('h2', null, 'Recent exercises'),
        h(
          'ul.list',
          null,
          data.recentAttempts.map((attempt) =>
            h(
              'li',
              { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12.5px' } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, attempt.lessonName),
              h('span', { style: { display: 'flex', gap: '12px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' } },
                h('span.muted', null, `${attempt.wpm} WPM`),
                h('span', { style: { color: attempt.accuracy >= 96 ? 'var(--green)' : attempt.accuracy >= 92 ? 'var(--yellow)' : 'var(--red)' } }, `${attempt.accuracy}%`),
              ),
            ),
          ),
        ),
      )
    : card(h('h2', null, 'Recent exercises'), empty('No exercises completed yet.'));

  return [
    pageHead(
      'Dashboard',
      `${longDate()}`,
      data.streak.practisedToday
        ? pill('Practised today', 'green')
        : pill('Not yet practised today', 'yellow'),
    ),
    strip,
    h(
      'div.grid.grid-sidebar',
      null,
      planCard,
      h('div', null, tasksCard, h('div', { style: { height: '16px' } }), weaknessCard),
    ),
    h('div', { style: { height: '24px' } }),
    h('div.grid.grid-2', null, fingerCard, recentCard),
  ];
}

function longDate() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export { relativeTime };
