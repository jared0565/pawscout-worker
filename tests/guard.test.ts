import { describe, it, expect } from 'vitest';

// Vite inlines these file contents as strings at build time (?raw) — no node:fs,
// which workerd doesn't implement. Local ImportMeta augmentation keeps plain tsc happy.
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query?: string; eager?: boolean; import?: string }): Record<string, string>;
  }
}

const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', eager: true, import: 'default' });

describe('tenant isolation guard', () => {
  it('only tenant-store.ts touches D1 directly', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0); // fail loudly if the glob matched nothing
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith('tenant-store.ts')) continue;
      if (/\.(prepare|exec|batch)\s*\(/.test(src) || /\bDB\b\s*\.\s*(prepare|exec|batch)/.test(src)) {
        offenders.push(path);
      }
    }
    expect(offenders, `raw D1 access outside tenant-store.ts: ${offenders.join(', ')}`).toEqual([]);
  });
});
