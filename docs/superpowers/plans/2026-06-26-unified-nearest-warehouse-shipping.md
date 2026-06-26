# Unified Nearest-Warehouse Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shipping time and cost (inbox inquiries and checkout) resolve from the item's nearest warehouse to the destination, using one shared resolver over CJ's real per-route data, so quote == checkout and unfulfillable routes are honestly blocked.

**Architecture:** One pure `resolveNearestRoute` ranks the candidate `cj_logistics` rows (origin to dest) for a product's stocking warehouses and picks the nearest (domestic first, then cheapest). Both the inbox shipping agent and a nightly Shopify delivery-profile sync call it. The store is on the Basic plan, where CarrierService is unavailable, so the formula is materialized into static per-origin-signature delivery profiles (one per distinct warehouse set), refreshed nightly. A destination with no real route gets no zone, so checkout there is blocked.

**Tech Stack:** TypeScript Cloudflare Worker, D1 (SQLite), Shopify Admin GraphQL (Delivery Profiles), CJ Dropshipping API, vitest, wrangler.

## Global Constraints

- **No em-dash or en-dash anywhere** (code, comments, copy). Use hyphen, colon, or parentheses.
- **quote == checkout:** the agent and the profile sync MUST derive origin/time/cost from the SAME `resolveNearestRoute` over the SAME `cj_logistics` rows. Never quote a number the checkout will not charge.
- **Only real and defensible:** an unknown or missing route degrades to "not available to ship to <country>" (agent) or an omitted zone (checkout). Never fabricate a time or cost, never borrow another product's route.
- **Never claim UK fulfilment / never name the dispatch country** in customer copy (existing rule).
- **TDD:** write the failing test, watch it fail, minimal code, watch it pass, commit. Run the FULL suite (`npx vitest run`) before each commit; keep it green.
- **Console gotcha:** `src/console/page.ts` is one big template literal; after editing it, run `npx vitest run tests/console.test.ts`, and double-escape backslashes (`\\n`) in browser-JS strings.
- **Commit + push after every task** (auto-push is standing). Production actions stay gated: `wrangler deploy`, any live Shopify mutation, and remote D1 writes require explicit owner go (called out per task).
- Existing helpers to reuse (do not reinvent): `doorToDoorBand`, `parseDaysRange`, `resolveLogistics`, `formatBand`, `buildShippingLine` (`src/logistics.ts`, `src/inbox/freight.ts`); `readDeliveryConfig`, `ensureGbLocalProfile`, `syncGbProfileMembership` (`src/shipping/delivery-profile.ts`); `getLogisticsRoute` (`src/tenant-store.ts`).

---

## File Structure

- Create `src/shipping/nearest-route.ts`: the pure `resolveNearestRoute` resolver + `NearestResult` type. One responsibility: rank candidate routes.
- Create `src/shipping/pricing.ts`: `freightUsdToGbp` (USD freight to a GBP rate string with FX + handling). One responsibility: money conversion.
- Modify `src/inbox/agents/shipping.ts`: rewire `resolveItemShipping` to the resolver; add the honest unfulfillable path; delete the CN-default borrowed-row fallback.
- Modify `src/shipping/delivery-profile.ts`: add `restrictGbProfileToUk` (Phase 0); add `buildSignatureZones` + `syncSignatureProfiles` (Phase B, generalizing the existing GB sync).
- Modify `src/tenant-store.ts`: add `listSignatureMemberships()` (signature to product ids) and `listServedRoutes()` helper if needed.
- Modify `src/types.ts`: add Fulfil knobs `shipFx`, `shipHandlingGbp`, `servedCountries`.
- Modify `src/jobs.ts`: replace the GB-only sync call with `syncSignatureProfiles`.
- Modify `src/index.ts` / `src/console/*`: a session-authed trigger + read-only status for the new sync (optional MVP surface).
- Tests under `tests/shipping/`, `tests/agents/`, `tests/`.

---

## Task 1: `restrictGbProfileToUk` zone-deletion helper (Phase 0 logic)

**Files:**
- Modify: `src/shipping/delivery-profile.ts`
- Test: `tests/shipping/delivery-profile.test.ts`

**Interfaces:**
- Consumes: `AdminGraphql`, the existing `GB_LOCAL_PROFILE_NAME`.
- Produces: `restrictGbProfileToUk(admin: AdminGraphql): Promise<{ deletedZoneIds: string[]; profileId: string }>` and a pure `computeNonUkZoneIds(groups: { id: string; zones: { id: string; countryCodes: string[]; restOfWorld: boolean }[] }[]): { locationGroupId: string; zoneIds: string[] }[]`.

