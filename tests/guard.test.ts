import { describe, it, expect } from 'vitest';

// Vite inlines these file contents as strings at build time (?raw) - no node:fs,
// which workerd doesn't implement. Local ImportMeta augmentation keeps plain tsc happy.
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query?: string; eager?: boolean; import?: string }): Record<string, string>;
  }
}

const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', eager: true, import: 'default' });

// Detects raw D1 access. `.prepare(` and `.batch(` are D1-specific here (no
// collisions in this codebase). `.exec(` is matched ONLY when it is qualified by
// a D1 binding (`DB.exec(` / `.db.exec(`) - RegExp.prototype.exec collides with
// D1Database.exec, so a bare `re.exec(str)` is not raw D1 and must not trip the
// guard. The exec check is binding-qualified BY DESIGN; do not broaden it back to
// a bare `.exec(` (that reintroduces the RegExp false positive), and note it does
// not catch an aliased binding (`const d = env.DB; d.exec(...)`) - acceptable for
// a tripwire whose common paths (`.prepare(`/`.batch(`) stay broad.
export function touchesD1Directly(src: string): boolean {
  return /\.(prepare|batch)\s*\(/.test(src) || /\b(?:DB|db)\s*\.\s*(?:prepare|batch|exec)\s*\(/.test(src);
}

describe('tenant isolation guard', () => {
  it('only tenant-store.ts touches D1 directly', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0); // fail loudly if the glob matched nothing
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith('tenant-store.ts')) continue;
      if (touchesD1Directly(src)) offenders.push(path);
    }
    expect(offenders, `raw D1 access outside tenant-store.ts: ${offenders.join(', ')}`).toEqual([]);
  });

  it('D1 detector flags real D1 access but not RegExp.exec', () => {
    // Positive control: genuine raw D1 must still be caught.
    expect(touchesD1Directly('await env.DB.prepare(sql).run()')).toBe(true);
    expect(touchesD1Directly('this.db.batch([stmt])')).toBe(true);
    expect(touchesD1Directly('await c.env.DB.exec(rawSql)')).toBe(true);
    // Negative control: RegExp.exec (the false positive this guard used to hit).
    expect(touchesD1Directly('while ((m = re.exec(bodyHtml)) !== null) {}')).toBe(false);
    expect(touchesD1Directly('const trail = /[.,;:!?)]+$/.exec(url)')).toBe(false);
  });

  it('never defaults to the raw global fetch (workerd brand-checks `this` - use defaultFetch)', () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith('safe-fetch.ts')) continue;
      if (/typeof fetch\s*=\s*fetch\b/.test(src)) offenders.push(path);
    }
    expect(offenders, `raw global fetch default (Illegal invocation in prod): ${offenders.join(', ')}`).toEqual([]);
  });
});
