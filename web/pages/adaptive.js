/**
 * Adaptive Learning page — the BTS view.
 *
 * Shows identified weaknesses, why each lesson was selected, and the full
 * scoring breakdown so the recommendations are auditable by the user.
 */

import { h, section, card, pill, empty, dataTable } from '../dom.js';
import { client as api } from '../client.js';
import { navigate, refreshRoute } from '../router.js';
import { pageHead, toast } from './shared.js';
export async function adaptivePage() {
  const data = api.adaptive();

  // The plan carries lesson ids; the recommendations list is only the top few,
  // so names are resolved against the full library to avoid showing raw ids.
  const nameById = new Map();
  for (const lesson of api.lessons()) nameById.set(lesson.id, lesson.name);
  for (const rec of data.recommendations) nameById.set(rec.lessonId, rec.name);
  const lessonNameOf = (item) => nameById.get(item.lessonId) ?? item.lessonId;

  const regenBtn = h('button', {
    onClick: (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Recomputing…';
      try {
        api.regeneratePlan();
        toast('Plan regenerated with fresh scoring');
        // Re-render in place: the new plan is persisted, so a re-mount shows it
        // without a reload or a fake query string the router would have to strip.
        refreshRoute();
      } catch (error) {
        toast(error.message);
        btn.disabled = false;
        btn.textContent = 'Regenerate plan';
      }
    },
  }, 'Regenerate plan');

  const header = pageHead('Adaptive learning', 'How the BTS algorithm reads your performance today.', regenBtn);

  /* --- explanation --- */

  const explanationCard = card(
    h('h2', null, "Why today's plan looks like this"),
    h('p.prose', { style: { margin: 0 } }, data.plan.explanation),
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
      pill(`${data.plan.buckets.weakness.length} weakness`, 'weakness'),
      pill(`${data.plan.buckets.progression.length} progression`, 'progression'),
      pill(`${data.plan.buckets.maintenance.length} maintenance`, 'maintenance'),
      h('span.faint', { style: { fontSize: '11.5px', alignSelf: 'center' } }, `demonstrated level ${data.demonstratedLevel ?? data.plan.demonstratedLevel}`),
    ),
    data.plan.balance?.status === 'weakness-limited'
      ? h('p', { style: { margin: '10px 0 0', fontSize: '12px', color: 'var(--yellow)' } }, data.plan.balance.note)
      : null,
  );

  /* --- weaknesses --- */

  const findingRows = data.weaknesses.findings.map((finding) =>
    h(
      'li',
      null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' } },
        h('strong', { style: { fontSize: '13px' } }, finding.title),
        pill(`severity ${finding.severity}`, finding.severity > 55 ? 'red' : 'yellow'),
      ),
      h('ul', { style: { margin: '4px 0 0', paddingLeft: '16px' } },
        finding.reasons.map((reason) => h('li', { style: { border: 'none', padding: '1px 0', fontSize: '11.5px', color: 'var(--text-faint)' } }, reason)),
      ),
    ),
  );

  const weaknessCard = card(
    h('h2', null, 'Identified weaknesses'),
    h('p.faint', { style: { fontSize: '11.5px', margin: '0 0 12px' } },
      'Multiple attempts are required before anything is called a weakness.'),
    data.weaknesses.findings.length ? h('ul.list', null, findingRows) : empty(
      data.weaknesses.summary.hasEnoughData
        ? 'No weakness detected — every practised finger is at or above target accuracy.'
        : 'Not enough data yet. Keep practising and the assessment will appear here.',
    ),
  );

  /* --- finger status grid --- */

  const fingerStatus = h(
    'div.card',
    null,
    h('h2', null, 'Finger status'),
    data.weaknesses.fingerEvals.map((evaluation) => {
      const label = fingerLabelOf(evaluation.finger);
      const tone = evaluation.status === 'critical' ? 'red' : evaluation.status === 'weak' ? 'yellow' : evaluation.status === 'strong' ? 'green' : '';
      return h('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          padding: '5px 0',
          borderBottom: '1px solid var(--border)',
          fontSize: '12.5px',
        },
      },
        h('span', null, label),
        h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span.faint.mono', { style: { fontSize: '11.5px' } }, evaluation.accuracy === null ? '—' : `${evaluation.accuracy}%`),
          pill(evaluation.status, tone),
        ),
      );
    }),
  );

  /* --- the plan, with per-item reasons --- */

  const planCard = h(
    'div.card',
    { style: { padding: 0, overflow: 'hidden' } },
    h('div', { style: { padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' } },
      h('h2', { style: { margin: 0 } }, "Today's selected lessons"),
      h('p.faint', { style: { fontSize: '11.5px', margin: '2px 0 0' } },
        'Every lesson below is selected from the preset library — none are generated.'),
    ),
    data.plan.items.map((item) =>
      h(
        'div',
        { style: { padding: '14px 16px', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' } },
          h('div', null,
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '3px' } },
              h('span.mono.faint', { style: { fontSize: '11.5px' } }, `${item.order}.`),
              h('a', { href: `#/lesson/${encodeURIComponent(item.lessonId)}`, style: { fontWeight: '600', textDecoration: 'none', color: 'var(--text)' } }, lessonNameOf(item)),
              pill(item.kind, item.kind),
              h('span.faint', { style: { fontSize: '11px' } }, `L${item.level}`),
            ),
            h('ul', { style: { margin: 0, paddingLeft: '16px' } },
              item.reasons.map((reason) => h('li', { style: { fontSize: '11.5px', color: 'var(--text-faint)', padding: '1px 0', border: 'none', listStyle: 'disc' } }, reason)),
            ),
          ),
          h('button', {
            onClick: () => navigate(`/practice?lesson=${encodeURIComponent(item.lessonId)}&mode=flow`),
          }, 'Start'),
        ),
      ),
    ),
  );

  /* --- recommendations with scores --- */

  const recCard = h(
    'div.card',
    { style: { padding: 0, overflow: 'hidden' } },
    h('div', { style: { padding: '16px 16px 12px' } },
      h('h2', { style: { margin: 0 } }, 'Scored recommendations'),
      h('p.faint', { style: { fontSize: '11.5px', margin: '2px 0 0' } },
        'Priority scores from the BTS weighting. Higher means more urgent.'),
    ),
    h('div', { style: { padding: '0 16px 12px' } },
      dataTable(
        [
          { label: 'Lesson' },
          { label: 'Type' },
          { label: 'Lvl', align: 'right' },
          { label: 'Score', align: 'right' },
          { label: 'Primary reason' },
        ],
        data.recommendations.map((rec) => [
          h('a', { href: `#/lesson/${encodeURIComponent(rec.lessonId)}` }, rec.name),
          pill(rec.kind, rec.kind),
          String(rec.level),
          h('span.mono', null, String(rec.score)),
          h('span.faint', { style: { fontSize: '11.5px' } }, rec.reasons[0]),
        ]),
      ),
    ),
  );

  /* --- score breakdown for the top pick --- */

  const top = data.recommendations[0];
  const breakdownCard = top
    ? card(
        h('h2', null, 'Score breakdown'),
        h('p.faint', { style: { fontSize: '11.5px', margin: '0 0 12px' } }, top.name),
        renderSignals(top.signals),
      )
    : null;

  return [
    header,
    explanationCard,
    section(null, h('div.grid.grid-sidebar', null, weaknessCard, fingerStatus)),
    section(null, planCard),
    section(null, h('div.grid.grid-sidebar', null, recCard, breakdownCard)),
  ];
}

