import { describe, it, expect } from 'vitest';
import { probeGrantedScopes, missingScopes, REDIRECT_SCOPES } from '../src/shopify-scopes';

describe('probeGrantedScopes', () => {
  const admin = (handles: string[]) => (async () => ({
    currentAppInstallation: { accessScopes: handles.map((h) => ({ handle: h })) },
  })) as never;

  it('returns the granted handles, sorted', async () => {
    const r = await probeGrantedScopes(admin(['write_products', 'read_products']));
    expect(r).toEqual({ ok: true, granted: ['read_products', 'write_products'] });
  });

  it('reports a failure as ok:false, NEVER as an empty grant', async () => {
    // The dangerous confusion this module exists to prevent: an unreachable
    // Admin API must not read as "the app holds no scopes", which would make a
    // working feature look like a permissions problem.
    const r = await probeGrantedScopes((async () => { throw new Error('401 unauthorized'); }) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('401');
  });

  it('survives a malformed response without throwing', async () => {
    const r = await probeGrantedScopes((async () => ({})) as never);
    expect(r).toEqual({ ok: true, granted: [] });
  });

  it('drops null and empty handles rather than reporting them as scopes', async () => {
    const r = await probeGrantedScopes((async () => ({
      currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: '' }, {}, null] },
    })) as never);
    expect(r).toEqual({ ok: true, granted: ['read_products'] });
  });
});

describe('missingScopes', () => {
  it('lists what is absent, in the required order', () => {
    expect(missingScopes(['read_products'], REDIRECT_SCOPES)).toEqual([
      'read_online_store_navigation', 'write_online_store_navigation',
    ]);
  });

  it('returns [] when everything is granted', () => {
    expect(missingScopes([...REDIRECT_SCOPES, 'read_products'], REDIRECT_SCOPES)).toEqual([]);
  });

  it('catches a PARTIAL grant - write without read', () => {
    // The realistic Dev Dashboard slip: one checkbox ticked, not both.
    expect(missingScopes(['write_online_store_navigation'], REDIRECT_SCOPES))
      .toEqual(['read_online_store_navigation']);
  });
});

describe('runScopeWatch', () => {
  it('is exported and never throws when the vault is unusable', async () => {
    // A diagnostic must not be able to break the 15-minute sweep it rides on.
    const { runScopeWatch } = await import('../src/shopify-scopes');
    await expect(runScopeWatch({ DB: undefined, PAWSCOUT_MASTER_KEY: 'not-a-key' } as never))
      .resolves.toBeUndefined();
  });
});