- [ ] **Step 1: Write the failing test (pure computation)**

```typescript
// tests/shipping/delivery-profile.test.ts (add)
import { computeNonUkZoneIds } from '../../src/shipping/delivery-profile';

test('computeNonUkZoneIds selects every zone that does not cover GB', () => {
  const groups = [{
    id: 'lg1',
    zones: [
      { id: 'z-uk', countryCodes: ['GB'], restOfWorld: false },
      { id: 'z-eu', countryCodes: ['DE', 'FR'], restOfWorld: false },
      { id: 'z-row', countryCodes: [], restOfWorld: true },
    ],
  }];
  expect(computeNonUkZoneIds(groups)).toEqual([{ locationGroupId: 'lg1', zoneIds: ['z-eu', 'z-row'] }]);
});

test('computeNonUkZoneIds is a no-op when only a UK zone exists', () => {
  const groups = [{ id: 'lg1', zones: [{ id: 'z-uk', countryCodes: ['GB'], restOfWorld: false }] }];
  expect(computeNonUkZoneIds(groups)).toEqual([]); // nothing to delete -> empty (group dropped)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts`
Expected: FAIL ("computeNonUkZoneIds is not a function").

- [ ] **Step 3: Implement the pure helper + the admin wrapper**

```typescript
// src/shipping/delivery-profile.ts (add near the other helpers)

/** Zones in each location group that do NOT cover GB (EU, International, Rest-of-World).
 *  A zone covers GB iff its countryCodes include 'GB'. restOfWorld zones never cover GB
 *  specifically, so they are deletion candidates for a UK-only profile. Groups with no
 *  deletable zone are omitted (so the result is empty when already UK-only). */
export function computeNonUkZoneIds(
  groups: { id: string; zones: { id: string; countryCodes: string[]; restOfWorld: boolean }[] }[]
): { locationGroupId: string; zoneIds: string[] }[] {
  const out: { locationGroupId: string; zoneIds: string[] }[] = [];
  for (const g of groups) {
    const zoneIds = g.zones.filter((z) => !z.countryCodes.includes('GB')).map((z) => z.id);
    if (zoneIds.length) out.push({ locationGroupId: g.id, zoneIds });
  }
  return out;
}

const GB_LOCAL_GROUPS_QUERY = `query pawscoutGbLocalGroups {
  deliveryProfiles(first: 30) {
    edges { node { id name profileLocationGroups {
      locationGroup { id }
      locationGroupZones(first: 50) { edges { node { zone { id name countries { code { countryCode restOfWorld } } } } } }
    } } }
  }
}`;

/** Restrict the existing GB Local profile to UK-only by deleting its non-UK zones (the
 *  wrong mirrored EU/International zones). Idempotent: a no-op when already UK-only.
 *  This stops GB-only items being checkout-able to destinations they cannot reach. */
export async function restrictGbProfileToUk(admin: AdminGraphql): Promise<{ deletedZoneIds: string[]; profileId: string }> {
  const root = (await admin(GB_LOCAL_GROUPS_QUERY)) as any;
  const node = ((root?.deliveryProfiles?.edges ?? []) as any[]).map((e) => e?.node).find((n) => n?.name === GB_LOCAL_PROFILE_NAME);
  if (!node?.id) return { deletedZoneIds: [], profileId: '' };
  const groups = ((node.profileLocationGroups ?? []) as any[]).map((plg) => ({
    id: plg?.locationGroup?.id,
    zones: ((plg?.locationGroupZones?.edges ?? []) as any[]).map((ze) => {
      const z = ze?.node?.zone; const codes: string[] = []; let row = false;
      for (const c of (z?.countries ?? []) as any[]) { if (c?.code?.restOfWorld) row = true; else if (c?.code?.countryCode) codes.push(c.code.countryCode); }
      return { id: z?.id, countryCodes: codes, restOfWorld: row };
    }).filter((z: any) => z.id),
  })).filter((g: any) => g.id);

  const dels = computeNonUkZoneIds(groups);
  if (!dels.length) return { deletedZoneIds: [], profileId: node.id };
  const profile = { locationGroupsToUpdate: dels.map((d) => ({ id: d.locationGroupId, zonesToDelete: d.zoneIds })) };
  const res = (await admin(UPDATE_PROFILE_MUTATION, { id: node.id, profile })) as any;
  const errs = (res?.deliveryProfileUpdate?.userErrors ?? []) as { message?: string }[];
  if (errs.length) throw new Error(`restrictGbProfileToUk failed: ${errs.map((e) => e.message).join('; ')}`);
  return { deletedZoneIds: dels.flatMap((d) => d.zoneIds), profileId: node.id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shipping/delivery-profile.ts tests/shipping/delivery-profile.test.ts
git commit -m "feat(shipping): restrictGbProfileToUk - delete a profile's non-UK zones (Phase 0)"
git push origin master
```

