/**
 * Workers brand-checks `fetch`'s `this`: a bare global reference invoked as
 * `this.fetchImpl(...)` throws "Illegal invocation: function called with
 * incorrect `this` reference". Never default to the raw global — use this
 * wrapper (enforced by tests/guard.test.ts).
 */
export const defaultFetch: typeof fetch = (...args) => fetch(...args);
