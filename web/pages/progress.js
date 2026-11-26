/**
 * Progress — what an imported file (or local attempts) can actually show.
 *
 * A fresh device has nothing to graph. This page therefore prefers a short
 * summary of recorded attempts over empty trend charts and skill trees.
 */

import { h, card, pill, empty, dataTable, accuracyLabel, relativeTime, statsStrip } from '../dom.js';
import { client as api } from '../client.js';
import { pageHead } from './shared.js';

export async function progressPage() {
  const [stats, lessonProgress] = await Promise.all([
    api.stats(),
    api.lessonProgress(),
  ]);

  const startedLessons = lessonProgress.filter((lesson) => lesson.attempts > 0);

  if (!stats.attempts) {
    return [
      pageHead('Progress', 'Records come from practice on this device or from a file you import.'),
      card(
        h('h2', null, 'No records yet'),
        h('p.prose', { style: { margin: '0 0 12px' } },
          'Start a lesson, or import a backup in Settings. Charts stay hidden until there is something to identify.'),
        h('div.btn-row', null,
          h('a.btn.primary', { href: '#/lessons' }, 'Learn'),
          h('a.btn', { href: '#/settings' }, 'Import progress'),
        ),
      ),
    ];
  }

  const strip = statsStrip([
    { label: 'WPM', value: String(stats.wpm) },
    { label: 'Accuracy', value: `${stats.accuracy}%` },
    { label: 'Exercises', value: String(stats.attempts) },
    { label: 'Time', value: stats.practiceLabel },
    { label: 'Lessons', value: `${stats.lessonsPassed}/${stats.lessonsTotal}`, tone: 'gold' },
  ]);

  const lessonsCard = card(
    h('h2', null, 'Recorded lessons'),
    h('p.faint', { style: { fontSize: '11.5px', margin: '0 0 12px' } },
      `${startedLessons.filter((lesson) => lesson.passed).length} passed · ${startedLessons.length} with attempts`),
    startedLessons.length
      ? dataTable(
          [
            { label: 'Lesson' },
            { label: 'Attempts', align: 'right' },
            { label: 'Best acc', align: 'right' },
            { label: 'Best WPM', align: 'right' },
            { label: 'Last practised' },
            { label: 'Status' },
          ],
          startedLessons.map((lesson) => [
            h('a', { href: `#/lesson/${encodeURIComponent(lesson.lessonId)}` }, lesson.name),
            String(lesson.attempts),
            accuracyLabel(lesson.bestAccuracy),
            String(lesson.bestWpm),
            h('span.faint', null, relativeTime(lesson.lastPractisedAt)),
            lesson.passed ? pill('passed', 'green') : pill('started', 'yellow'),
          ]),
        )
      : empty('Attempts exist, but none are attached to a lesson yet.'),
  );

  return [
    pageHead('Progress', 'What this device has recorded, including anything restored from a backup.'),
    strip,
    h('div', { style: { height: '16px' } }),
    lessonsCard,
  ];
}