---

## Task 2: Phase 0 live execution + linchpin proof (GATED on owner go)

**Files:**
- Modify: `src/index.ts` (add a session-authed `POST /api/gb-restrict` route that calls `restrictGbProfileToUk` with the tenant admin client, mirroring the existing `/api/gb-sync` route).
- Test: `tests/index` route test if present, else manual.

This task contains a LIVE Shopify mutation and a LIVE checkout test. Do NOT run the live steps without explicit owner go.

- [ ] **Step 1: Add the route (same auth + admin-client construction as `/api/gb-sync`)**

Mirror `/api/gb-sync`: open the tenant, build the admin client via `vault.open(tenant.dek_wrapped, tenant.access_token_enc)` + `makeAdminGraphql`, call `restrictGbProfileToUk(admin)`, return `{ ok: true, deletedZoneIds, profileId }`.

- [ ] **Step 2: Unit-test the route wiring** (mock admin returns a GB Local profile with EU + UK zones; assert the EU zone id is deleted). Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 3: Commit + push.**

- [ ] **Step 4: LIVE (owner go required): deploy + run the restrict.** After `wrangler deploy`, the owner triggers `/api/gb-restrict` from the console. Confirm the GB Local profile now has only the United Kingdom zone (re-query or read in the console).

- [ ] **Step 5: LIVE linchpin proof (Playwright).** With a GB-warehoused product in the cart:
  - Checkout to a UK address: free UK shipping is offered.
  - Checkout to a French address: shipping shows "not available" / checkout is blocked.

  **GATE:** if the French checkout is NOT blocked (it falls through to another profile and still offers a rate), STOP. The static-profile approach is invalid as designed; return to the spec before building Phase B.

---

## Task 3: `resolveNearestRoute` pure resolver (the formula)

**Files:**
- Create: `src/shipping/nearest-route.ts`
- Test: `tests/shipping/nearest-route.test.ts`

**Interfaces:**
- Consumes: `LogisticsRoute` (from `src/logistics.ts`).
- Produces:
```typescript
export interface NearestRoute { origin: string; dest: string; route: LogisticsRoute }
export type NearestResult = { fulfillable: true; nearest: NearestRoute } | { fulfillable: false };
export function resolveNearestRoute(candidates: LogisticsRoute[]): NearestResult;
```
`candidates` are the pre-fetched origin-to-dest `cj_logistics` rows for a single destination (one per stocking warehouse that has a row). The caller fetches them; the resolver only ranks.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/shipping/nearest-route.test.ts
import { resolveNearestRoute } from '../../src/shipping/nearest-route';
import type { LogisticsRoute } from '../../src/logistics';

const row = (from: string, to: string, freight: number | null, tmin = 5, tmax = 9): LogisticsRoute => ({
  from_country: from, to_country: to, channel: '', transit_min: tmin, transit_max: tmax,
  aging_raw: `${tmin}-${tmax}`, freight_cost_usd: freight, synced_at: '2026-06-26T00:00:00Z',
});

test('empty candidates -> not fulfillable', () => {
  expect(resolveNearestRoute([])).toEqual({ fulfillable: false });
});

test('domestic route wins over a cheaper-looking cross-border row', () => {
  const r = resolveNearestRoute([row('CN', 'US', 8.0), row('US', 'US', 0)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'US' } });
});

test('domestic wins even when its freight is unsynced (null)', () => {
  const r = resolveNearestRoute([row('CN', 'GB', 8.99), row('GB', 'GB', null)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'GB' } });
});