function renderSignals(signals) {
  if (!signals?.length) return empty('No scoring signals fired for this lesson.');
  const max = Math.max(...signals.map((s) => Math.abs(s.weight)), 1);
  return h(
    'div',
    null,
    signals.map((signal) =>
      h('div', { style: { padding: '4px 0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '2px' } },
          h('span', { style: { color: 'var(--text-dim)' } }, signal.id.replace(/-/g, ' ')),
          h('span.mono', { style: { color: signal.weight >= 0 ? 'var(--green)' : 'var(--red)' } },
            `${signal.weight >= 0 ? '+' : ''}${signal.weight}`),
        ),
        h('div.bar', null,
          h(`div.bar-fill.${signal.weight >= 0 ? 'green' : 'red'}`, {
            style: { width: `${(Math.abs(signal.weight) / max) * 100}%` },
          }),
        ),
      ),
    ),
  );
}

function fingerLabelOf(id) {
  const names = {
    LPINKY: 'Left pinky',
    LRING: 'Left ring',
    LMIDDLE: 'Left middle',
    LINDEX: 'Left index',
    LTHUMB: 'Left thumb',
    RTHUMB: 'Right thumb',
    RINDEX: 'Right index',
    RMIDDLE: 'Right middle',
    RRING: 'Right ring',
    RPINKY: 'Right pinky',
  };
  return names[id] ?? id;
}
