/**
 * Shared UI fragments for storage state.
 */

import { h } from '../dom.js';

/**
 * A banner shown when local storage is unavailable.
 *
 * Private browsing and locked-down enterprise policies can block IndexedDB. The
 * app still works in that case, but progress will not survive a refresh, and
 * saying so plainly is better than silently losing the user's practice.
 */
export function storageBanner(error = null) {
  return h(
    'div.error-box',
    { role: 'alert' },
    h('strong', null, 'Progress cannot be saved in this browser'),
    h('p', { style: { margin: '6px 0 0', fontSize: '12.5px' } },
      'Local storage is blocked, which usually means private browsing or a browser privacy setting. You can keep practising, but everything will be lost when you close or refresh the page.'),
    error ? h('p', { style: { margin: '4px 0 0', fontSize: '11.5px', opacity: 0.75 } }, String(error.message ?? error)) : null,
  );
}
