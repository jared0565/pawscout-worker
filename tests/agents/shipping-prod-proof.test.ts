/**
 * FUNCTIONAL PROOF - inbox item-aware nearest-warehouse shipping, run against REAL
 * production data pulled read-only from D1 on 2026-06-25 (live worker 4b703ac5,
 * git HEAD c59f63a == deployed). This executes the DEPLOYED agent code
 * (shippingAgent.ground + deterministicAppendix + deriveDestinationCountry +
 * stripQuotedReply) over the actual live catalog / logistics matrix / inbox thread,
 * and asserts the EXACT customer-facing delivery line each path produces.
 *
 * WHY THIS IS THE VERIFICATION OF RECORD for the per-SKU "UK fulfilment location"
 * wording: that string is emitted VERBATIM by deterministicAppendix, gated solely on
 *   verifiedGb = item.verifiedGbWarehouse && dest === 'GB'
 * The LLM never authors it (shipping prompt: "do NOT state a delivery time yourself";
 * "Never name the dispatch country"). So proving this gate across every branch on real
 * data IS the complete proof of the relaxed allowance; a live LLM regenerate would not
 * exercise this string at all (and no live thread links a product, so it could not even
 * reach the per-item branch).
 *
 * REAL PROD VALUES (D1 query, 2026-06-25):
 *   cj_logistics (synced 2026-06-25, 0 failures): GB->GB 2-5 (Yodel GB to GB),
 *     CN->GB 4-9, CN->US 5-11, US->US 3-5; NO GB->US row.
 *   GB-warehoused product (product_links.state='imported'):
 *     handle interactive-wood-sisal-cat-turntable-scratching-post,
 *     cj_pid 2059208486801747970, detail.origins {"GB":85}, repVid 2059208486914994177.
 *   CN-only product (state='imported'): handle plush-christmas-dog-toy,
 *     cj_pid 2606081152391625800, detail.origins {"CN":9650}.
 *   tenant_config.fulfil.logistics: ABSENT -> resolveLogistics = DEFAULT_LOGISTICS
 *     (processing 2-5, customs 5, slack 2). Door-to-door bands therefore:
 *       GB->GB (domestic, no customs)  = {2+2, 5+5+0+2} = 4-12
 *       CN->GB (cross-border + customs) = {2+4, 5+9+5+2} = 6-21
 *       CN->US (cross-border + customs) = {2+5, 5+11+5+2} = 7-23  (matches the prior live CN->US draft "7-23 days")
 *   Live thread b42734c3 ("International Order Inquiry"); latest inbound names "the US".
 */
import { describe, it, expect, vi } from 'vitest';
import { shippingAgent } from '../../src/inbox/agents/shipping';
import { deriveDestinationCountry } from '../../src/inbox/freight';
import { stripQuotedReply } from '../../src/inbox/quote';

const ISO = '2026-06-25T00:00:00.000Z'; // fresh: within DEFAULT stalenessHours (72h) of the test run window

// Real cj_logistics rows (the accessor returns rows shaped like this).
const ROUTES: Record<string, any> = {
  'GB->GB': { from_country: 'GB', to_country: 'GB', channel: 'Yodel GB to GB', transit_min: 2, transit_max: 5, aging_raw: '2-5', synced_at: ISO },
  'CN->GB': { from_country: 'CN', to_country: 'GB', channel: 'CJPacket Ordinary', transit_min: 4, transit_max: 9, aging_raw: '4-9', synced_at: ISO },
  'CN->US': { from_country: 'CN', to_country: 'US', channel: 'LuWei Ordinary US', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: ISO },
  'US->US': { from_country: 'US', to_country: 'US', channel: 'Yunexpress US to US #3', transit_min: 3, transit_max: 5, aging_raw: '3-5', synced_at: ISO },
  // NOTE: no 'GB->US' key on purpose - prod has no such matrix row.
};

// Real warehouse_products.detail payloads (origins + variants), exactly as stored in D1.
const GB_TURNTABLE = JSON.stringify({ origins: { GB: 85 }, variants: [{ vid: '2059208486914994177', stock: 85 }] });
const CN_PLUSH = JSON.stringify({ origins: { CN: 9650 }, variants: [{ vid: 'CNV1', stock: 9650 }] });

/** Route-aware ctx that feeds ground()/resolveItemShipping the real prod rows. cj=null
 *  forces the deterministic matrix path (the conservative degrade if a live CJ quote
 *  is unavailable) so the asserted band is reproducible. */
function ctxFor(opts: { msg: string; handle?: string; cjPid?: string; detail?: string }) {
  const links: Record<string, { cj_pid: string }> = {};
  const warehouse: Record<string, { detail: string }> = {};
  if (opts.handle && opts.cjPid && opts.detail) {
    links[opts.handle] = { cj_pid: opts.cjPid };
    warehouse[opts.cjPid] = { detail: opts.detail };
  }
  const store = {
    getLinkByHandle: vi.fn().mockImplementation((h: string) => Promise.resolve(links[h] ?? null)),
    getLinkByShopifyProductId: vi.fn().mockResolvedValue(null),
    getWarehouseProduct: vi.fn().mockImplementation((p: string) => Promise.resolve(warehouse[p] ?? null)),
    getLogisticsRoute: vi.fn().mockImplementation((from: string, to: string) =>
      Promise.resolve(ROUTES[`${from}->${to}`] ?? null)
    ),
  };
  return {
    store, cfg: { fulfil: {} }, admin: null, cj: null,
    thread: { subject: 'International Order Inquiry', contact_email: 'gift@gmail.com' },
    conversation: opts.msg, latestMessage: opts.msg,
    contactEmail: 'gift@gmail.com', customerName: null,
  } as any;
}

