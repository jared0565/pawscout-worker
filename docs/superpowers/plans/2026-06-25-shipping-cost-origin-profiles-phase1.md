# Origin-Aware Shipping Cost - Phase 1 (free UK on GB items) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A UK customer buying a GB-warehoused item pays GBP 0 shipping at checkout, the agent defensibly states "free UK delivery", and CJ freight cost is persisted in the logistics DB - all driven by the worker via a Shopify delivery profile.

**Architecture:** Add `read_shipping`/`write_shipping` scopes (merchant re-auth) so the worker can manage Shopify delivery profiles. The worker reads the live delivery config, creates a "GB Local" profile whose UK rate is free (other zones keep current rates), and assigns GB-warehoused products to it (daily reconcile). The shipping agent gains a deterministic "free UK delivery" clause gated on `verifiedGbWarehouse && dest==='GB'` AND a config flag that is only switched on after a live GBP-0 checkout is verified. A `freight_cost_usd` column on `cj_logistics` persists CJ freight (Phase-2 foundation).

**Tech Stack:** Cloudflare Worker (TypeScript), D1 (SQLite), Shopify Admin GraphQL API (2026-01), Vitest + `@cloudflare/vitest-pool-workers`, wrangler.

## Global Constraints

- No em-dashes or en-dashes anywhere (code, copy, comments); use a comma, full stop, or hyphen. `sanitizeOutbound()` enforces at runtime but author clean.
- Customer-facing statements must equal what Shopify charges at checkout (only-real-and-defensible). The agent must NOT claim free UK shipping before a live GB-item-to-UK checkout is verified at GBP 0.
- "Free UK delivery" states a checkout PRICE; it is not a dispatch-origin claim and must never imply Active Paw ships from the UK. Never name a dispatch country.
- Per-file test runs only (`npx vitest run <file>`); the monolithic suite hits the workerd loopback ceiling.
- D1 migrations are applied to remote via `wrangler d1 execute pawscout --remote --file <path>` (NOT `migrations apply` - the tracker is out of sync on this DB).
- Commit after every green step; push after every commit (standing auto-push). Production `wrangler deploy` and merchant re-auth stay gated on explicit owner go.
- GB-warehoused = a `warehouse_products` row whose cached `detail.origins.GB > 0`.

---

### Task 1: Add shipping scopes + re-auth (gating, owner action)

**Files:**
- Modify: `wrangler.toml` (the `SHOPIFY_SCOPES` var)

**Interfaces:**
- Produces: an app session granted `read_shipping` + `write_shipping`, so `deliveryProfiles` queries and `deliveryProfileCreate`/`Update` mutations stop returning ACCESS_DENIED. Later tasks depend on this.

- [ ] **Step 1: Add the scopes to wrangler.toml**

Append `,read_shipping,write_shipping` to the `SHOPIFY_SCOPES` string (keep all existing scopes; order is irrelevant, Shopify dedups).

- [ ] **Step 2: Deploy (gated on owner go)**

Run: `npx wrangler deploy`
Expected: deploy succeeds; bindings + crons + custom domain intact.

- [ ] **Step 3: Merchant re-auth (owner action)**

Owner opens `https://pawscout.activepaw.co.uk/auth?shop=4qkudm-ez.myshopify.com` (or the app in Shopify admin) and approves the new shipping permissions.

- [ ] **Step 4: Verify the grant**

