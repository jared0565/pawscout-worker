import { describe, it, expect } from 'vitest';
import { saveProfitFlags, MAX_AD_SHARE } from '../src/profit-console';
import { DEFAULT_PROFIT } from '../src/types';

function fakeStore() {
  const saved: Array<Record<string, unknown>> = [];
  return { saved, saveProfit: async (p: Record<string, unknown>) => { saved.push(p); } } as any;
}
const cfgWith = (profit: Record<string, unknown>) => ({ profit: { ...DEFAULT_PROFIT, ...profit } }) as any;

describe('saveProfitFlags (console profit config)', () => {
  it('sets a valid ad share (stored as a fraction of revenue)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ adShareOfRevenue: 0.33 }), { adShareOfRevenue: 0.15 });
    expect(store.saved[0].adShareOfRevenue).toBe(0.15);
  });

  it('clamps an out-of-range ad share to MAX_AD_SHARE (never past where net stops rising with price)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({}), { adShareOfRevenue: 0.9 });
    expect(store.saved[0].adShareOfRevenue).toBe(MAX_AD_SHARE);
  });

  it('ignores a non-numeric ad share (keeps the current value)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ adShareOfRevenue: 0.2 }), { adShareOfRevenue: 'oops' });
    expect(store.saved[0].adShareOfRevenue).toBe(0.2);
  });

  it('first enable FORCES dryRun:true (preview) even if the saved config had it false', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ enabled: false, dryRun: false }), { enabled: true });
    expect(store.saved[0].enabled).toBe(true);
    expect(store.saved[0].dryRun).toBe(true); // going full-auto is never a side effect of enabling
  });

  it('honors an explicit dryRun flip once already enabled (owner going full-auto)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ enabled: true, dryRun: true }), { dryRun: false });
    expect(store.saved[0].dryRun).toBe(false);
  });
});
