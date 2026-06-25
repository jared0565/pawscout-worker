# Origin-Aware Shipping Cost (Phase 1: free UK on GB-warehoused items)

Date: 2026-06-25
Status: Design (approved in brainstorm, pending written-spec review)

## Context and the larger vision

This is the first sub-project of a broader direction the owner set: move customer
replies toward **deterministic, source-grounded answers from CJ data**, so the LLM
becomes the phrasing layer over a growing base of defensible responses, in service
of **maximising net profit**. Shipping is the first domain because it is the
highest-traffic inquiry and the data (delivery time AND cost) is available at CJ.

The owner's eventual goal for shipping is **origin-aware pricing**: charge the
customer what each item actually costs to ship from its real warehouse, turning the
GB warehouse's near-zero domestic freight into a free-UK-shipping conversion lever,
while cross-border items carry a profit-bearing rate.

Two layers were identified and sequenced:
- **A. Shipping intelligence** (this spec) - ground delivery time and cost per
  destination from CJ data, origin-aware, profit-aware.
- **B. Inquiry knowledge base** (later) - the general inquiry -> defensible-response
  store. To be designed after A's data model is stable.

This spec covers **A, Phase 1 only**.

## Decisions locked (brainstorm, 2026-06-25)

1. Build shipping (A) first; the knowledge base (B) comes after A's data is stable.
2. Customer shipping cost is **engineered from CJ freight + margin**, not the
   hardcoded flat rates and not raw CJ cost.
3. The engineered rate reaches checkout **per item origin, via Shopify delivery
   profiles** (so checkout charges by the item's real warehouse, not just the
   destination zone).
4. Build **phased**. Phase 1 proves the riskiest mechanic (delivery profiles +
   product assignment) on the highest-value, lowest-risk case: **free UK shipping on
   GB-warehoused items**. Phase 2 generalises (full margin engine, all origins/zones,
   multi-warehouse and mixed-cart handling).

## Governing constraint: quote == checkout

Every customer-facing cost statement must equal what Shopify actually charges at
checkout, or it violates the project's honesty bar (only-real-and-defensible). The
agent may state "free UK delivery" **only after** the delivery profile is live and a
GB item to a UK address is verified to charge GBP 0. Order of operations matters.

## Worked example (live data, the GB cat turntable)

| Field | Value |
|---|---|
| Product | Interactive Wood & Sisal Cat Turntable (`...cat-turntable-scratching-post`) |
| Retail | GBP 32.99 |
| CJ item cost (COGS) | USD 15.30 (about GBP 12) |
| CJ shipping freight GB->GB | USD 0.00 (evri, 3-8 days; domestic fulfilment bundled) |
| Current UK shipping charged | GBP 4.99 (free over GBP 50) |
| Delivery (UK-local) | about 4-12 days door to door |

Economics to a UK customer under GBP 50: revenue 32.99 + 4.99; COGS about 12 item +
0 shipping. The 4.99 UK shipping is almost pure margin on a GB item. Phase 1 makes
that UK shipping **free** as a conversion lever; item margin (about GBP 21) absorbs
the forgone 4.99 easily.

Contrast (why origin-awareness matters): a CN-warehoused item to the same UK address
carries real cross-border CJ freight (verified this session: CN->US cheapest is about
USD 6), so it must keep a paid rate. Shopify checkout charges by destination zone, not
item origin, which is exactly why delivery profiles (per-origin) are required.

## Phase 1 scope and outcome

A UK customer buying a GB-warehoused item pays **GBP 0 shipping at checkout**, and the
agent can defensibly state "free UK delivery". CN and other items keep today's rates.
The CJ-cost-in-DB foundation is laid for Phase 2. Exactly one origin-aware delivery
profile is introduced.

Out of scope for Phase 1 (deferred to Phase 2): the CJ-freight + margin rate engine
for non-zero routes; profiles for non-GB origins; non-UK zones differing from current
flat rates; automated multi-warehouse re-assignment beyond the daily reconcile;
mixed-cart rate modelling; the knowledge base (B).

## Components

### Step 0 - verify current Shopify shipping reality (foundation)

Read Shopify's current delivery profile(s), zones, and rates via the Admin API and
confirm they match what STORE_FACTS claims (GBP 4.99 UK / 14.99 EU / 23.99 world,
free over 50). All downstream quotes are only defensible against the real config. If
reality differs, correct the baseline (STORE_FACTS and/or Shopify) before proceeding.
Deliverable: a recorded snapshot of the actual current config.

### CJ cost in the logistics DB

