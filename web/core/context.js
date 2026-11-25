/**
 * Application context.
 *
 * One `AppService` per page load, initialised once. Pages import `getService()`
 * and use it directly — there is no API boundary any more, because all learning
 * logic already lives in the browser.
 */

import { AppService } from './service.js';

let service = null;
let initPromise = null;

/**
 * The shared service. Throws if used before `bootService()` resolves; pages are
 * only mounted after boot, so this is a programming error rather than a runtime
 * condition to handle.
 */
export function getService() {
  if (!service) {
    throw new Error('Service used before boot. Call bootService() first.');
  }
  return service;
}

/** Initialise the service once. Safe to call repeatedly. */
export function bootService() {
  if (!initPromise) {
    service = new AppService();
    initPromise = service.init().catch((error) => {
      initPromise = null;
      service = null;
      throw error;
    });
  }
  return initPromise;
}

/** Whether storage is usable (false in some private-browsing modes). */
export function storageAvailable() {
  return Boolean(service?.store?.available);
}

/** The storage error, when storage is unavailable. */
export function storageError() {
  return service?.store?.storageError ?? null;
}
