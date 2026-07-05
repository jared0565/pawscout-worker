import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { listTrafficBoard, validateTrafficPayload, STARTER_CHANNELS, trafficChannelForUi } from '../src/traffic';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';

describe('traffic board seed', () => {
  it('first read seeds the starter strategy exactly once', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const first = await listTrafficBoard(store);
    expect(first).toHaveLength(STARTER_CHANNELS.length);
    const second = await listTrafficBoard(store);
    expect(second).toHaveLength(STARTER_CHANNELS.length); // no duplicate seeding
  });
  it('board is ordered by priority: the do-now channels come first', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const rows = await listTrafficBoard(store);
    const priorities = rows.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(priorities[0]).toBe(1);
  });
  it('seeding is per shop: another shop starts with its own board', async () => {
    await listTrafficBoard(new TenantStore(env.DB, SHOP));
    const other = await listTrafficBoard(new TenantStore(env.DB, 'b.myshopify.com'));
    expect(other).toHaveLength(STARTER_CHANNELS.length);
    const mine = await new TenantStore(env.DB, SHOP).listTrafficChannels();
    expect(mine).toHaveLength(STARTER_CHANNELS.length);
  });
  it('starter strategy carries no em or en dashes (customer-facing dash rule applies to the console too)', () => {
    const all = STARTER_CHANNELS.map((c) => `${c.name} ${c.rationale} ${c.nextAction}`).join(' ');
    expect(/[—–―]/.test(all)).toBe(false);
  });
});

describe('traffic board edits', () => {
  it('a deleted seeded channel stays deleted (no reseed while rows remain)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const rows = await listTrafficBoard(store);
    expect(await store.deleteTrafficChannel(rows[0].id)).toBe(true);
    const after = await listTrafficBoard(store);
    expect(after).toHaveLength(STARTER_CHANNELS.length - 1);
  });
  it('upsert with an id updates in place; without an id it creates', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const rows = await listTrafficBoard(store);
    const target = rows[0];
    await store.upsertTrafficChannel({
      id: target.id, name: target.name, status: 'testing', priority: 1,
      rationale: target.rationale, nextAction: 'Feed is connected, watching impressions.', notes: 'Connected 5 July.'
    });
    const updated = (await store.listTrafficChannels()).find((r) => r.id === target.id)!;
    expect(updated.status).toBe('testing');
    expect(updated.notes).toBe('Connected 5 July.');
    const newId = await store.upsertTrafficChannel({
      name: 'Pinterest boards', status: 'idea', priority: 3, rationale: 'Visual pet niche.', nextAction: 'Make three boards.', notes: ''
    });
    expect((await store.listTrafficChannels()).some((r) => r.id === newId)).toBe(true);
  });
});

describe('validateTrafficPayload', () => {
  const base = { name: 'SEO', status: 'idea', priority: 2, rationale: 'r', nextAction: 'n', notes: '' };
  it('accepts a valid payload and passes the id through when present', () => {
    const r = validateTrafficPayload({ ...base, id: 'abc' });
    expect(r.ok && r.value.id).toBe('abc');
    const r2 = validateTrafficPayload(base);
    expect(r2.ok && r2.value.id).toBeUndefined();
  });
  it('rejects missing name, unknown status and out-of-range priority', () => {
    expect(validateTrafficPayload({ ...base, name: '' }).ok).toBe(false);
    expect(validateTrafficPayload({ ...base, status: 'someday' }).ok).toBe(false);
    expect(validateTrafficPayload({ ...base, priority: 0 }).ok).toBe(false);
    expect(validateTrafficPayload({ ...base, priority: 6 }).ok).toBe(false);
  });
  it('trims and caps the free-text fields', () => {
    const r = validateTrafficPayload({ ...base, rationale: '  why  ', notes: 'x'.repeat(2000) });
    expect(r.ok && r.value.rationale).toBe('why');
    expect(r.ok && r.value.notes.length).toBe(1000);
  });
});

describe('trafficChannelForUi', () => {
  it('maps snake_case row fields to the UI shape', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const rows = await listTrafficBoard(store);
    const ui = trafficChannelForUi(rows[0]);
    expect(ui).toHaveProperty('nextAction');
    expect(ui).toHaveProperty('updatedAt');
    expect(ui).not.toHaveProperty('shop');
  });
});