test('cross-border only -> cheapest, tie-break shortest transit', () => {
  const r = resolveNearestRoute([row('CN', 'DE', 9.83, 8, 12), row('CN', 'DE', 9.83, 6, 10)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'CN', route: { transit_min: 6 } } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/shipping/nearest-route.test.ts`
Expected: FAIL ("Cannot find module .../nearest-route").

- [ ] **Step 3: Implement**

```typescript
// src/shipping/nearest-route.ts
import type { LogisticsRoute } from '../logistics';

export interface NearestRoute { origin: string; dest: string; route: LogisticsRoute }
export type NearestResult = { fulfillable: true; nearest: NearestRoute } | { fulfillable: false };

/**
 * Pick the nearest warehouse route from pre-fetched candidate rows (all sharing one dest).
 * Ranking: domestic (from === to) first, then cheapest freight (null sorts last), then
 * shortest transit. Domestic is the geographically nearest warehouse and is robust to an
 * unsynced (null) domestic freight. Empty candidates => not fulfillable (honest no-ship).
 * Pure: the caller is responsible for fetching candidates and for quote==checkout by using
 * this same function on both the inquiry and the checkout-profile side.
 */
export function resolveNearestRoute(candidates: LogisticsRoute[]): NearestResult {
  if (!candidates.length) return { fulfillable: false };
  const key = (r: LogisticsRoute): [number, number, number] => [
    r.from_country === r.to_country ? 0 : 1,
    typeof r.freight_cost_usd === 'number' && Number.isFinite(r.freight_cost_usd) ? r.freight_cost_usd : Infinity,
    typeof r.transit_min === 'number' && Number.isFinite(r.transit_min) ? r.transit_min : Infinity,
  ];
  const best = [...candidates].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  })[0];
  return { fulfillable: true, nearest: { origin: best.from_country, dest: best.to_country, route: best } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/shipping/nearest-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shipping/nearest-route.ts tests/shipping/nearest-route.test.ts
git commit -m "feat(shipping): resolveNearestRoute - pure nearest-warehouse route ranker"
git push origin master
```

---

## Task 4: Rewire `resolveItemShipping` to the resolver (Phase A core)

**Files:**
- Modify: `src/inbox/agents/shipping.ts`
- Test: `tests/agents/shipping-agent.test.ts`

**Interfaces:**
- Consumes: `resolveNearestRoute`, `getLogisticsRoute`, `freightQuoteAging`, `CjDetail.origins`.
- Produces (replaces `ItemShipping`):
```typescript
export type ItemShippingResult =
  | { kind: 'resolved'; chosenOrigin: string; route: LogisticsRoute; cjPid: string; repVid: string | null; verifiedGbWarehouse: boolean }
  | { kind: 'unfulfillable'; dest: string; cjPid: string; verifiedGbWarehouse: boolean };
export async function resolveItemShipping(ctx: AgentContext, dest: string): Promise<ItemShippingResult | null>;
```
`null` keeps the existing ask-for-item path (no confident product). `unfulfillable` = a product was identified but no real route to dest exists.

- [ ] **Step 1: Write the failing test (GB-only product to a non-UK dest is unfulfillable, not fabricated)**

```typescript
// tests/agents/shipping-agent.test.ts (add)
test('resolveItemShipping: GB-only product to France resolves unfulfillable (no borrowed CN row)', async () => {
  const ctx = makeCtx({
    latestMessage: 'https://activepaw.co.uk/products/gb-dog-bed how long to France?',
    links: { 'gb-dog-bed': { cj_pid: 'PID-GB' } },
    warehouse: { 'PID-GB': { origins: { GB: 10 }, variants: [{ vid: 'v1', stock: 5 }] } },
    routes: { /* GB->FR absent; only GB->GB exists */ 'GB|GB': route('GB', 'GB', 0) },
    cj: null, // no live fallback
  });
  const r = await resolveItemShipping(ctx, 'FR');
  expect(r).toMatchObject({ kind: 'unfulfillable', dest: 'FR' });
});

test('resolveItemShipping: CN product to Germany resolves via CN (real route)', async () => {
  const ctx = makeCtx({
    latestMessage: 'https://activepaw.co.uk/products/cn-toy delivery to Germany?',
    links: { 'cn-toy': { cj_pid: 'PID-CN' } },
    warehouse: { 'PID-CN': { origins: { CN: 100 }, variants: [{ vid: 'v9', stock: 3 }] } },
    routes: { 'CN|DE': route('CN', 'DE', 9.83, 8, 12) },
    cj: null,
  });
  const r = await resolveItemShipping(ctx, 'DE');
  expect(r).toMatchObject({ kind: 'resolved', chosenOrigin: 'CN' });
});
```

(Use the file's existing `makeCtx`/`route` helpers; mirror their shape. If `makeCtx` lacks a `routes` map, extend the fake store's `getLogisticsRoute` to read one.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents/shipping-agent.test.ts`
Expected: FAIL (current code returns a `resolved`/best-stocked result for the GB-to-FR case).

- [ ] **Step 3: Implement the rewire**

Replace the origin-selection block (`src/inbox/agents/shipping.ts:55-70`) so that, after parsing `origins`:

```typescript
const verifiedGbWarehouse = (origins.GB ?? 0) > 0;
const originCodes = Object.keys(origins).filter((c) => (origins[c] ?? 0) > 0);
const variants = detail.variants ?? [];
const repVid = (variants.find((v) => (v.stock ?? 0) > 0) ?? variants[0])?.vid ?? null;
const l = resolveLogistics(ctx.cfg.fulfil);

// Candidate routes: the matrix row for each stocking warehouse to dest.
const candidates: LogisticsRoute[] = [];
for (const oc of originCodes) {
  const r = await ctx.store.getLogisticsRoute(oc, dest, l.stalenessHours);
  if (r) candidates.push(r);
}
// Live CJ fallback (only when the matrix has nothing): probe each origin to dest.
if (!candidates.length && ctx.cj && repVid) {
  for (const oc of originCodes) {
    try {
      const opts = await ctx.cj.freightQuoteAging(repVid, oc, dest);
      const cheapest = opts.filter((o) => o.days).sort((a, b) => a.priceUsd - b.priceUsd)[0];
      const band = cheapest ? parseDaysRange(cheapest.days) : null;
      if (cheapest && band) candidates.push({
        from_country: oc, to_country: dest, channel: '', transit_min: band.min, transit_max: band.max,
        aging_raw: cheapest.days, freight_cost_usd: cheapest.priceUsd, synced_at: new Date().toISOString(),
      });
    } catch (e) { console.warn(`ship cj probe ${oc}->${dest} failed: ${(e as Error).message}`); }
  }
}

const resolved = resolveNearestRoute(candidates);
if (!resolved.fulfillable) return { kind: 'unfulfillable', dest, cjPid, verifiedGbWarehouse };
return { kind: 'resolved', chosenOrigin: resolved.nearest.origin, route: resolved.nearest.route, cjPid, repVid, verifiedGbWarehouse };
```

Add imports: `resolveNearestRoute` from `../../shipping/nearest-route`; ensure `parseDaysRange`, `resolveLogistics`, `LogisticsRoute` are imported.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agents/shipping-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/agents/shipping.ts tests/agents/shipping-agent.test.ts
git commit -m "feat(inbox): resolveItemShipping uses nearest-warehouse resolver; unfulfillable kind"
git push origin master
```

---

## Task 5: Agent ground() honest unfulfillable + remove CN-default fallback (Phase A copy)

**Files:**
- Modify: `src/inbox/agents/shipping.ts` (`ground`, `deterministicAppendix`)
- Test: `tests/agents/shipping-agent.test.ts`

**Interfaces:**
- Consumes: `ItemShippingResult` (Task 4).
- Produces: a confident reply that states delivery is not available to the destination for an `unfulfillable` item, with NO appended time band; and the existing resolved path now reads `item.route` directly (no line-125 CN-default fallback).

- [ ] **Step 1: Write the failing test**

```typescript
test('ground(): unfulfillable item yields an honest no-ship line, no time band', async () => {
  const ctx = makeCtx({ /* GB-only product, dest FR, as in Task 4 */ });
  const g = await shippingAgent.ground(ctx);
  expect(g.confident).toBe(true);
  expect(g.facts.toLowerCase()).toContain('not available to ship');
  // deterministicAppendix must NOT append a "X-Y days" band for an unfulfillable item.
  const appendix = shippingAgent.deterministicAppendix(g) ?? '';
  expect(appendix).not.toMatch(/\d+\s*-\s*\d+\s*days/i);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/agents/shipping-agent.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** in `ground`, after `const item = await resolveItemShipping(ctx, dest);`:
  - `item === null` -> existing ask-for-item path (unchanged).
  - `item.kind === 'unfulfillable'` -> return a confident grounding whose `facts` instruct an honest, brief "we are not able to ship this item to <countryLabel(dest)>" and offer alternatives; `data: { unfulfillable: true, label: countryLabel(dest) }`; `quotesFigure: false`.
  - `item.kind === 'resolved'` -> `band = doorToDoorBand(item.route, l)`; if `!band` return `notConfidentFacts(dest)`; then the existing verifiedGb/gbFreeUk path, reading from `item.route`. DELETE the live-CJ fallback block and the `SHIP_DEFAULT_ORIGIN` CN-default fallback (lines ~118-125) - resolution now happens entirely in `resolveItemShipping`.
  - In `deterministicAppendix`, when `d.unfulfillable` is set, return the no-ship sentence and NEVER call `buildShippingLine`.

  Remove the now-unused `SHIP_DEFAULT_ORIGIN` constant and its imports if nothing else uses them.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run`. Expected: PASS (whole suite green; check the existing shipping tests still pass after removing the fallback).

- [ ] **Step 5: Commit + push.**

```bash
git add src/inbox/agents/shipping.ts tests/agents/shipping-agent.test.ts
git commit -m "feat(inbox): honest 'cannot ship to <country>' for unfulfillable items; drop CN-default fallback"
git push origin master
```

---

## Task 6: `listSignatureMemberships` accessor (Phase B data)

**Files:**
- Modify: `src/tenant-store.ts`
- Test: `tests/logistics-store.test.ts` (or the store test file used for `listGbWarehousedShopifyProductIds`)

**Interfaces:**
- Produces: `listSignatureMemberships(): Promise<Map<string, string[]>>` mapping a normalized signature (sorted comma-joined origin codes, e.g. `"CN"`, `"CN,US"`, `"GB"`) to the imported+linked Shopify product ids with that signature.

- [ ] **Step 1: Write the failing test** asserting that, given seeded `product_links` (state imported, shopify_product_id set) joined to `warehouse_products.detail` origins, the map groups product ids by sorted-signature (mirror the seeding style already used for `listGbWarehousedShopifyProductIds`).

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/logistics-store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** using the same join as `listGbWarehousedShopifyProductIds`, plus `json_each(json_extract(w.detail, '$.origins'))` filtered to value > 0, grouping per product then bucketing in JS:

```typescript
async listSignatureMemberships(): Promise<Map<string, string[]>> {
  const rs = await this.db.prepare(
    `SELECT l.shopify_product_id AS id, je.key AS origin
       FROM product_links l
       JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
       JOIN json_each(json_extract(w.detail, '$.origins')) je
       WHERE l.shop = ?1 AND l.state = 'imported' AND l.shopify_product_id IS NOT NULL
         AND CAST(je.value AS INTEGER) > 0`
  ).bind(this.shop).all<{ id: string; origin: string }>();
  const perProduct = new Map<string, Set<string>>();
  for (const r of rs.results ?? []) {
    if (!perProduct.has(r.id)) perProduct.set(r.id, new Set());
    perProduct.get(r.id)!.add(r.origin);
  }
  const bySig = new Map<string, string[]>();
  for (const [id, origins] of perProduct) {
    const sig = [...origins].sort().join(',');
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig)!.push(id);
  }
  return bySig;
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run tests/logistics-store.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit + push.**

---

## Task 7: `freightUsdToGbp` + `buildSignatureZones` (Phase B pricing/zones)

**Files:**
- Create: `src/shipping/pricing.ts`
- Modify: `src/shipping/delivery-profile.ts` (add `buildSignatureZones`)
- Test: `tests/shipping/pricing.test.ts`, `tests/shipping/delivery-profile.test.ts`

**Interfaces:**
- Produces:
```typescript
// pricing.ts
export function freightUsdToGbp(usd: number | null | undefined, fxUsdToGbp: number, handlingGbp: number): string;
// delivery-profile.ts
export function buildSignatureZones(
  originCodes: string[], servedCountries: string[],
  lookup: (origin: string, dest: string) => LogisticsRoute | null,
  fx: number, handlingGbp: number
): { name: string; countries: { code: string; includeAllProvinces: true }[]; methodDefinitionsToCreate: unknown[] }[];
```
`buildSignatureZones` builds one country zone per served destination that is fulfillable from this signature (via `resolveNearestRoute` over the looked-up candidate rows), priced from the chosen route's `freight_cost_usd`. Unfulfillable destinations are omitted.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/shipping/pricing.test.ts
import { freightUsdToGbp } from '../../src/shipping/pricing';
test('freightUsdToGbp converts with fx + handling, 2dp', () => {
  expect(freightUsdToGbp(10, 0.8, 0)).toBe('8.00');
  expect(freightUsdToGbp(9.83, 0.82, 0.5)).toBe('8.56'); // 9.83*0.82=8.0606 +0.5 = 8.5606 -> 8.56
  expect(freightUsdToGbp(0, 0.8, 0)).toBe('0.00');      // domestic GB->GB free
  expect(freightUsdToGbp(null, 0.8, 0)).toBe('0.00');   // null freight degrades to 0
});

// tests/shipping/delivery-profile.test.ts
import { buildSignatureZones } from '../../src/shipping/delivery-profile';
test('buildSignatureZones: GB-only signature yields a UK zone only', () => {
  const lookup = (o: string, d: string) => (o === 'GB' && d === 'GB' ? routeRow('GB','GB',0) : null);
  const zones = buildSignatureZones(['GB'], ['GB','DE','US'], lookup, 0.8, 0);
  expect(zones.map((z) => z.name)).toEqual(['GB']);
  expect(zones[0].countries).toEqual([{ code: 'GB', includeAllProvinces: true }]);
});
test('buildSignatureZones: CN signature omits a destination with no route (FR)', () => {
  const lookup = (o: string, d: string) => (o === 'CN' && d === 'DE' ? routeRow('CN','DE',9.83) : null);
  const zones = buildSignatureZones(['CN'], ['DE','FR'], lookup, 0.8, 0);
  expect(zones.map((z) => z.name)).toEqual(['DE']); // FR omitted (unfulfillable)
});
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement**

```typescript
// src/shipping/pricing.ts
/** USD freight to a GBP rate string (2dp) = usd*fx + handling. Null/undefined or non-finite
 *  freight degrades to 0.00 (domestic / unpriced), never NaN. fx and handling come from config. */
export function freightUsdToGbp(usd: number | null | undefined, fxUsdToGbp: number, handlingGbp: number): string {
  const u = typeof usd === 'number' && Number.isFinite(usd) ? usd : 0;
  const gbp = u * fxUsdToGbp + handlingGbp;
  return (Number.isFinite(gbp) ? Math.max(0, gbp) : 0).toFixed(2);
}
```

```typescript
// src/shipping/delivery-profile.ts (add; import resolveNearestRoute + freightUsdToGbp + LogisticsRoute)
export function buildSignatureZones(
  originCodes: string[], servedCountries: string[],
  lookup: (origin: string, dest: string) => LogisticsRoute | null,
  fx: number, handlingGbp: number
) {
  const zones: { name: string; countries: { code: string; includeAllProvinces: true }[]; methodDefinitionsToCreate: unknown[] }[] = [];
  for (const dest of servedCountries) {
    const candidates = originCodes.map((o) => lookup(o, dest)).filter((r): r is LogisticsRoute => !!r);
    const res = resolveNearestRoute(candidates);
    if (!res.fulfillable) continue; // omit -> checkout blocked there (honest)
    const amount = freightUsdToGbp(res.nearest.route.freight_cost_usd, fx, handlingGbp);
    zones.push({
      name: dest,
      countries: [{ code: dest, includeAllProvinces: true }],
      methodDefinitionsToCreate: [{ name: 'Standard', rateDefinition: { price: { amount, currencyCode: 'GBP' } } }],
    });
  }
  return zones;
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run tests/shipping/`. Expected: PASS.

- [ ] **Step 5: Commit + push.**

---

## Task 8: `syncSignatureProfiles` (Phase B sync, generalizes the GB sync)

**Files:**
- Modify: `src/shipping/delivery-profile.ts`
- Test: `tests/shipping/delivery-profile.test.ts`

**Interfaces:**
- Consumes: `listSignatureMemberships` (Task 6), `buildSignatureZones` (Task 7), `getLogisticsRoute`, `readDeliveryConfig`.
- Produces:
```typescript
export function signatureProfileName(sig: string): string; // 'GB' -> 'GB Local'; else `Origin ${sig}`
export async function syncSignatureProfiles(
  admin: AdminGraphql,
  store: { listSignatureMemberships(): Promise<Map<string,string[]>>; getLogisticsRoute(from: string, to: string, staleness: number): Promise<LogisticsRoute|null> },
  opts: { servedCountries: string[]; fx: number; handlingGbp: number; stalenessHours: number }
): Promise<{ profiles: { sig: string; profileId: string; added: number; removed: number; zones: number }[] }>;
```

- [ ] **Step 1: Write the failing test** (mock admin + a fake store) asserting: for memberships `{ 'GB': ['p1'], 'CN': ['p2'] }`, the GB profile is named 'GB Local' with a single UK zone (free), the CN profile has zones only for served destinations with a route, and membership variants are associated. Mirror the existing `syncGbProfileMembership` test's admin mock.

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement.** For each `[sig, productIds]` in memberships:
  - `originCodes = sig.split(',')`.
  - Pre-fetch a route lookup: for each `(origin in originCodes, dest in servedCountries)` call `store.getLogisticsRoute(origin, dest, stalenessHours)` once, memoized into a `Map<"origin|dest", LogisticsRoute|null>`; wrap as `lookup`.
  - `zones = buildSignatureZones(originCodes, servedCountries, lookup, fx, handlingGbp)`.
  - Ensure the profile exists with these computed zones (extend `ensureGbLocalProfile` into a generic `ensureProfile(admin, { name, locationIds, zonesToCreate })`, OR add a sibling that takes pre-built zone inputs). The `{GB}` signature reuses name 'GB Local'. NOTE: zone updates on an EXISTING profile need `deliveryProfileUpdate` with `locationGroupsToUpdate[].{zonesToCreate, zonesToUpdate, zonesToDelete}`; for MVP, reconcile zones by deleting all current zones and recreating from the computed set (small N), or skip zone reconciliation when the profile already exists and only reconcile membership (document the trade-off). Prefer: recreate zones to keep them formula-fresh.
  - Reconcile membership exactly as `syncGbProfileMembership` does (diff `profileItems` vs `productIds`, resolve variant ids, `variantsToAssociate`/`variantsToDissociate`).
  - Reuse the existing bundled-GB safety guard concept where relevant.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run`. Expected: PASS (whole suite).

- [ ] **Step 5: Commit + push.**

---

## Task 9: Config knobs + nightly wiring (Phase B activation)

**Files:**
- Modify: `src/types.ts` (Fulfil knobs), `src/jobs.ts` (replace GB sync with signature sync), `tests/config.test.ts`, `tests/` jobs test if present.

**Interfaces:**
- Produces: `Fulfil.shipFx?: number` (default 0.82), `Fulfil.shipHandlingGbp?: number` (default 0), `Fulfil.servedCountries?: string[]` (default `['GB','US','DE','ES','IT','IE','SE','BE','CA','AU','BR']` plus any product-domestic implied by signatures). Add a `resolveShipConfig(fulfil)` per-field-default helper mirroring `resolveLogistics`.

- [ ] **Step 1: Write the failing test** for `resolveShipConfig` defaults (partial fulfil yields finite fx/handling/servedCountries; never NaN, never empty served list).

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement** the knobs + `resolveShipConfig`; in `src/jobs.ts runDailyMaintenance`, replace the `syncGbProfileMembership(admin, store)` call with:

```typescript
try {
  const sc = resolveShipConfig(cfg.fulfil);
  const l = resolveLogistics(cfg.fulfil);
  await syncSignatureProfiles(admin, store, { servedCountries: sc.servedCountries, fx: sc.fx, handlingGbp: sc.handlingGbp, stalenessHours: l.stalenessHours });
} catch (e) { console.warn(`signature profile sync failed: ${(e as Error).message}`); }
```

Ensure the nightly logistics sync already populates `cj_logistics` for every `(origin in catalog signatures) x (served dest)`; if coverage is missing, extend the existing logistics sync's destination set to include `servedCountries` for each catalog origin (CN, GB, US). Add a focused test that the sync requests those routes.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit + push.**

---

## Task 10: Turn on agent cost-quoting + console status (Phase B finish)

**Files:**
- Modify: `src/inbox/agents/shipping.ts` (quote the static nearest-warehouse cost), `src/console/routes.ts` + `src/console/page.ts` (status), tests accordingly.

**Interfaces:**
- Consumes: `item.route.freight_cost_usd` (resolved), `resolveShipConfig`.
- Produces: the shipping agent, for a `resolved` item, MAY state the cost = `freightUsdToGbp(item.route.freight_cost_usd, fx, handling)` (or "free" when 0.00), which equals the checkout charge because both use the same route + pricing. Console shows per-signature profile status (counts, zones, last sync).

- [ ] **Step 1: Write the failing test** that a resolved CN-to-DE item yields a cost figure in the grounding that equals `freightUsdToGbp` of the route, and a GB-to-UK item yields free.

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement.** Add the cost to the shipping grounding facts/data; keep the "never name the dispatch country" rule. Update `deterministicAppendix` to include the cost line consistently with the band. Surface read-only status in the console (after editing `page.ts`, run `tests/console.test.ts`; double-escape `\\n`).

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run`. Expected: PASS (whole suite).

- [ ] **Step 5: Commit + push.**

- [ ] **Step 6: LIVE (owner go required): deploy + verify.** `wrangler deploy`; trigger the nightly sync once via the console; Playwright-verify a CN item checkout to Germany shows the computed GBP rate equal to what the agent quotes (quote == checkout), and a non-served destination (FR) is blocked.

---

## Self-review notes

- **Spec coverage:** Phase 0 (Tasks 1-2), Phase A (Tasks 3-5), Phase B (Tasks 6-10). Served-countries / mixed-cart / FX are config in Task 9; mixed-cart honest block is an emergent property of per-signature profiles (no code beyond zone omission) plus the agent's unfulfillable copy (Task 5).
- **Type consistency:** `LogisticsRoute` (existing) flows through `resolveNearestRoute` (Task 3) -> `resolveItemShipping` (Task 4) -> `buildSignatureZones` (Task 7) -> `syncSignatureProfiles` (Task 8). `NearestResult.fulfillable` is the single fulfillability signal used by both the agent and the sync.
- **quote == checkout:** Tasks 4, 7, 8, 10 all route cost/time through the same `resolveNearestRoute` + `freightUsdToGbp`; Task 10's live step verifies it.
- **Gated live actions:** Tasks 2, 9 (sync coverage), 10 contain the only production mutations; each is marked owner-go.