Add `freight_cost_usd REAL` (nullable) to `cj_logistics`. The existing logistics sync
(`syncCjLogistics`, daily 04:17) already calls CJ `freightCalculate` and has the
cheapest option's `logisticPrice`; persist it alongside the existing transit fields.
No new CJ calls. This is the Phase-2 foundation and the owner's explicit ask; it does
not change any customer-facing behaviour in Phase 1.

### The "GB Local" delivery profile

A Shopify delivery profile representing GB-warehoused fulfilment:
`{ UK: free (configurable, default GBP 0), EU: GBP 14.99, World: GBP 23.99 }`. The only
difference from the default profile is free UK shipping. Membership = GB-warehoused
products (`warehouse_products` rows where the cached `detail.origins.GB > 0`). The
worker assigns products to the profile; the daily maintenance cron reconciles
membership as GB stock appears or disappears.

Open mechanism (resolve in the plan): whether the worker creates and writes the
profile via the Admin API (likely needs a `write_shipping`-class scope and a merchant
re-auth), or the owner creates the profile once in the Shopify UI and the worker only
maintains product membership. The membership-maintenance path is lower-scope and may
be preferable for Phase 1.

### Agent grounding (the quote)

Reuse the signal already computed in `shipping.ts`: when
`verifiedGbWarehouse && dest === 'GB'`, the deterministic appendix gains a
**"with free UK delivery"** clause next to the existing fulfilment-location and
delivery-time line. A runtime flag (config) gates it so it is emitted only once the
profile is verified live, preserving quote == checkout. For the shipping-cost question
specifically, a GB item to GB grounds "free UK delivery"; all other cases keep current
behaviour (flat-rate facts / shown at checkout).

### Console

Surface GB-profile status (active, member count) and the per-order profit math (item
margin vs the GBP 4.99 UK shipping forgone) so the owner can see and dial the tradeoff
(the configurable UK rate).

## Data flow and defensibility ordering

1. Step 0 snapshot of current Shopify config.
2. Add `freight_cost_usd`; sync persists CJ freight cost (no behaviour change).
3. Create the GB Local profile (UK free) and assign GB-warehoused products.
4. **Verify**: a GB item to a UK address charges GBP 0 at checkout (storefront or a
   test order draft).
5. Only then flip the agent config flag that lets it state "free UK delivery".

This ordering guarantees the agent never claims free shipping before checkout makes
it true.

## Edge cases and risks

- **Multi-warehouse item (GB + CN stock).** If GB sells out it may ship from CN while
  still in the free-UK profile, so the shop eats that freight. Mitigation: daily
  reconciliation drops it when GB stock hits zero; the brief between-cron window is
  small and the cost bounded. Option: restrict Phase 1 membership to GB-only items
  for zero risk (most current GB products are GB-only).
- **Mixed cart (GB + CN items).** Shopify charges shipping per delivery profile, so a
  mixed cart naturally charges free for the GB line and the paid rate for the CN line.
  No special handling needed; the per-item agent quote stays per item.
- **Shopify delivery-profile API scope / re-auth.** Writing profiles may require a new
  scope and merchant re-auth. Resolve the exact mechanism in the plan; prefer the
  lower-scope membership-maintenance path or owner-created profile if it avoids re-auth.
- **Forgone UK shipping revenue.** Free UK on GB items gives up about GBP 4.99 per GB
  UK order. Configurable (default free); the console shows the tradeoff so the owner
  can set a low rate instead if preferred.
- **No standing rules violated.** "Free UK delivery" is a true statement about the
  customer's shipping price, not a dispatch-origin claim; it does not conflict with the
  no-UK-fulfilment rule (which governs claiming we dispatch from the UK; this states a
  checkout price). The per-SKU verified UK-fulfilment-location line remains gated as
  before.

## Testing

- Unit (TDD): the `freight_cost_usd` persistence in the sync; the agent grounding
  (deterministic) adding "free UK delivery" only when `verifiedGbWarehouse && dest==='GB'`
  AND the config flag is on; never otherwise.
- Integration: profile membership reconciliation (GB stock in/out adds/removes a
  product); the Shopify profile write or membership update against the Admin API
  (mocked, with a live smoke test).
- Live verification: a GB item to a UK address charges GBP 0 at checkout; a CN item
  to UK still charges the flat rate; quote matches checkout.

## Success criteria

1. Shopify charges GBP 0 UK shipping for a GB-warehoused item, flat rate for a CN item.
2. The agent states "free UK delivery" for GB-to-UK and nothing false for other cases.
3. `cj_logistics.freight_cost_usd` is populated from CJ for synced routes.
4. The console shows the GB-profile status and the margin tradeoff.
5. No customer-facing statement diverges from checkout.
