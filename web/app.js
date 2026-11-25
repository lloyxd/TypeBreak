/**
 * Web app entry point.
 *
 * Boot order matters: the service must be initialised (library fetched, database
 * opened) before any page renders, because pages read progress synchronously.
 * A failure here shows a real message rather than a blank screen.
 */

import { route, setNotFound, startRouter, currentPath } from './router.js';
import { h } from './dom.js';
import { pageHead } from './pages/shared.js';
import { bootService, storageAvailable, storageError } from './core/context.js';
import { dashboardPage } from './pages/dashboard.js';
import { lessonsPage, lessonPage } from './pages/lessons.js';
import { practicePage } from './pages/practice.js';
import { progressPage } from './pages/progress.js';
import { adaptivePage } from './pages/adaptive.js';
import { settingsPage } from './pages/settings.js';
import { registerServiceWorker } from './pwa.js';

/* ---------------- navigation ---------------- */

function paintNav(pathname) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  for (const link of nav.querySelectorAll('a')) {
    const target = link.getAttribute('href')?.replace(/^#/, '') ?? '';
    const active = target === '/' ? pathname === '/' : pathname === target || pathname.startsWith(`${target}/`);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Sidebar summary, refreshed after each navigation so it never goes stale. */
async function refreshSidebar() {
  const { getService } = await import('./core/context.js');
  const service = getService();
  const stats = service.stats();
  const streakEl = document.getElementById('sidebar-streak');
  const accEl = document.getElementById('sidebar-accuracy');
  const saveEl = document.getElementById('sidebar-save');

  if (streakEl) streakEl.textContent = `${stats.streak.current}-day streak`;
  if (accEl) accEl.textContent = stats.attempts ? `${stats.accuracy}% accuracy · ${stats.wpm} WPM` : 'No practice yet';
  if (saveEl) {
    saveEl.textContent = storageAvailable() ? 'Saved in this browser' : 'Not saved — storage blocked';
    saveEl.style.color = storageAvailable() ? 'var(--text-faint)' : 'var(--red)';
  }
}

/* ---------------- boot ---------------- */

function fatal(message, error) {
  const view = document.getElementById('view');
  if (!view) return;
  view.replaceChildren(
    pageHead('TypeBreak could not start', null),
    h('div.error-box', { role: 'alert' },
      h('strong', null, message),
      error ? h('p', { style: { margin: '6px 0 0', fontSize: '12.5px' } }, String(error.message ?? error)) : null,
      h('p', { style: { margin: '10px 0 0', fontSize: '12.5px' } },
        'Reload the page to try again. If this keeps happening, check that the lesson library file (data/lessons.json) is reachable.'),
      h('div.btn-row', { style: { marginTop: '12px' } },
        h('button.primary', { onClick: () => window.location.reload() }, 'Reload')),
    ),
  );
}

async function boot() {
  try {
    await bootService();
  } catch (error) {
    console.error(error);
    fatal('The lesson library or local database could not be loaded.', error);
    return;
  }

  route('/', dashboardPage);
  route('/lessons', lessonsPage);
  route('/lesson/:id', lessonPage);
  route('/practice', practicePage);
  route('/progress', progressPage);
  route('/adaptive', adaptivePage);
  route('/settings', settingsPage);

  setNotFound(() => [
    pageHead('Not found', 'That page does not exist.'),
    h('div.error-box', null, 'Check the address, or use the navigation on the left.'),
  ]);

  paintNav(currentPath());
  window.addEventListener('hashchange', () => {
    paintNav(currentPath());
    // Pages read progress at render time; the sidebar should follow.
    setTimeout(refreshSidebar, 0);
  });
  window.addEventListener('typebreak:progress-changed', () => {
    setTimeout(refreshSidebar, 0);
  });

  startRouter();
  refreshSidebar();

  if (!storageAvailable()) {
    console.warn('TypeBreak: running without persistent storage', storageError());
  }

  // Save immediately when the page is being hidden, so a refresh mid-session
  // does not lose the last attempt.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      import('./core/context.js').then(({ getService }) => getService().flush());
    }
  });

  registerServiceWorker();
}

/* ---------------- shortcuts ---------------- */

let lastKey = null;
let lastKeyAt = 0;
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const now = Date.now();
  if (lastKey === 'g' && now - lastKeyAt < 700) {
    const map = { d: '/', l: '/lessons', p: '/progress', a: '/adaptive', s: '/settings' };
    if (map[event.key]) {
      window.location.hash = map[event.key];
      lastKey = null;
      return;
    }
  }
  lastKey = event.key;
  lastKeyAt = now;
});

boot();
