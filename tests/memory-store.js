/**
 * A synchronous, in-memory stand-in for `IndexedDbStore`.
 *
 * Used by the service tests: the service's own logic is what those tests are
 * about, and making every one `async` to satisfy IndexedDB would obscure that.
 * The real IndexedDB store has its own tests in `store.test.js`.
 *
 * The contract mirrored here is exactly the one the service relies on:
 * `getState / update / appendAttempt / replaceState / clear / flush / lastBackup`.
 */

import { emptyState, migrate } from '../web/core/db.js';

export class MemoryStore {
  constructor({ now = () => new Date(), maxAttempts = 2000, initialState = null } = {}) {
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.available = true;
    this.storageError = null;
    this.state = initialState ? migrate(initialState) : emptyState({ now });
    this.backups = [];
    this.writeCount = 0;
  }

  async init() {
    return this.state;
  }

  getState() {
    return this.state;
  }

  get attemptCount() {
    return this.state.attempts.length;
  }

  update(fn) {
    const result = fn(this.state);
    this.state.updatedAt = this.now().toISOString();
    this.writeCount += 1;
    return result;
  }

  appendAttempt(record) {
    return this.update((state) => {
      state.attempts.push(record);
      if (state.attempts.length > this.maxAttempts) {
        state.attempts = state.attempts.slice(-this.maxAttempts);
      }
      return record;
    });
  }

  async flush() {
    return undefined;
  }

  async replaceState(next) {
    this.backups.push(JSON.parse(JSON.stringify(this.state)));
    this.state = migrate(next);
    this.state.updatedAt = this.now().toISOString();
    this.writeCount += 1;
    return this.state;
  }

  async clear() {
    this.state = emptyState({ now: this.now });
    this.backups = [];
    return this.state;
  }

  async lastBackup() {
    return this.backups.length ? { state: this.backups[this.backups.length - 1] } : null;
  }

  async estimateUsage() {
    return { usage: JSON.stringify(this.state).length, quota: 50 * 1024 * 1024 };
  }
}
