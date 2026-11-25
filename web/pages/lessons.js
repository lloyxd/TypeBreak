/**
 * Lessons page — browse the preset library, filter it, and open a lesson.
 */

import { h, section, card, pill, empty, relativeTime, clear } from '../dom.js';
import { client as api } from '../client.js';
import { navigate } from '../router.js';
import { pageHead, errorBox } from './shared.js';

/** Facets are derived from a static library, so one lookup per session is enough. */
let cachedFacets = null;

export async function lessonsPage({ query }) {
  const filters = {
    finger: query.get('finger') ?? '',
    movement: query.get('movement') ?? '',
    category: query.get('category') ?? '',
    difficulty: query.get('level') ?? '',
    search: query.get('search') ?? '',
  };

  const lessons = api.lessons(filters);
  const overview = api.libraryOverview();
  cachedFacets = overview.facets ?? cachedFacets;

  const facets = cachedFacets ?? { fingers: [], movements: [], categories: [], levels: [] };

  const listHost = h('div.card', { style: { padding: 0, overflow: 'hidden' } });

  function renderList(items) {
    clear(listHost);
    if (!items.length) {
      listHost.appendChild(empty('No lessons match these filters.'));
      return;
    }
    listHost.appendChild(
      h(
        'div',
        null,
        items.map((lesson) =>
          h(
            'div.lesson-row',
            { style: { cursor: 'pointer' }, onClick: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`) },
            h('div.lesson-index', null, `L${lesson.level}`),
            h(
              'div',
              null,
              h('div.lesson-name', null, lesson.name),
              h('div.lesson-meta', null,
                h('span', null, lesson.fingers.map((f) => fingerShort(f)).join(', ')),
                h('span.faint', null, '·'),
                h('span', null, lesson.movements.join(', ')),
                h('span.faint', null, '·'),
                h('span', null, `${lesson.exercises.length} exercises`),
              ),
              h('div.task-desc', null, lesson.description.slice(0, 120) + (lesson.description.length > 120 ? '…' : '')),
            ),
            h('span.pill', null, `L${lesson.level}`),
          ),
        ),
      ),
    );
  }

  renderList(lessons);

  /* --- filter controls --- */

  const updateFilter = (key, value) => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    navigate(`/lessons${qs ? `?${qs}` : ''}`);
  };

  const fingerSelect = h(
    'select',
    {
      onChange: (event) => updateFilter('finger', event.target.value),
      'aria-label': 'Filter by finger',
    },
    h('option', { value: '' }, 'All fingers'),
    facets.fingers.map((f) => h('option', { value: f.id, selected: filters.finger === f.id }, `${f.label} (${f.count})`)),
  );

  const movementSelect = h(
    'select',
    {
      onChange: (event) => updateFilter('movement', event.target.value),
      'aria-label': 'Filter by movement',
    },
    h('option', { value: '' }, 'All movements'),
    facets.movements.map((m) => h('option', { value: m.id, selected: filters.movement === m.id }, `${m.label} (${m.count})`)),
  );

  const categorySelect = h(
    'select',
    {
      onChange: (event) => updateFilter('category', event.target.value),
      'aria-label': 'Filter by category',
    },
    h('option', { value: '' }, 'All categories'),
    facets.categories.map((c) => h('option', { value: c.id, selected: filters.category === c.id }, `${c.label} (${c.count})`)),
  );

  const levelSelect = h(
    'select',
    {
      onChange: (event) => updateFilter('level', event.target.value),
      'aria-label': 'Filter by difficulty',
    },
    h('option', { value: '' }, 'All levels'),
    facets.levels.map((l) => h('option', { value: String(l.level), selected: filters.difficulty === String(l.level) }, `Level ${l.level} (${l.count})`)),
  );

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search lessons…',
    value: filters.search,
    'aria-label': 'Search lessons',
    onInput: debounce((event) => updateFilter('search', event.target.value), 300),
  });

  const activeFilters = Object.entries(filters).filter(([, v]) => v);
  const clearBtn = activeFilters.length
    ? h('button.ghost', { onClick: () => navigate('/lessons') }, 'Clear filters')
    : null;

  const filterBar = h(
    'div.filters',
    null,
    searchInput,
    fingerSelect,
    movementSelect,
    categorySelect,
    levelSelect,
    clearBtn,
  );

  const countLabel = h('p.faint', { style: { fontSize: '12px', margin: '0 0 12px' } },
    `${lessons.length} lesson${lessons.length === 1 ? '' : 's'}${activeFilters.length ? ' matching filters' : ` · ${overview.overview?.exerciseCount ?? overview.exerciseCount ?? ''} exercises total`}`);

  return [
    pageHead('Lessons', 'Every lesson in the preset library. The adaptive planner only ever selects from these.'),
    filterBar,
    countLabel,
    listHost,
  ];
}

/**
 * Single lesson detail page.
 */
export async function lessonPage({ params }) {
  const payload = api.lesson(params.id);
  if (!payload) {
    return [pageHead('Lesson', null), errorBox(`No lesson with the id "${params.id}". Browse the library to find one.`)];
  }

  const { lesson, progress } = payload;

  const header = pageHead(
    lesson.name,
    lesson.description,
    [
      h('span.pill.progression', null, `Level ${lesson.level}`),
      h('span.pill', null, lesson.category.replace(/-/g, ' ')),
      progress?.passed ? pill('Passed', 'green') : progress?.attempts ? pill('In progress', 'yellow') : null,
    ].filter(Boolean),
  );

  const facts = h(
    'div.grid.grid-3',
    { style: { marginBottom: '24px' } },
    card(
      h('h3', null, 'Targets'),
      factRow('Fingers', lesson.fingers.map(fingerShort).join(', ')),
      factRow('Movements', lesson.movements.join(', ')),
      factRow('Accuracy', `${lesson.criteria.minAccuracy}%`),
      factRow('Speed', lesson.criteria.speedIsAdvisory ? `${lesson.criteria.minWpm} WPM (advisory)` : `${lesson.criteria.minWpm} WPM`),
    ),
    card(
      h('h3', null, 'Learning outcome'),
      h('p.prose', { style: { margin: 0 } }, lesson.outcome),
    ),
    card(
      h('h3', null, 'Your history'),
      progress?.attempts
        ? h('div', null,
            factRow('Attempts', String(progress.attempts)),
            factRow('Best accuracy', `${progress.bestAccuracy}%`),
            factRow('Best speed', `${progress.bestWpm} WPM`),
            factRow('Last practised', relativeTime(progress.lastPractisedAt)),
          )
        : h('p.muted', { style: { margin: 0, fontSize: '12.5px' } }, 'Not practised yet.'),
    ),
  );

  const exerciseList = h(
    'div.card',
    { style: { padding: 0, overflow: 'hidden' } },
    lesson.exercises.map((exercise, index) =>
      h(
        'div',
        { style: { display: 'flex', gap: '14px', alignItems: 'center', padding: '13px 16px', borderBottom: index < lesson.exercises.length - 1 ? '1px solid var(--border)' : 'none' } },
        h('div.lesson-index', { style: { width: '26px' } }, String(index + 1)),
        h('div.mono', { style: { flex: '1', fontSize: '13px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, exercise.text),
        h('button', {
          onClick: () => navigate(`/practice?lesson=${encodeURIComponent(lesson.id)}&ex=${index}`),
        }, 'Practise'),
      ),
    ),
  );

  const related = lesson.related?.length
    ? section('Related lessons',
        h('div.btn-row', null,
          lesson.related.map((id) => h('a.btn', { href: `#/lesson/${encodeURIComponent(id)}` }, id)),
        ),
      )
    : null;

  const startAll = h('button.primary', {
    onClick: () => navigate(`/practice?lesson=${encodeURIComponent(lesson.id)}&ex=0`),
  }, 'Start lesson');

  return [
    header,
    h('div.btn-row', { style: { marginBottom: '24px' } },
      startAll,
      h('button', { onClick: () => navigate('/lessons') }, 'Back to library'),
    ),
    facts,
    section('Exercises', exerciseList),
    related,
  ].filter(Boolean);
}

function factRow(label, value) {
  return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0', fontSize: '12.5px' } },
    h('span.faint', null, label),
    h('span', { style: { textAlign: 'right' } }, value),
  );
}

function fingerShort(id) {
  const names = {
    LPINKY: 'L pinky',
    LRING: 'L ring',
    LMIDDLE: 'L middle',
    LINDEX: 'L index',
    LTHUMB: 'L thumb',
    RTHUMB: 'R thumb',
    RINDEX: 'R index',
    RMIDDLE: 'R middle',
    RRING: 'R ring',
    RPINKY: 'R pinky',
  };
  return names[id] ?? id;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
