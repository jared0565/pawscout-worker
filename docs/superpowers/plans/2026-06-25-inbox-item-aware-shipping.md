# Item-Aware Nearest-Warehouse Shipping Answers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox shipping agent answer "how long is shipping?" per specific item, using the nearest in-stock warehouse, with a live-CJ fallback when the D1 matrix lacks that origin→destination route — and allow a per-SKU verified "UK fulfilment location" line.

**Architecture:** Extend the existing `shippingAgent` (`src/inbox/agents/shipping.ts`). Its `resolveProductOrigin` already resolves the product and prefers the in-market warehouse; the gaps are (a) the `cj_logistics` matrix is CN-origin only, so a resolved nearer origin (e.g. GB) has no route row and silently falls back to CN — we add a single live `cj.freightQuoteAging` fallback for the resolved origin→dest; (b) no verified-UK wording; (c) no "ask which item" when none resolves; (d) `deriveDestinationCountry` misses bare "the US". We thread a `cj` client into `AgentContext` and reuse `resolveLineRequest`, `getWarehouseProduct`, `getLogisticsRoute`, `doorToDoorBand`, `bandFromQuote`, `buildShippingLine`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, vitest (`@cloudflare/vitest-pool-workers`), the CJ Admin/freight client (`src/cj.ts`), Shopify Admin GraphQL.

## Global Constraints

- **No em/en-dash or horizontal bar** anywhere (code or customer copy); use a hyphen. `sanitizeOutbound()` enforces at runtime but do not introduce them. [[no-em-dash]]
- **Never name the dispatch origin** in customer copy, and **never** a blanket "Active Paw ships from the UK". The only origin-adjacent wording allowed: a per-SKU "UK fulfilment location" line, gated on `verifiedGbWarehouse === true` from real `origins.GB` stock. All non-GB items: delivery time only. [[no-uk-fulfilment-claim]]
- **Customer-facing numbers must be grounded** — conservative door-to-door bands only, never fabricated. Any resolution miss degrades to the existing hedge; never throw, never emit NaN. [[customer-facing-only-real-defensible]]
- Tests run per-file or in 2-3 file batches (`npx vitest run tests/<file>`); a monolithic `vitest run` hits the workerd loopback ceiling in-sandbox. `npx tsc --noEmit` must stay clean.
- Spec: `docs/superpowers/specs/2026-06-25-inbox-item-aware-shipping-design.md`.

---

## File Structure

- `src/inbox/freight.ts` — modify `deriveDestinationCountry` (add US shorthand). Existing.
- `src/inbox/agents/types.ts` — add `cj: CjClient | null` to `AgentContext`. Existing.
- `src/inbox/sweep.ts` — construct and pass `cj` when assembling `AgentContext` (line ~300). Existing.
- `src/inbox/agents/shipping.ts` — replace `resolveProductOrigin` with `resolveItemShipping`; add live-CJ fallback, verified-UK wording, and ask-for-item grounding. Existing.
- `src/tenant-store.ts` — add `getLinkByHandle(handle)` accessor (URL/handle signal). Existing.
- Tests: `tests/inbox-freight.test.ts`, `tests/agents/shipping-origin.test.ts`, `tests/agents/shipping-agent.test.ts`. Existing.

Deferred (per spec): the order-line item signal (signal 2) is **out of scope for v1** — `resolveLineRequest` (free-text confident match) + URL/handle cover the high-confidence cases.

---

## Task 1: `deriveDestinationCountry` recognises "the US" / "U.S." / "U.S.A."

**Files:**
- Modify: `src/inbox/freight.ts` (`deriveDestinationCountry`, ~line 88-124)
- Test: `tests/inbox-freight.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `deriveDestinationCountry(conversation, subject, email)` still returns `string | null`; it now resolves US-shorthand tokens that the bare-"us" pronoun guard previously dropped.

- [ ] **Step 1: Write the failing tests**

Add to `tests/inbox-freight.test.ts`:

```typescript
import { deriveDestinationCountry } from '../src/inbox/freight';

