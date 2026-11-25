/**
 * Web app entry point: registers routes and boots the router.
 */

import { route, setNotFound, startRouter, currentPath } from './router.js';
import { h } from './dom.js';
import { pageHead, errorBox } from './pages/shared.js';
import { dashboardPage } from './pages/dashboard.js';
import { lessonsPage, lessonPage } from './pages/lessons.js';
import { practicePage } from './pages/practice.js';
import { progressPage } from './pages/progress.js';
import { adaptivePage } from './pages/adaptive.js';
import { settingsPage } from './pages/settings.js';

route('/', dashboardPage);
route('/lessons', lessonsPage);
route('/lesson/:id', lessonPage);
route('/practice', practicePage);
route('/progress', progressPage);
route('/adaptive', adaptivePage);
route('/settings', settingsPage);

setNotFound(() => [
  pageHead('Not found', 'That page does not exist.'),
  errorBox('Check the address, or use the navigation on the left.'),
]);

/* --- navigation highlighting & live badges --- */

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/lessons', label: 'Lessons' },
  { path: '/progress', label: 'Progress' },
  { path: '/adaptive', label: 'Adaptive' },
  { path: '/settings', label: 'Settings' },
];

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

/** Refresh the small badges in the sidebar without a full re-render. */
async function refreshSidebarStats() {
  try {
    const stats = await fetch('/api/stats').then((r) => r.json());
    const streakEl = document.getElementById('sidebar-streak');
    const accEl = document.getElementById('sidebar-accuracy');
    if (streakEl) streakEl.textContent = `${stats.streak.current}-day streak`;
    if (accEl) accEl.textContent = stats.attempts ? `${stats.accuracy}% accuracy · ${stats.wpm} WPM` : 'No practice yet';
  } catch {
    /* the sidebar is decorative; failures are not worth surfacing */
  }
}

paintNav(currentPath());
window.addEventListener('hashchange', () => paintNav(currentPath()));

startRouter();
refreshSidebarStats();
// Keep the sidebar reasonably current when returning to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSidebarStats();
});

// Keyboard shortcuts: g then d/l/p/a
let lastKey = null;
let lastKeyAt = 0;
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
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

export { NAV_ITEMS, h };
