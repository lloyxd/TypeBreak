/**
 * Hash router.
 *
 * Hash routing keeps the whole app static-file friendly: no server rewrites,
 * no build step, and deep links work when opened from disk too.
 */

const routes = [];
let notFoundHandler = null;
let current = null;
const listeners = new Set();

/**
 * Register a route.
 *
 * @param {string} pattern  e.g. '/lesson/:id'
 * @param {(ctx: {params: object, query: URLSearchParams}) => (Node|Promise<Node>)} handler
 */
export function route(pattern, handler) {
  const keys = [];
  const cleaned = pattern.replace(/\/$/, '');
  const regex = new RegExp(
    `^${(cleaned === '' ? '/' : cleaned)
      .replace(/:[A-Za-z0-9_]+/g, (match) => {
        keys.push(match.slice(1));
        return '([^/]+)';
      })
      .replace(/\*/g, '.*')}$`,
  );
  routes.push({ pattern, regex, keys, handler });
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

/** Navigate programmatically. */
export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) {
    window.history.replaceState(null, '', target);
    resolve();
  } else if (window.location.hash === target) {
    resolve();
  } else {
    window.location.hash = path;
  }
}

export function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function onNavigate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [pathname, search = ''] = hash.split('?');
  return { pathname: pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(search) };
}

let renderToken = 0;

async function resolve() {
  const { pathname, query } = parseHash();
  const token = ++renderToken;

  for (const entry of routes) {
    const match = pathname.match(entry.regex);
    if (!match) continue;

    const params = Object.fromEntries(entry.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    current = { pathname, params, query };
    for (const listener of listeners) listener(current);

    const root = document.getElementById('view');
    root.setAttribute('aria-busy', 'true');
    try {
      const result = await entry.handler({ params, query, pathname });
      // A later navigation superseded this render; discard the stale result.
      if (token !== renderToken) return;
      // Handlers may return a node or a (possibly nested) array of nodes.
      const nodes = (Array.isArray(result) ? result.flat(Infinity) : [result]).filter(
        (node) => node !== null && node !== undefined && node !== false,
      );
      root.replaceChildren(...nodes);
      root.scrollTop = 0;
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (token !== renderToken) return;
      console.error(error);
      const { errorBox } = await import('./pages/shared.js');
      root.replaceChildren(errorBox(error.message ?? 'Something went wrong while loading this page.'));
    } finally {
      root.removeAttribute('aria-busy');
    }
    return;
  }

  if (notFoundHandler) {
    const root = document.getElementById('view');
    const result = await notFoundHandler();
    const nodes = (Array.isArray(result) ? result.flat(Infinity) : [result]).filter(
      (node) => node !== null && node !== undefined && node !== false,
    );
    root.replaceChildren(...nodes);
  }
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  if (!window.location.hash) window.history.replaceState(null, '', '#/');
  resolve();
}

/**
 * Re-render the current route in place.
 *
 * Used when page state changes behind the router's back — regenerating the plan,
 * or importing a backup — so the view reflects reality without a full reload or
 * a fake query string in the URL.
 */
export function refreshRoute() {
  return resolve();
}

/** Intercept in-app link clicks so full page loads are not needed. */
export function link(path, ...children) {
  const a = document.createElement('a');
  a.href = `#${path}`;
  a.append(...children);
  return a;
}