describe('deriveDestinationCountry US shorthand', () => {
  it('resolves "the US" to US', () => {
    expect(deriveDestinationCountry('how long to ship to the US?', '', 'a@b.com')).toBe('US');
  });
  it('resolves "U.S." and "U.S.A." to US', () => {
    expect(deriveDestinationCountry('delivery to the U.S. please', '', 'a@b.com')).toBe('US');
    expect(deriveDestinationCountry('I am in the U.S.A.', '', 'a@b.com')).toBe('US');
  });
  it('does NOT match the bare pronoun "us"', () => {
    expect(deriveDestinationCountry('please let us know the timeframe', '', 'a@b.com')).toBeNull();
  });
  it('still resolves named countries and GB (regression)', () => {
    expect(deriveDestinationCountry('shipping to Germany', '', 'a@b.com')).toBe('DE');
    expect(deriveDestinationCountry('delivery to the UK', '', 'a@b.com')).toBe('GB');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/inbox-freight.test.ts -t "US shorthand"`
Expected: FAIL — "the US" returns `null` (bare "us" not matched today).

- [ ] **Step 3: Implement the guarded US-shorthand branch**

In `src/inbox/freight.ts`, inside `deriveDestinationCountry`, the function builds `const text = \`${subject}\n${conversation}\`.toLowerCase();`. Add a raw-case copy and a guarded check that adds `US` to `found` BEFORE the `found.size` checks. Insert right after the `ukNamed` / `if (ukNamed) found.add('GB');` block:

```typescript
  // US shorthand: match "U.S."/"U.S.A." (periods = unambiguous) and the phrase
  // "the US"/"the U.S." case-insensitively, plus an UPPERCASE bare "US"/"USA" in
  // the original text. The lowercase pronoun "us" ("let us know") must NOT match,
  // which is why COUNTRY_NAMES deliberately omits a bare "us" key.
  const rawText = `${subject}\n${conversation}`;
  const usShorthand =
    /\bu\.s\.(?:a\.?)?/i.test(rawText) ||           // U.S. / U.S.A.
    /\bthe\s+us\b/i.test(rawText) ||                // the US
    /\bUS\b/.test(rawText) || /\bUSA\b/.test(rawText); // UPPERCASE US/USA (case-sensitive)
  if (usShorthand) found.add('US');
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/inbox-freight.test.ts`
Expected: PASS (all US-shorthand cases + regression cases green).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean)

```bash
git add src/inbox/freight.ts tests/inbox-freight.test.ts
git commit -m "fix(inbox): deriveDestinationCountry resolves 'the US'/'U.S.' (audit gap)"
```

---

## Task 2: `getLinkByHandle` accessor

**Files:**
- Modify: `src/tenant-store.ts`
- Test: `tests/inbox-store.test.ts` (or the existing tenant-store test file; use whichever already imports `TenantStore` — confirm with `npx vitest run` on it)

**Interfaces:**
- Consumes: the existing `product_links` table (columns `shop, cj_pid, shopify_product_id, handle, category, state, ...`).
- Produces: `TenantStore.getLinkByHandle(handle: string): Promise<ProductLink | null>` — returns the link row for a handle (any state), or null.

- [ ] **Step 1: Write the failing test**

```typescript
it('getLinkByHandle returns the link for a handle, else null', async () => {
  const store = new TenantStore(env.DB, SHOP);
  await store.putLink({ cjPid: 'P9', state: 'imported', shopifyProductId: 'gid://shopify/Product/9', category: 'pet-toys', handle: 'cat-fountain' });
  const hit = await store.getLinkByHandle('cat-fountain');
  expect(hit?.cj_pid).toBe('P9');
  expect(await store.getLinkByHandle('nope')).toBeNull();
});
```

(If `putLink` does not currently accept `handle`, pass it through — check its signature first with `grep -n "async putLink" src/tenant-store.ts`. If `handle` is not a `putLink` field, insert the row directly via `env.DB.prepare(...)` in the test instead.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/inbox-store.test.ts -t "getLinkByHandle"`
Expected: FAIL — "getLinkByHandle is not a function".

- [ ] **Step 3: Implement the accessor**

Mirror the existing `getLinkByShopifyProductId`. Add to `TenantStore`:

```typescript
  /** Look up a product link by its storefront handle (URL/handle item signal). */
  async getLinkByHandle(handle: string): Promise<ProductLink | null> {
    const rs = await this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND handle = ?2 LIMIT 1`)
      .bind(this.shop, handle)
      .first<ProductLink>();
    return rs ?? null;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/inbox-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/tenant-store.ts tests/inbox-store.test.ts
git commit -m "feat(store): getLinkByHandle accessor for URL/handle item resolution"
```

---

## Task 3: `resolveItemShipping` — item + nearest origin + verified-GB + representative vid

**Files:**
- Modify: `src/inbox/agents/shipping.ts` (replace `resolveProductOrigin`)
- Test: `tests/agents/shipping-origin.test.ts`

**Interfaces:**
- Consumes: `AgentContext` (Task 5 adds `cj`, not needed here); `resolveLineRequest(admin, query)`; `store.getLinkByHandle` (Task 2); `store.getLinkByShopifyProductId`; `store.getWarehouseProduct`; `CjDetail` (`{ origins?: Record<string,number>; variants?: { vid: string; stock: number }[] }`).
- Produces:
  ```typescript
  export interface ItemShipping {
    chosenOrigin: string;          // nearest in-stock warehouse country for dest
    cjPid: string;
    repVid: string | null;         // a representative in-stock variant id for a CJ quote
    verifiedGbWarehouse: boolean;  // origins.GB stock > 0 (real, never assumed)
  }
  export async function resolveItemShipping(ctx: AgentContext, dest: string): Promise<ItemShipping | null>;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/agents/shipping-origin.test.ts` (follow the file's existing fake-`ctx` pattern — a fake `store` with `getLinkByHandle`/`getLinkByShopifyProductId`/`getWarehouseProduct`, and a fake `admin`):

```typescript
import { resolveItemShipping } from '../../src/inbox/agents/shipping';

it('URL/handle signal -> verified GB warehouse + in-market origin', async () => {
  const detail = JSON.stringify({ origins: { GB: 40, CN: 500 }, variants: [{ vid: 'V1', stock: 40 }] });
  const ctx = fakeCtx({
    latestMessage: 'how long to deliver activepaw.co.uk/products/cat-fountain to me?',
    links: { 'cat-fountain': { cj_pid: 'P1' } },
    warehouse: { P1: { detail } },
  });
  const r = await resolveItemShipping(ctx, 'GB');
  expect(r).toEqual({ chosenOrigin: 'GB', cjPid: 'P1', repVid: 'V1', verifiedGbWarehouse: true });
});

it('free-text confident match -> best-stocked origin when dest not stocked', async () => {
  const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'V2', stock: 500 }] });
  const ctx = fakeCtx({
    latestMessage: 'shipping time for the dog ball launcher?',
    resolveLine: { status: 'resolved', variant: { productId: 'gid://shopify/Product/2' } },
    linksByPid: { 'gid://shopify/Product/2': { cj_pid: 'P2' } },
    warehouse: { P2: { detail } },
  });
  const r = await resolveItemShipping(ctx, 'US');
  expect(r?.chosenOrigin).toBe('CN');
  expect(r?.verifiedGbWarehouse).toBe(false);
});

it('returns null on ambiguous/no item or missing warehouse data', async () => {
  expect(await resolveItemShipping(fakeCtx({ resolveLine: { status: 'ambiguous' } }), 'GB')).toBeNull();
  expect(await resolveItemShipping(fakeCtx({ resolveLine: { status: 'none' } }), 'GB')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents/shipping-origin.test.ts`
Expected: FAIL — "resolveItemShipping is not exported".

- [ ] **Step 3: Implement `resolveItemShipping` (replacing `resolveProductOrigin`)**

In `src/inbox/agents/shipping.ts`, replace the `resolveProductOrigin` function with:

```typescript
export interface ItemShipping {
  chosenOrigin: string;
  cjPid: string;
  repVid: string | null;
  verifiedGbWarehouse: boolean;
}

const HANDLE_RE = /(?:activepaw\.co\.uk)?\/products\/([a-z0-9][a-z0-9-]{2,})/i;

/**
 * Resolve the inquiry's product (high-confidence only) plus its nearest in-stock
 * warehouse for `dest` and a representative variant id for a live CJ quote.
 * Fully guarded: any miss returns null and the caller keeps the generic/hedge path.
 *
 * Origin priority: in-market (dest country) if stocked -> best-stocked origin.
 */
export async function resolveItemShipping(ctx: AgentContext, dest: string): Promise<ItemShipping | null> {
  try {
    // Signal 1: a product URL/handle in the message (strongest).
    let cjPid: string | null = null;
    const m = HANDLE_RE.exec(ctx.latestMessage);
    if (m) cjPid = (await ctx.store.getLinkByHandle(m[1]))?.cj_pid ?? null;
    // Signal 2: a confident single free-text catalog match.
    if (!cjPid) {
      if (!ctx.admin) return null;
      const resolved = await resolveLineRequest(ctx.admin, ctx.latestMessage.slice(0, 80));
      if (resolved.status !== 'resolved' || !resolved.variant?.productId) return null;
      cjPid = (await ctx.store.getLinkByShopifyProductId(resolved.variant.productId))?.cj_pid ?? null;
    }
    if (!cjPid) return null;

    const row = await ctx.store.getWarehouseProduct(cjPid);
    if (!row?.detail) return null;
    let detail: CjDetail;
    try { detail = JSON.parse(row.detail) as CjDetail; } catch { return null; }
    const origins = detail.origins;
    if (!origins || Object.keys(origins).length === 0) return null;

    const verifiedGbWarehouse = (origins.GB ?? 0) > 0;
    // Nearest in-stock warehouse: in-market (no customs) if stocked, else best-stocked.
    let chosenOrigin: string;
    if ((origins[dest] ?? 0) > 0) {
      chosenOrigin = dest;
    } else {
      let best = ''; let bestQty = 0;
      for (const [cc, qty] of Object.entries(origins)) if (qty > bestQty) { best = cc; bestQty = qty; }
      if (!best) return null;
      chosenOrigin = best;
    }
    // Representative vid: prefer an in-stock variant; else the first listed.
    const variants = detail.variants ?? [];
    const repVid = (variants.find((v) => (v.stock ?? 0) > 0) ?? variants[0])?.vid ?? null;

    return { chosenOrigin, cjPid, repVid, verifiedGbWarehouse };
  } catch {
    return null;
  }
}
```

Confirm `CjDetail` exposes `variants?: { vid: string; stock?: number }[]` (it does in `src/cj.ts`). The `ground()` call site is rewired in Task 5, so leave `ground` referencing the old name until then is NOT an option — update the `ground` body's `resolveProductOrigin(ctx, dest)` call to a temporary shim within this task: replace that single line with `const item = await resolveItemShipping(ctx, dest); const origin = item?.chosenOrigin ?? null;` so the file compiles and existing tests stay green.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agents/shipping-origin.test.ts tests/agents/shipping-agent.test.ts`
Expected: PASS (new resolver tests + existing agent tests still green via the shim).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/inbox/agents/shipping.ts tests/agents/shipping-origin.test.ts
git commit -m "feat(inbox): resolveItemShipping (item + nearest origin + repVid + verified-GB)"
```

---

## Task 4: Thread `cj` into `AgentContext`

**Files:**
- Modify: `src/inbox/agents/types.ts` (`AgentContext`)
- Modify: `src/inbox/sweep.ts` (~line 284-303, context assembly)
- Test: `tests/agents/shipping-agent.test.ts` (fakes must add `cj`)

**Interfaces:**
- Consumes: `CjClient` (`src/cj.ts`), `CjTokenManager`, `cjFetchFromEnv` (`src/cj.ts`), `Vault` (`src/vault.ts`).
- Produces: `AgentContext.cj: CjClient | null` — a lazily-authenticated CJ client (token fetched only on first call), or `null` when the shop has no CJ credentials / master key.

- [ ] **Step 1: Write the failing test (type-level + assembly)**

Add to `tests/agents/shipping-agent.test.ts` a check that the agent tolerates `cj: null` (hedges, no throw) and that a fake `cj` is accepted:

```typescript
it('ground tolerates cj:null (no throw, falls back to matrix)', async () => {
  const g = await shippingAgent.ground(fakeCtx({ cj: null, dest: 'GB', /* matrix route present */ }));
  expect(g).toBeDefined(); // no throw
});
```

Update the shared `fakeCtx` helper in this test file to include `cj: opts.cj ?? null` in the returned `AgentContext`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents/shipping-agent.test.ts`
Expected: FAIL — `cj` is not a property of `AgentContext` (tsc error in the test), or the fake lacks it.

- [ ] **Step 3: Add `cj` to the interface and assemble it**

In `src/inbox/agents/types.ts`, add to `AgentContext` (after `admin`):

```typescript
  cj: import('../../cj').CjClient | null; // lazily-authed CJ client for live freight fallback; null when unconfigured
```

In `src/inbox/sweep.ts`, near the `admin` assembly (~line 289), construct `cj` defensively and add it to the `ctx` literal:

```typescript
  // Lazily-authed CJ client for the shipping agent's live nearest-warehouse fallback.
  // Construction is cheap (token fetched only on first freight call); any setup failure
  // degrades to null so the agent keeps the D1 matrix path.
  const cj = await (async () => {
    try {
      if (!(await store.getSupplierCredential('cj'))) return null;
      const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
      const f = cjFetchFromEnv(env);
      return new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
    } catch (e) {
      console.warn(`inbox cj unavailable for ${thread.id}: ${(e as Error).message}`);
      return null;
    }
  })();
```

Add `cj,` to the `const ctx: AgentContext = { store, cfg, admin, cj, thread, ... }` literal. Add the imports at the top of `sweep.ts`: `import { CjClient, CjTokenManager, cjFetchFromEnv } from '../cj';` and `import { Vault } from '../vault';` (confirm exact export names/paths with `grep -n "export" src/cj.ts src/vault.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agents/shipping-agent.test.ts tests/inbox-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/inbox/agents/types.ts src/inbox/sweep.ts tests/agents/shipping-agent.test.ts
git commit -m "feat(inbox): thread lazily-authed cj client into AgentContext"
```

---

## Task 5: Live-CJ fallback band + verified-UK wording + ask-for-item

**Files:**
- Modify: `src/inbox/agents/shipping.ts` (`ground`, `deterministicAppendix`, helpers)
- Test: `tests/agents/shipping-agent.test.ts`

**Interfaces:**
- Consumes: `resolveItemShipping` (Task 3), `ctx.cj` (Task 4), `cj.freightQuoteAging(vid, from, to, qty)` → `{ priceUsd; days; name }[]`, `bandFromQuote(aging, from, to, l)` (`src/logistics.ts`), `buildShippingLine(label, band)`.
- Produces: no signature change to the `CategoryAgent`; `ground` now returns, in `data`, `{ label, band, verifiedGb, askForItem }` and the appendix uses them.

- [ ] **Step 1: Write the failing tests**

```typescript
it('GB-verified item + no matrix route -> live CJ quote + UK fulfilment line', async () => {
  const cj = { freightQuoteAging: async () => [{ priceUsd: 0, days: '2-4', name: 'Domestic' }] };
  const ctx = fakeCtx({
    dest: 'GB', cj,
    item: { chosenOrigin: 'GB', cjPid: 'P1', repVid: 'V1', verifiedGbWarehouse: true },
    matrixRoute: null, // no GB->GB row
  });
  const g = await shippingAgent.ground(ctx);
  expect(g.confident).toBe(true);
  const line = shippingAgent.deterministicAppendix(g)!;
  expect(line).toMatch(/UK fulfilment location/i);
  expect(line).toMatch(/\d+-\d+ days/);          // door-to-door band, e.g. 4-9 days
  expect(line).not.toMatch(/from (China|the UK)|ships from/i); // never names dispatch / blanket UK
});

it('CN item -> time-only, no origin, no UK claim', async () => {
  const ctx = fakeCtx({ dest: 'US', item: { chosenOrigin: 'CN', cjPid: 'P2', repVid: 'V2', verifiedGbWarehouse: false },
    cj: { freightQuoteAging: async () => [{ priceUsd: 1, days: '5-11', name: 'CJPacket' }] }, matrixRoute: null });
  const g = await shippingAgent.ground(ctx);
  const line = shippingAgent.deterministicAppendix(g)!;
  expect(line).toMatch(/Delivery to the United States: estimated \d+-\d+ days\./);
  expect(line).not.toMatch(/UK|fulfilment|warehouse|China/i);
});

it('no item resolved -> asks for the item, keeps a soft general band', async () => {
  const ctx = fakeCtx({ dest: 'GB', item: null, matrixRoute: { from_country:'CN', to_country:'GB', transit_min:4, transit_max:9 } });
  const g = await shippingAgent.ground(ctx);
  expect((g.data as any).askForItem).toBe(true);
  expect(g.facts).toMatch(/ask .*which (item|product)/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents/shipping-agent.test.ts`
Expected: FAIL — no UK line, no `askForItem`, CJ fallback not called.

- [ ] **Step 3: Rewrite `ground` + appendix**

Replace the `shippingAgent.ground` body's origin/route/band section and the `deterministicAppendix`. New `ground` core (keep the early `relevant`/`dest` guards as-is):

```typescript
    const l = resolveLogistics(ctx.cfg.fulfil);
    const item = await resolveItemShipping(ctx, dest);

    // No confident item -> ask which item, but offer the generic dest band as a soft anchor.
    if (!item) {
      const generic = doorToDoorBand(await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours), l);
      return {
        confident: false, quotesFigure: false,
        facts: `The customer asked about delivery time but did not name a specific product. ASK which item (or a product link) so you can give a precise estimate. You MAY offer, as a soft general guide only, that most ${countryLabel(dest)} orders arrive in about ${formatBand(generic)} and that the exact time depends on the item. You MAY also state the flat shipping cost and returns policy from the store facts.`,
        data: { askForItem: true }
      };
    }

    // Resolve the band for the item's nearest warehouse: D1 matrix first, live CJ fallback.
    let band = doorToDoorBand(await ctx.store.getLogisticsRoute(item.chosenOrigin, dest, l.stalenessHours), l);
    if (!band && ctx.cj && item.repVid) {
      try {
        const opts = await ctx.cj.freightQuoteAging(item.repVid, item.chosenOrigin, dest);
        const cheapest = opts.filter((o) => o.days).sort((a, b) => a.priceUsd - b.priceUsd)[0];
        if (cheapest) band = bandFromQuote(cheapest.days, item.chosenOrigin, dest, l);
      } catch (e) { console.warn(`ship cj fallback failed: ${(e as Error).message}`); }
    }
    if (!band) band = doorToDoorBand(await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours), l);
    if (!band) return notConfidentFacts(dest);

    const verifiedGb = item.verifiedGbWarehouse && dest === 'GB';
    return {
      confident: true, quotesFigure: true,
      facts: `Destination ${countryLabel(dest)}. A grounded delivery estimate line is appended after your reply, so do NOT state a delivery time yourself. You MAY state the flat shipping cost and returns policy. Do not add a sign-off; the appended line follows your text.`,
      data: { label: countryLabel(dest), band, verifiedGb }
    };
```

Add `formatBand` to the import from `../../logistics`. New appendix:

```typescript
  deterministicAppendix(g: Grounding): string | null {
    const d = g.data as { label: string; band: DayRange; verifiedGb?: boolean } | undefined;
    if (!g.confident || !d) return null;
    const line = buildShippingLine(d.label, d.band); // "Delivery to X: estimated A-B days."
    if (!line) return null;
    // Per-SKU, source-verified UK fulfilment wording (never blanket, never for non-GB stock).
    return d.verifiedGb
      ? `This item is held in a UK fulfilment location. ${line}`
      : line;
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agents/shipping-agent.test.ts tests/agents/shipping-origin.test.ts tests/inbox-freight.test.ts`
Expected: PASS (verified-UK line; CN time-only; ask-for-item).

- [ ] **Step 5: Typecheck + full focused suite + commit**

Run: `npx tsc --noEmit` then `npx vitest run tests/agents/shipping-agent.test.ts tests/agents/shipping-origin.test.ts tests/inbox-freight.test.ts tests/inbox-sweep.test.ts`

```bash
git add src/inbox/agents/shipping.ts tests/agents/shipping-agent.test.ts
git commit -m "feat(inbox): per-item nearest-warehouse delivery (CJ fallback + verified-UK line + ask-for-item)"
```

---

## Self-Review

**Spec coverage:**
- Infer-first-then-ask → Task 3 (resolve) + Task 5 (ask-for-item branch). ✓
- D1-first / live-CJ fallback → Task 5 (`getLogisticsRoute` then `freightQuoteAging`). ✓
- High-confidence item match → Task 3 (URL/handle + `resolveLineRequest` single-match; ambiguous→null). ✓
- Verified-UK wording, per-SKU, never blanket → Task 5 appendix (`verifiedGb` gate). ✓
- Time-only, never name non-GB origin → Task 5 (CN test asserts no origin). ✓
- "US" extraction fix → Task 1. ✓
- Conservative door-to-door, degrade-don't-fabricate → Task 5 fallback chain + `notConfidentFacts`. ✓
- Nearest-warehouse pick → Task 3 (in-market else best-stocked). ✓
- Deferred order-line signal → noted in File Structure. ✓

**Placeholder scan:** none — every code/test step carries real code. The only "confirm with grep" notes are verification steps for exact export names, not deferred logic.

**Type consistency:** `ItemShipping` (Task 3) consumed in Task 5; `AgentContext.cj` (Task 4) consumed in Task 5; `freightQuoteAging` return `{priceUsd,days,name}[]` matches `src/cj.ts`; `bandFromQuote(aging, from, to, l)` and `doorToDoorBand(route, l)` match `src/logistics.ts`; `buildShippingLine(label, band)` matches `src/inbox/freight.ts`.

**Note:** the per-product `delivery_days_actual` D1 source (spec open-choice #1) is **not** used — the matrix-then-CJ chain already yields the nearest-warehouse band, so persisting that metafield into D1 is unnecessary for this plan. Recorded here so the spec's open choice is resolved: skip it.

## Standing-rule memory update (after ship)

When this feature is deployed and verified, update the `no-uk-fulfilment-claim` memory to record the per-SKU verified UK-fulfilment-location allowance (else time-only, no origin named).