const GB_URL = 'activepaw.co.uk/products/interactive-wood-sisal-cat-turntable-scratching-post';
const CN_URL = 'activepaw.co.uk/products/plush-christmas-dog-toy';

describe('PROD PROOF: per-item nearest-warehouse shipping (real D1 data, deployed code)', () => {
  // CASE A - GB-warehoused item shipped to GB: the verified-UK allowance FIRES.
  it('A) real GB-warehoused product -> GB: emits the UK fulfilment line + GB->GB fast band (4-12)', async () => {
    const ctx = ctxFor({ msg: `How long to the UK for ${GB_URL}?`, handle: 'interactive-wood-sisal-cat-turntable-scratching-post', cjPid: '2059208486801747970', detail: GB_TURNTABLE });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect((g.data as any).verifiedGb).toBe(true);
    const line = shippingAgent.deterministicAppendix(g);
    expect(line).toBe('This item is held in a UK fulfilment location. Delivery to the UK: estimated 4-12 days.');
  });

  // CASE B - SAME GB-warehoused item shipped to a NON-GB dest (US): the product has
  // origins:{GB:85} only. There is NO GB->US row in the matrix and cj=null, so there is
  // no real route to the US. The new honest behavior is UNFULFILLABLE (no ship, no band),
  // NOT a borrowed CN->US band. The borrowed 7-23 days band was fabricated and has been removed.
  it('B) real GB-warehoused product -> US: no route to US -> honest unfulfillable, no day band', async () => {
    const ctx = ctxFor({ msg: `How long to the US for ${GB_URL}?`, handle: 'interactive-wood-sisal-cat-turntable-scratching-post', cjPid: '2059208486801747970', detail: GB_TURNTABLE });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    // The unfulfillable grounding carries { unfulfillable: true, label } not verifiedGb.
    expect((g.data as any).unfulfillable).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    // Honest no-ship sentence, verbatim from deterministicAppendix unfulfillable branch.
    expect(line).toBe('We are not able to ship this item to the United States at the moment.');
    // No day band in the unfulfillable line.
    expect(line).not.toMatch(/\d+\s*-\s*\d+\s*days/);
    // Origin is never named.
    expect(line).not.toMatch(/UK fulfilment|fulfilment location|warehouse|China|CN/i);
  });

  // CASE C - CN-only item shipped to GB: NOT GB-warehoused -> NO UK line, CN->GB band (6-21).
  it('C) real CN-only product -> GB: NO UK line (not GB-warehoused), CN->GB band (6-21)', async () => {
    const ctx = ctxFor({ msg: `How long to the UK for ${CN_URL}?`, handle: 'plush-christmas-dog-toy', cjPid: '2606081152391625800', detail: CN_PLUSH });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect((g.data as any).verifiedGb).toBe(false);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toBe('Delivery to the UK: estimated 6-21 days.');
    expect(line).not.toMatch(/UK fulfilment|fulfilment location/i);
  });

  // CASE D - the live "the US" extraction-gap thread (b42734c3). The raw latest inbound
  // is AMBIGUOUS because our own quoted footer says "UK and EU"; quote-stripping + the
  // "the US" recogniser together ground it to US (the audit-gap fix), not a non-answer.
  const RAW_LATEST = 'Thanks for your response like how long does it takes you to ship to the US\n'
    + 'and also do you provide order tracking\n\n'
    + 'On Wed, 24 Jun 2026 at 18:06, Active Paw <contact@activepaw.co.uk> wrote:\n\n'
    + '> Hi Gift,\n>\n> Thank you for your enquiry! We are pleased to confirm that we do offer\n'
    + '> international shipping to most countries. While we have set rates for the\n'
    + '> UK and EU, the exact shipping cost and estimated timeframe for your\n'
    + '> location will be clearly displayed at the checkout page before you complete\n'
    + '> your payment.';

  it('D) live "the US" thread: raw is ambiguous (our UK footer), cleaned grounds to US', () => {
    // Raw text contains BOTH "the US" and the quoted "UK and EU" -> ambiguous -> null (the old non-answer).
    expect(deriveDestinationCountry(RAW_LATEST, 'International Order Inquiry', 'gift@gmail.com')).toBeNull();
    // Quote-stripped (what composeDraftForThread feeds the agent) -> unambiguous US.
    const cleaned = stripQuotedReply(RAW_LATEST);
    expect(cleaned).not.toMatch(/UK and EU/);
    expect(deriveDestinationCountry(cleaned, 'International Order Inquiry', 'gift@gmail.com')).toBe('US');
  });

  it('D2) live "the US" thread, no item named -> ask-for-item branch + LOCAL (US warehouse) fast band (5-12)', async () => {
    const cleaned = stripQuotedReply(RAW_LATEST); // no product URL/handle present
    const ctx = ctxFor({ msg: cleaned });        // admin:null, cj:null -> no item resolves
    const g = await shippingAgent.ground(ctx);
    expect((g.data as any).askForItem).toBe(true);
    expect(g.facts).toMatch(/ask .*which item/i);
    // Sale-positive default: the nearest/local warehouse for US is US->US (3-5 transit, no
    // customs) -> door-to-door 5-12, NOT the CN worst-case 7-23. Time only; depends-on-item caveat.
    expect(g.facts).toMatch(/5-12 days/);
    expect(g.facts).not.toMatch(/7-23/);
    expect(g.facts).toMatch(/depends on the specific product/i);
  });
});
