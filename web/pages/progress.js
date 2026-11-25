/**
 * Progress page — trends, finger breakdown, lesson completion history.
 */

import { h, section, card, barRow, pill, empty, dataTable, lineChart, sparkline, accuracyLabel, trendLabel, duration, relativeTime } from '../dom.js';
import { client as api } from '../client.js';
import { pageHead, shortDate } from './shared.js';
import { statsStrip } from '../dom.js';

export async function progressPage() {
  const [stats, fingers, movements, history, lessonProgress] = await Promise.all([
    api.stats(),
    api.fingers(),
    api.movements(),
    api.history(30),
    api.lessonProgress(),
  ]);

  const activeDays = history.days.filter((d) => d.attempts > 0);

  const strip = statsStrip([
    { label: 'Lifetime WPM', value: stats.attempts ? String(stats.wpm) : '—' },
    { label: 'Accuracy', value: stats.attempts ? `${stats.accuracy}%` : '—' },
    { label: 'Practice time', value: stats.practiceLabel },
    { label: 'Exercises', value: String(stats.attempts) },
    { label: 'Streak', value: `${stats.streak.current}d`, sub: `best ${stats.streak.best}` },
    { label: 'Overall', value: `${stats.overallPercent}%`, sub: `${stats.lessonsPassed}/${stats.lessonsTotal} lessons` },
  ]);

  /* --- trend chart --- */

  const trendChart = activeDays.length >= 2
    ? lineChart({
        series: [
          { name: 'Accuracy (%)', color: 'var(--green)', points: history.days.map((d) => (d.attempts ? d.accuracy : null)) },
          { name: 'WPM', color: 'var(--accent)', points: history.days.map((d) => (d.attempts ? d.wpm : null)) },
        ],
        labels: history.days.map((d) => shortDate(d.date)),
        yLabel: 'Value',
        height: 170,
      })
    : empty('Complete exercises on at least two days to see a trend.');

  const activity = card(
    h('h2', null, 'Practice activity'),
    h('p.faint', { style: { fontSize: '11.5px', margin: '0 0 4px' } }, 'Exercises per day, last 30 days'),
    sparkline(history.days.map((d) => d.attempts)),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-faint)', marginTop: '4px' } },
      h('span', null, shortDate(history.days[0]?.date ?? '')),
      h('span', null, shortDate(history.days[history.days.length - 1]?.date ?? '')),
    ),
  );

  /* --- fingers --- */

  const practisedFingers = fingers.filter((f) => f.total > 0);
  const fingerCard = h(
    'div.card',
    null,
    h('h2', null, 'Finger proficiency'),
    h('p.faint', { style: { fontSize: '11.5px', margin: '0 0 12px' } },
      'Character-level accuracy per finger. Proficiency is accuracy weighted by how much evidence exists.'),
    practisedFingers.length
      ? practisedFingers.map((finger) =>
          h('div', { style: { padding: '4px 0' } },
            barRow(finger.label, finger.accuracy ?? 0, { hint: `${finger.correct}/${finger.total} characters` }),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-faint)', paddingLeft: '120px' } },
              h('span', null, `${finger.total} chars · ${finger.attempts} attempts`),
              trendLabel(finger.trend),
            ),
          ),
        )
      : empty('No finger data yet.'),
  );

  /* --- movements --- */

  const movementCard = h(
    'div.card',
    null,
    h('h2', null, 'Movement variations'),
    movements.length
      ? movements
          .slice()
          .sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0))
          .map((m) =>
            h('div', { style: { padding: '3px 0' } },
              barRow(m.label, m.accuracy ?? 0, { hint: `${m.total} characters` }),
            ),
          )
      : empty('No movement data yet.'),
  );

  /* --- lessons --- */

  const startedLessons = lessonProgress.filter((l) => l.attempts > 0);
  const lessonsCard = h(
    'div.card',
    { style: { padding: 0, overflow: 'hidden' } },
    h('div', { style: { padding: '16px 16px 10px' } },
      h('h2', { style: { margin: 0 } }, 'Lesson history'),
      h('p.faint', { style: { fontSize: '11.5px', margin: '2px 0 0' } },
        `${startedLessons.filter((l) => l.passed).length} passed of ${lessonProgress.length} in the library`),
    ),
    startedLessons.length
      ? h('div', { style: { padding: '0 16px 8px' } },
          dataTable(
            [
              { label: 'Lesson' },
              { label: 'Lvl', align: 'right' },
              { label: 'Attempts', align: 'right' },
              { label: 'Best acc', align: 'right' },
              { label: 'Best WPM', align: 'right' },
              { label: 'Last practised' },
              { label: 'Status' },
            ],
            startedLessons.map((lesson) => [
              h('a', { href: `#/lesson/${encodeURIComponent(lesson.lessonId)}` }, lesson.name),
              `L${lesson.level}`,
              String(lesson.attempts),
              accuracyLabel(lesson.bestAccuracy),
              String(lesson.bestWpm),
              h('span.faint', null, relativeTime(lesson.lastPractisedAt)),
              lesson.passed ? pill('passed', 'green') : pill(`${lesson.completionRatio}% done`, 'yellow'),
            ]),
          ),
        )
      : empty('No lessons started yet.'),
  );

  /* --- daily table --- */

  const dailyTable = activeDays.length
    ? dataTable(
        [
          { label: 'Date' },
          { label: 'Exercises', align: 'right' },
          { label: 'WPM', align: 'right' },
          { label: 'Accuracy', align: 'right' },
          { label: 'Errors', align: 'right' },
          { label: 'Time', align: 'right' },
        ],
        activeDays.slice().reverse().map((day) => [
          shortDate(day.date),
          String(day.attempts),
          String(day.wpm),
          accuracyLabel(day.accuracy),
          String(day.errors),
          duration(day.practiceMs),
        ]),
      )
    : empty('No daily data yet.');

  return [
    pageHead('Progress', 'Performance over time, by finger, by movement and by lesson.'),
    strip,
    section('Trends', card(trendChart)),
    h('div.grid.grid-2', null, fingerCard, movementCard),
    h('div', { style: { height: '16px' } }),
    section('Activity', h('div.grid.grid-2', null, activity, card(h('h2', null, 'Daily detail'), dailyTable))),
    section('Lessons', lessonsCard),
  ];
}
