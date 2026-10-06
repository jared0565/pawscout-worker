import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { productNoteProblem, withProductNote, setProductNote } from '../src/proxy/product-note';
import { TenantStore } from '../src/tenant-store';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const COLLAR_LINE = 'Connects over a 4G mobile network and shows its location in a phone app. The box holds the collar and tracker only; a SIM card with a data plan is not included.';

type Call = { query: string; variables: Record<string, unknown> | undefined };

// A fake Admin API that answers the description read with `html` and records every call.
function noteAdmin(calls: Call[], html: string, userErrors: { message: string }[] = []): AdminGraphql {
  return async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('pawscoutDesc') && query.includes('query')) {
      return { product: { title: 'GPS Tracker Collar for Dogs and Cats', descriptionHtml: html } };
    }
    if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'x' }, userErrors } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
}

async function seedLink(handle: string, shopifyProductId: string | null = 'gid://shopify/Product/42') {
  const store = new TenantStore(env.DB, SHOP);
  await store.putLink({ cjPid: 'pid-1', state: 'imported', shopifyProductId: shopifyProductId ?? undefined, handle, category: 'pet-accessories' });
  return store;
}

describe('productNoteProblem', () => {
  it('accepts a plain factual line', () => {
    expect(productNoteProblem(COLLAR_LINE)).toBeNull();
  });
  it('refuses an empty or blank note', () => {
    expect(productNoteProblem('')).not.toBeNull();
    expect(productNoteProblem('   ')).not.toBeNull();
  });
  it('refuses a note over 300 characters', () => {
    expect(productNoteProblem('a'.repeat(300))).toBeNull();
    expect(productNoteProblem('a'.repeat(301))).not.toBeNull();
  });
  it('refuses HTML', () => {
    expect(productNoteProblem('Needs a <b>SIM</b> card')).not.toBeNull();
  });
  // The description sweep rewrites any description that still reads like raw
  // supplier copy, and its rewrite would silently drop the note.
  it('refuses wording that would make the description sweep rewrite the listing', () => {
    expect(productNoteProblem('No refunds once the tracker is activated.')).not.toBeNull();
    expect(productNoteProblem('Packing list: collar and tracker.')).not.toBeNull();
  });
});

describe('withProductNote', () => {
  it('appends the note as its own marked paragraph after the existing copy', () => {
    expect(withProductNote('<p>A pet collar supplied with a GPS tracker.</p>', 'No SIM card included.'))
      .toBe('<p>A pet collar supplied with a GPS tracker.</p>\n<p class="pawscout-note">No SIM card included.</p>');
  });
  it('replaces an earlier note instead of adding a second one', () => {
    const once = withProductNote('<p>Copy.</p>', 'First wording.');
    expect(withProductNote(once, 'Second wording.'))
      .toBe('<p>Copy.</p>\n<p class="pawscout-note">Second wording.</p>');
  });
  it('turns an em-dash or en-dash into a plain hyphen and escapes ampersands', () => {
    expect(withProductNote('<p>Copy.</p>', 'Collar — tracker – app & SIM'))
      .toBe('<p>Copy.</p>\n<p class="pawscout-note">Collar - tracker - app &amp; SIM</p>');
  });
});

describe('setProductNote', () => {
  it('writes the existing description plus the note to the linked Shopify product', async () => {
    const store = await seedLink('gps-tracker-collar-for-dogs-and-cats');
    const calls: Call[] = [];
    const r = await setProductNote(store, noteAdmin(calls, '<p>A pet collar supplied with a GPS tracker.</p>'),
      'gps-tracker-collar-for-dogs-and-cats', 'No SIM card included.');
    expect(r).toEqual({
      ok: true,
      productId: 'gid://shopify/Product/42',
      descriptionHtml: '<p>A pet collar supplied with a GPS tracker.</p>\n<p class="pawscout-note">No SIM card included.</p>'
    });
    const update = calls.find((c) => c.query.includes('productUpdate'));
    expect(update?.variables).toEqual({
      input: {
        id: 'gid://shopify/Product/42',
        descriptionHtml: '<p>A pet collar supplied with a GPS tracker.</p>\n<p class="pawscout-note">No SIM card included.</p>'
      }
    });
  });

  it('answers 404 for a handle the worker never imported, without touching Shopify', async () => {
    const store = await seedLink('some-other-product');
    const calls: Call[] = [];
    const r = await setProductNote(store, noteAdmin(calls, '<p>x</p>'), 'no-such-handle', 'No SIM card included.');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });

  it('answers 404 for a link that has no Shopify product yet', async () => {
    const store = await seedLink('half-imported', null);
    const calls: Call[] = [];
    const r = await setProductNote(store, noteAdmin(calls, '<p>x</p>'), 'half-imported', 'No SIM card included.');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });

  it('answers 400 for a refused note or a missing handle, without touching Shopify', async () => {
    const store = await seedLink('gps-tracker-collar-for-dogs-and-cats');
    const calls: Call[] = [];
    const bad = await setProductNote(store, noteAdmin(calls, '<p>x</p>'), 'gps-tracker-collar-for-dogs-and-cats', 'No refunds once activated.');
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const noHandle = await setProductNote(store, noteAdmin(calls, '<p>x</p>'), '', 'No SIM card included.');
    expect(noHandle).toMatchObject({ ok: false, status: 400 });
    const notText = await setProductNote(store, noteAdmin(calls, '<p>x</p>'), 'gps-tracker-collar-for-dogs-and-cats', 42);
    expect(notText).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it('reports a Shopify userError as a failure, not a success', async () => {
    const store = await seedLink('gps-tracker-collar-for-dogs-and-cats');
    const r = await setProductNote(store, noteAdmin([], '<p>x</p>', [{ message: 'Description is too long' }]),
      'gps-tracker-collar-for-dogs-and-cats', 'No SIM card included.');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toContain('Description is too long');
  });
});