Run (from `F:/Projects/Shopify/demo-store2`):
`python -c "import shopify_admin as s; print(s.admin_graphql('{ deliveryProfiles(first:3){edges{node{id name default}}} }'))"`
Expected: returns profiles (at least the default), NOT `ACCESS_DENIED`. Also confirm D1 `tenants.scopes` now lists `read_shipping`/`write_shipping`.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml
git commit -m "feat(shipping): add read_shipping/write_shipping scopes for delivery profiles"
```

---

### Task 2: Persist CJ freight cost in the logistics DB

**Files:**
- Create: `migrations/0018_logistics_freight_cost.sql`
- Modify: `src/tenant-store.ts` (`upsertLogisticsRoute`, `getLogisticsRoute` / the row mapping)
- Modify: `src/logistics.ts` (`LogisticsRoute` interface)
- Modify: the logistics sync that calls CJ (`src/jobs.ts` or wherever `upsertLogisticsRoute` is fed; the freight quote already returns `priceUsd`)
- Test: `tests/inbox-freight.test.ts` or `tests/logistics.test.ts` (whichever holds the route-store tests) + `tests/warehouse.test.ts` pattern for D1

**Interfaces:**
- Consumes: existing `freightQuoteAging(vid,from,to)` returning `{ priceUsd, days, name }[]` (cheapest first).
- Produces: `cj_logistics.freight_cost_usd REAL` (nullable); `LogisticsRoute.freight_cost_usd: number | null`; `upsertLogisticsRoute` accepts `freightCostUsd?: number | null`.

- [ ] **Step 1: Write the migration**

`migrations/0018_logistics_freight_cost.sql`:
```sql
ALTER TABLE cj_logistics ADD COLUMN freight_cost_usd REAL;
```

- [ ] **Step 2: Apply to remote D1 (gated on owner go for the remote write)**

Run: `npx wrangler d1 execute pawscout --remote --file migrations/0018_logistics_freight_cost.sql`
Expected: success; column present. (For local tests, the test harness applies migrations from `TEST_MIGRATIONS`.)

- [ ] **Step 3: Write the failing test**

In the logistics-store test file:
```ts
it('persists and returns the CJ freight cost on a route', async () => {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'US', channel: 'LuWei', transitMin: 5, transitMax: 11, agingRaw: '5-11', repVid: 'v1', freightCostUsd: 6.05 });
  const r = await store.getLogisticsRoute('CN', 'US', 72, Date.parse('2026-06-25T05:00:00Z'));
  expect(r?.freight_cost_usd).toBe(6.05);
});
```

- [ ] **Step 4: Run it - verify it fails**

Run: `npx vitest run <that test file> -t "persists and returns the CJ freight cost"`
Expected: FAIL (column/param missing).

- [ ] **Step 5: Implement**

In `upsertLogisticsRoute`: add `freightCostUsd?: number | null` to the param type; include `freight_cost_usd` in the INSERT column list + bind (`?N`), and in the `ON CONFLICT ... DO UPDATE SET` clause (`freight_cost_usd = ?N`). In `getLogisticsRoute`'s SELECT, add `freight_cost_usd`. In `LogisticsRoute` (logistics.ts) add `freight_cost_usd: number | null`. In the sync call site, pass the cheapest option's `priceUsd` as `freightCostUsd`.

- [ ] **Step 6: Run tests - verify pass + tsc**

Run: `npx vitest run <that test file>` then `npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add migrations/0018_logistics_freight_cost.sql src/tenant-store.ts src/logistics.ts src/jobs.ts tests/
git commit -m "feat(logistics): persist CJ freight cost per route (Phase-2 foundation)"
```

---

### Task 3: Read + snapshot the live Shopify delivery config (spike)

**Files:**
- Create: `src/shipping/delivery-profile.ts` (start the module: a `readDeliveryConfig(admin)` function)
- Test: `tests/shipping/delivery-profile.test.ts`

**Interfaces:**
- Consumes: `AdminGraphql` (the worker's Shopify client) from `src/shopify-admin.ts`.
- Produces: `readDeliveryConfig(admin): Promise<{ defaultProfileId: string; locationGroups: {id:string; locationIds:string[]}[]; ukZonePresent: boolean; locations: {id:string; name:string; country:string}[] }>` - the real structure later tasks build against (location group IDs, whether a UK zone exists in the default profile).

- [ ] **Step 1: Write the failing test (mocked admin)**

```ts
it('reads the default profile id and location groups', async () => {
  const admin = vi.fn().mockResolvedValue({ deliveryProfiles: { edges: [{ node: { id: 'gid://shopify/DeliveryProfile/1', default: true,
    profileLocationGroups: [{ locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/9', locations: { nodes: [{ id: 'gid://shopify/Location/5', name: 'Main', address: { country: 'United Kingdom' } }] } } }] } }] } });
  const cfg = await readDeliveryConfig(admin as any);
  expect(cfg.defaultProfileId).toBe('gid://shopify/DeliveryProfile/1');
  expect(cfg.locationGroups[0].id).toBe('gid://shopify/DeliveryLocationGroup/9');
});
```

- [ ] **Step 2: Run it - verify it fails**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts -t "reads the default profile"`
Expected: FAIL (function not defined).

- [ ] **Step 3: Implement `readDeliveryConfig`**

Query: `{ deliveryProfiles(first:10){edges{node{id default profileLocationGroups{locationGroup{id locations(first:50){nodes{id name address{country}}}}}}}}}`. Map to the Produces shape; `defaultProfileId` = the node with `default:true`. Keep it defensive (empty arrays on missing fields).

- [ ] **Step 4: Run tests - verify pass**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Snapshot the LIVE config (record for Task 4)**

Run (from `F:/Projects/Shopify/demo-store2`, needs Task 1 scope):
`python -c "import shopify_admin as s,json; print(json.dumps(s.admin_graphql('{ deliveryProfiles(first:10){edges{node{id name default profileLocationGroups{locationGroup{id locations(first:50){nodes{id name address{country}}}} locationGroupZones(first:50){edges{node{zone{id name countries{code{countryCode}}} methodDefinitions(first:10){edges{node{name rateProvider{... on DeliveryRateDefinition{price{amount currencyCode}}}}}}}}}}}}}'),indent=2))" > .tmp-delivery-config.json`
Record the real default profile id, the UK location group id, and the current UK rate in the plan-execution notes (these are the inputs to Task 4). Confirm whether GB-warehoused products currently sit in the default profile.

- [ ] **Step 6: Commit**

```bash
git add src/shipping/delivery-profile.ts tests/shipping/delivery-profile.test.ts
git commit -m "feat(shipping): read live Shopify delivery config (delivery-profile module)"
```

---

### Task 4: Create the "GB Local" delivery profile (UK free)

**Files:**
- Modify: `src/shipping/delivery-profile.ts` (`ensureGbLocalProfile`)
- Test: `tests/shipping/delivery-profile.test.ts`

**Interfaces:**
- Consumes: `readDeliveryConfig`, `AdminGraphql`, the GB location group id from the snapshot.
- Produces: `ensureGbLocalProfile(admin, opts:{ ukRateAmount:string; gbLocationGroupId:string }): Promise<{ profileId:string }>` - idempotent (returns the existing "GB Local" profile if already present, else creates it). EU/World zones mirror the current default rates (read from the snapshot).

- [ ] **Step 1: Write the failing test (mocked create)**

```ts
it('creates the GB Local profile with a free UK rate when absent', async () => {
  const calls: any[] = [];
  const admin = vi.fn().mockImplementation((q: string) => {
    calls.push(q);
    if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [] } }); // none named "GB Local"
    if (q.includes('deliveryProfileCreate')) return Promise.resolve({ deliveryProfileCreate: { profile: { id: 'gid://shopify/DeliveryProfile/77' }, userErrors: [] } });
    return Promise.resolve({});
  });
  const r = await ensureGbLocalProfile(admin as any, { ukRateAmount: '0.00', gbLocationGroupId: 'gid://shopify/DeliveryLocationGroup/9' });
  expect(r.profileId).toBe('gid://shopify/DeliveryProfile/77');
  expect(calls.some(q => q.includes('deliveryProfileCreate'))).toBe(true);
});
```

- [ ] **Step 2: Run it - verify it fails**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts -t "creates the GB Local profile"`
Expected: FAIL.

- [ ] **Step 3: Implement `ensureGbLocalProfile`**

Look up a profile named "GB Local"; if found, return its id (idempotent). Else call `deliveryProfileCreate` with:
```
profile: {
  name: "GB Local",
  locationGroupsToCreate: [{
    locationsToAdd: [<GB location id(s) from snapshot>],
    zonesToCreate: [
      { name: "United Kingdom", countries: { code: "GB" }, methodDefinitionsToCreate: [{ name: "Standard", rateDefinition: { price: { amount: ukRateAmount, currencyCode: "GBP" } } }] },
      { name: "Europe", countries: [...EU codes...], methodDefinitionsToCreate: [{ name: "Standard", rateDefinition: { price: { amount: "14.99", currencyCode: "GBP" } } }] },
      { name: "Rest of World", countries: { code: "REST_OF_WORLD" }, methodDefinitionsToCreate: [{ name: "Standard", rateDefinition: { price: { amount: "23.99", currencyCode: "GBP" } } }] }
    ]
  }]
}
```
Check `userErrors`; throw on non-empty. (Exact EU code list + REST_OF_WORLD handling locked from the Task-3 snapshot of the default profile's zones.)

- [ ] **Step 4: Run tests - verify pass + tsc**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/shipping/delivery-profile.ts tests/shipping/delivery-profile.test.ts
git commit -m "feat(shipping): ensure GB Local delivery profile (free UK rate), idempotent"
```

---

### Task 5: Assign GB-warehoused products + daily reconcile

**Files:**
- Modify: `src/shipping/delivery-profile.ts` (`syncGbProfileMembership`)
- Modify: `src/tenant-store.ts` (a `listGbWarehousedShopifyProductIds()` accessor: product_links joined to warehouse_products where `detail` has GB origin and `shopify_product_id` not null and state imported)
- Modify: `src/jobs.ts` (`runDailyMaintenance` - call `syncGbProfileMembership`)
- Test: `tests/shipping/delivery-profile.test.ts`, `tests/warehouse.test.ts` (the accessor)

**Interfaces:**
- Consumes: `ensureGbLocalProfile`, the GB-products accessor, `AdminGraphql`.
- Produces: `syncGbProfileMembership(admin, store): Promise<{ added:number; removed:number }>` - associates GB-warehoused variants with the GB Local profile and removes ones no longer GB-stocked. Uses `deliveryProfileUpdate` with `variantsToAssociate` / `variantsToDissociate` (field names confirmed against the live schema in Task 3's snapshot; if the schema uses product-level association, adapt to `productsToAssociate`).

- [ ] **Step 1: Write the failing test (accessor)**

```ts
it('lists GB-warehoused imported shopify product ids', async () => {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.putWarehouseProduct({ cjPid: 'G1', category: 'pet-toys', title: 'Cat Tree', detailJson: JSON.stringify({ origins: { GB: 40 } }), priceUsd: 10, listedNum: 5, stock: 40 });
  await store.putLink({ cjPid: 'G1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'cat-tree' });
  await store.putWarehouseProduct({ cjPid: 'C1', category: 'pet-toys', title: 'CN Toy', detailJson: JSON.stringify({ origins: { CN: 99 } }), priceUsd: 8, listedNum: 5, stock: 99 });
  await store.putLink({ cjPid: 'C1', state: 'imported', shopifyProductId: 'gid://shopify/Product/2', handle: 'cn-toy' });
  const ids = await store.listGbWarehousedShopifyProductIds();
  expect(ids).toEqual(['gid://shopify/Product/1']);
});
```

- [ ] **Step 2: Run it - verify it fails**

Run: `npx vitest run tests/warehouse.test.ts -t "lists GB-warehoused"`
Expected: FAIL.

- [ ] **Step 3: Implement the accessor**

`listGbWarehousedShopifyProductIds()`: `SELECT l.shopify_product_id FROM product_links l JOIN warehouse_products w ON w.shop=l.shop AND w.cj_pid=l.cj_pid WHERE l.shop=?1 AND l.state='imported' AND l.shopify_product_id IS NOT NULL AND w.detail LIKE '%"GB"%'`. (The `LIKE '%"GB"%'` matches the cached origins JSON; mirror the existing GB-detection used elsewhere.)

- [ ] **Step 4: Run accessor test - verify pass**

Run: `npx vitest run tests/warehouse.test.ts -t "lists GB-warehoused"`
Expected: PASS.

- [ ] **Step 5: Write the membership-sync test (mocked admin)**

```ts
it('associates GB variants and reports counts', async () => {
  const admin = vi.fn().mockImplementation((q: string) => {
    if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [{ node: { id: 'gid://shopify/DeliveryProfile/77', name: 'GB Local', profileItems: { edges: [] } } }] } });
    if (q.includes('deliveryProfileUpdate')) return Promise.resolve({ deliveryProfileUpdate: { profile: { id: 'gid://shopify/DeliveryProfile/77' }, userErrors: [] } });
    return Promise.resolve({});
  });
  const store = new TenantStore(env.DB, 'a.myshopify.com'); /* seed one GB product as in Step 1 */
  const r = await syncGbProfileMembership(admin as any, store);
  expect(r.added).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 6: Run it - verify it fails, then implement**

Run: `npx vitest run tests/shipping/delivery-profile.test.ts -t "associates GB variants"` (FAIL), then implement `syncGbProfileMembership`: read current profile items, diff against `listGbWarehousedShopifyProductIds()`, `deliveryProfileUpdate` to associate new + dissociate gone, check `userErrors`. Wire a call into `runDailyMaintenance` (jobs.ts). Re-run: PASS.

- [ ] **Step 7: tsc + commit**

Run: `npx tsc --noEmit`
```bash
git add src/shipping/delivery-profile.ts src/tenant-store.ts src/jobs.ts tests/
git commit -m "feat(shipping): assign GB-warehoused products to GB Local profile + daily reconcile"
```

---

### Task 6: Agent grounding - "free UK delivery" (gated)

**Files:**
- Modify: `src/inbox/agents/shipping.ts` (deterministicAppendix + the grounding data; read a config flag)
- Modify: `src/types.ts` (Fulfil/Inbox config: add `gbFreeUkLive: boolean` default false) and `src/inbox/agents/types.ts` if the flag is threaded via ctx.cfg
- Test: `tests/agents/shipping-agent.test.ts`, `tests/agents/shipping-prod-proof.test.ts`

**Interfaces:**
- Consumes: existing `verifiedGbWarehouse` + `dest` in `shipping.ts`; a new config flag `cfg.fulfil.gbFreeUkLive` (default false).
- Produces: when `verifiedGbWarehouse && dest==='GB' && gbFreeUkLive`, the appendix includes "with free UK delivery"; otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds free UK delivery for a GB item to GB when the flag is ON', async () => {
  // ctx with verifiedGbWarehouse item, dest GB, cfg.fulfil.gbFreeUkLive = true
  const g = await shippingAgent.ground(ctx);
  const line = shippingAgent.deterministicAppendix(g)!;
  expect(line).toMatch(/free UK delivery/i);
});
it('does NOT mention free UK delivery when the flag is OFF', async () => {
  // same but gbFreeUkLive = false
  const line = shippingAgent.deterministicAppendix(g)!;
  expect(line).not.toMatch(/free UK delivery/i);
});
it('never adds free UK delivery for a CN item or a non-GB dest', async () => { /* both negative cases */ });
```

- [ ] **Step 2: Run - verify they fail**

Run: `npx vitest run tests/agents/shipping-agent.test.ts -t "free UK delivery"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Thread `gbFreeUkLive` into the grounding `data` (set in `ground()` from `ctx.cfg.fulfil.gbFreeUkLive`). In `deterministicAppendix`, when `d.verifiedGb && d.gbFreeUk`, prefix/append "This item ships with free UK delivery." next to the existing UK-fulfilment + time line. Keep it time-only and origin-free; em-dash-free. Default flag false in `DEFAULT_FULFIL`.

- [ ] **Step 4: Run tests - verify pass + tsc**

Run: `npx vitest run tests/agents/shipping-agent.test.ts tests/agents/shipping-prod-proof.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/agents/shipping.ts src/types.ts tests/
git commit -m "feat(inbox): agent states free UK delivery for GB-to-UK, gated on gbFreeUkLive flag"
```

---

### Task 7: Console - GB profile status + margin tradeoff

**Files:**
- Modify: `src/console/page.ts` (a small panel)
- Modify: `src/index.ts` + `src/inbox/routes.ts` (or a status route) to expose GB-profile status (member count) + the flag
- Test: `tests/console.test.ts`

**Interfaces:**
- Consumes: the GB profile id + member count (from a status call), `cfg.fulfil.gbFreeUkLive`.
- Produces: a console panel showing "GB Local profile: active, N products, free UK shipping" and the per-order tradeoff note (item margin vs GBP 4.99 forgone), plus a control to toggle `gbFreeUkLive` (the verify-then-flip gate).

- [ ] **Step 1: Write the failing console test**

Assert the rendered consolePage string contains the GB-profile panel markers and the toggle id. (Follow the existing console.test.ts template-literal assertion pattern; double-escape backslashes in any browser-JS strings per the console-page gotcha.)

- [ ] **Step 2: Run - verify it fails, implement, verify pass**

Run: `npx vitest run tests/console.test.ts` (FAIL -> implement panel + route -> PASS).

- [ ] **Step 3: tsc + commit**

Run: `npx tsc --noEmit`
```bash
git add src/console/page.ts src/index.ts src/inbox/routes.ts tests/console.test.ts
git commit -m "feat(console): GB Local profile status + free-UK margin tradeoff + flag toggle"
```

---

### Task 8: Live verification + flip the flag (owner-gated)

**Files:** none (operational), plus a short note appended to the spec's success-criteria.

**Interfaces:**
- Consumes: everything above, deployed.

- [ ] **Step 1: Deploy (gated on owner go)**

Run: `npx wrangler deploy`. Verify liveness (`/unsubscribe` -> 400) + crons intact.

- [ ] **Step 2: Create the profile + assign members (one-off trigger or wait for daily cron)**

Confirm via `deliveryProfiles` query (admin) that "GB Local" exists with a GBP 0 UK rate and the GB products are members.

- [ ] **Step 3: Verify GBP 0 at checkout**

On the storefront, add a GB-warehoused product, set a UK address, confirm shipping shows GBP 0. Add a CN product, confirm it still shows the flat rate. (A draft order via Admin API is an acceptable alternative check.)

- [ ] **Step 4: Flip the flag**

Only after Step 3 passes: set `cfg.fulfil.gbFreeUkLive = true` (console toggle). The agent now states "free UK delivery" for GB-to-UK.

- [ ] **Step 5: Functional proof (HITL)**

Insert a tagged GB-item UK shipping thread (or Regenerate one); confirm the draft says "free UK delivery" and matches checkout. Delete the tagged rows. Update the backlog memory entry.

---

## Self-Review

**Spec coverage:** Step 0 verify-config -> Task 3. CJ cost in DB -> Task 2. GB Local profile -> Task 4. Product assignment + reconcile -> Task 5. Agent grounding (gated) -> Task 6. Console -> Task 7. Defensibility ordering (verify before flag) -> Tasks 6 (flag default off) + 8 (flip after verify). Scope/re-auth dependency -> Task 1. Multi-warehouse edge -> Task 5 reconcile (drops non-GB-stocked). All spec sections covered.

**Placeholder scan:** Concrete code/commands in each step. The two genuinely API-shape-dependent details (the exact EU country code list / REST_OF_WORLD zone, and `variantsToAssociate` vs `productsToAssociate`) are explicitly locked from the Task-3 live snapshot, which is the correct way to resolve them - not a placeholder but a read-then-build dependency inherent to Shopify's per-merchant delivery config.

**Type consistency:** `freightCostUsd` (param) -> `freight_cost_usd` (column/row field) consistent. `gbFreeUkLive` flag name consistent across Tasks 6/7/8. `ensureGbLocalProfile`/`syncGbProfileMembership`/`readDeliveryConfig` names consistent across Tasks 3-5.
