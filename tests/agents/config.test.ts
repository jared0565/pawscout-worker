import { describe, it, expect } from 'vitest';
import { resolveAgents } from '../../src/inbox/agents/config';
import { INBOX_LABELS } from '../../src/inbox/types';

describe('resolveAgents', () => {
  it('fills every known label with autosend:false by default', () => {
    const r = resolveAgents(undefined);
    for (const l of INBOX_LABELS) expect(r[l]).toEqual({ autosend: false });
  });
  it('honours a stored partial map and ignores unknown keys', () => {
    const r = resolveAgents({ agents: { 'shipping-returns': { autosend: true }, bogus: { autosend: true } } as any });
    expect(r['shipping-returns'].autosend).toBe(true);
    expect(r['lead'].autosend).toBe(false);
    expect((r as any).bogus).toBeUndefined();
  });
  it('coerces a non-boolean autosend to false (never NaN/undefined)', () => {
    const r = resolveAgents({ agents: { lead: { autosend: 'yes' } } as any });
    expect(r['lead'].autosend).toBe(false);
  });
});
