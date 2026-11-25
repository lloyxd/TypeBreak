/**
 * Service worker registration.
 *
 * Registers only where the worker can actually run (HTTPS or localhost) and
 * stays quiet when it cannot, since a failed registration should never break
 * the app. An update is surfaced as a small toast so a user mid-session is not
 * silently reloaded.
 */

import { h } from './dom.js';

const SW_URL = './sw.js';

export function canRegister() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  );
}

export function registerServiceWorker() {
  if (!canRegister()) return;

  /**
   * Register after the page has loaded.
   *
   * `boot()` is async (it fetches the library and opens IndexedDB), so by the
   * time this runs the `load` event may already have fired — in which case a
   * `load` listener would never fire and offline support would silently never
   * engage. Checking `readyState` handles both orders.
   */
  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, { scope: './' });

      // A new worker is installed and waiting: offer a reload rather than
      // swapping assets underneath a running session.
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(registration);
          }
        });
      });
    } catch (error) {
      // Not fatal: the app works online without a worker.
      console.warn('TypeBreak: offline support unavailable', error);
    }
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });

  // Reload once a new worker takes control.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function showUpdateToast(registration) {
  const existing = document.querySelector('.toast.update-toast');
  if (existing) return;

  const toast = h(
    'div.toast.update-toast',
    { role: 'status' },
    h('span', null, 'A new version is available.'),
    h(
      'button.ghost',
      {
        style: { marginLeft: '10px' },
        onClick: () => {
          toast.remove();
          registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        },
      },
      'Reload',
    ),
  );
  document.body.appendChild(toast);
}

/** Ask the browser to keep our data out of automatic eviction. */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
