/**
 * Dashboard — three ways into the app.
 *
 * Practice, Learn and Settings are the only actions the landing page needs.
 * History, when it exists (including after an import), is a thin readout so a
 * fresh start does not pretend there are records.
 */

import { h, statsStrip, pill } from '../dom.js';
import { client as api } from '../client.js';
import { navigate } from '../router.js';
import { pageHead } from './shared.js';

export async function dashboardPage() {
  const data = await api.dashboard();
  const hasHistory = data.totals.attempts > 0;

  const actions = h(
    'div.dash-actions',
    null,
    actionCard({
      kicker: 'Type',
      title: 'Practice',
      body: 'A timed drill. Pick a duration and start typing.',
      onClick: () => navigate('/practice'),
    }),
    actionCard({
      kicker: 'Curriculum',
      title: 'Learn',
      body: hasHistory ? 'Continue from the lessons you have already started.' : 'Start the lesson library from the beginning.',
      onClick: () => navigate('/lessons'),
    }),
    actionCard({
      kicker: 'This device',
      title: 'Settings',
      body: 'Import a progress file, export a backup, or change typing mode.',
      onClick: () => navigate('/settings'),
    }),
  );

  const strip = hasHistory
    ? statsStrip([
        { label: 'Accuracy', value: `${data.totals.accuracy}%`, sub: `${data.totals.attempts} exercises` },
        { label: 'Speed', value: `${data.totals.wpm}`, sub: 'words per minute' },
        { label: 'Lessons', value: `${data.overall.lessonsPassed}/${data.overall.lessonsTotal}`, sub: 'passed' },
        { label: 'Streak', value: `${data.streak.current}d`, sub: `best ${data.streak.best}`, tone: 'gold' },
      ])
    : h(
        'p.muted',
        { style: { marginTop: '8px', fontSize: '13px' } },
        'No records on this device yet. Import a backup in Settings if you already have one.',
      );

  return [
    pageHead(
      'Dashboard',
      `${longDate()}`,
      data.streak.practisedToday
        ? pill('Practised today', 'green')
        : pill('Not yet practised today', 'yellow'),
    ),
    actions,
    strip,
  ];
}

function actionCard({ kicker, title, body, onClick }) {
  return h(
    'button.dash-action',
    { type: 'button', onClick },
    h('span.dash-action-kicker', null, kicker),
    h('h2', null, title),
    h('p', null, body),
  );
}

function longDate() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
