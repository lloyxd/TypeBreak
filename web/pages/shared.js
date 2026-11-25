/**
 * Small helpers shared by the page modules.
 */

import { h } from '../dom.js';

export function errorBox(message) {
  return h('div.error-box', { role: 'alert' }, message);
}

export function loading(label = 'Loading…') {
  return h('div.loading', null, label);
}

/** Page title block. */
export function pageHead(title, subtitle, extra = null) {
  return h(
    'div.page-head',
    null,
    h('div', null, h('h1', null, title), subtitle ? h('p.subtitle', null, subtitle) : null),
    extra ? h('div.page-head-meta', null, extra) : null,
  );
}

/** An explanation block used for BTS "why" panels. */
export function reasonList(reasons) {
  return h(
    'ul.list',
    null,
    reasons.map((reason) => h('li', null, h('span.muted', null, reason))),
  );
}

/** Simple toast. */
export function toast(message, timeout = 2400) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = h('div.toast', { role: 'status' }, message);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

/** Confirm dialog wrapper. */
export function confirmDialog(message) {
  return window.confirm(message);
}

/** Format a date key like `2026-11-25` as `Nov 25`. */
export function shortDate(key) {
  if (!key) return '';
  const [, m, d] = key.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number.parseInt(m, 10) - 1]} ${Number.parseInt(d, 10)}`;
}
