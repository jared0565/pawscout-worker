# Inbox Category Agents - Design

Date: 2026-06-24
Status: Approved (brainstorming), pending implementation plan
Related: `2026-06-18-pawscout-inbox-w2-replies-design.md`, `2026-06-21-cj-logistics-store-design.md`, `2026-06-22-affiliate-inbound-gating-design.md`

## Problem

Inbound customer emails are already classified into 10 categories
(`src/inbox/classify.ts`), but every reply is drafted by a single monolithic
prompt (`src/inbox/draft.ts`) with category-specific behaviour bolted in as inline
conditionals (`if category === 'affiliate'`, `shippingHandledSeparately`, wholesale
policy, buyer-funnel policy). Grounding (real data fetched before drafting) exists
but is scattered and only partly wired: `freight.ts` (shipping), `propose-invoice.ts`
(orders/invoices), `partnership.ts` (affiliate).

The cost of this showed up live: a customer asked "how long does shipping take to
Texas?" The generic drafter hedged ("delivery times vary, we will confirm at
dispatch") even though the CN to US logistics row was present and fresh, because
nothing wired the shipping data into the reply for that thread. A shipping
specialist that reads the logistics matrix would have answered "roughly 7 to 23
calendar days."

## Goal

Replace the one-prompt-does-everything model with **one dedicated agent per
category**. Each agent owns a targeted prompt, its own grounding (real data read
deterministically from D1 / CJ / Shopify), and its own send policy. This makes
replies grounded and on-target by construction, and lets the owner enable
auto-send per agent as trust is earned.

## Non-goals

- No change to ingestion or classification. `classifyEmail` and `decideDisposition`
  are untouched; agents dispatch off the existing `thread.primary_category`.
- No autonomous tool-loop agents. An "agent" here is a small handler object, not a
  multi-step LLM loop.
- No config migration. Per-agent settings live in the existing `tenant_config.inbox`
  JSON column. (One small, backfill-safe `inbox_drafts` column is added for
  observability - see Migration.)

## Decisions (locked in brainstorming)

1. **Agent shape**: handler module per category (targeted prompt + deterministic
   grounding + send policy). Single LLM draft call, category-specific prompt and
   injected facts.
2. **Data-grounded agents in scope**: `shipping-returns`, `order-status`,
   `product-question`, `affiliate`. The rest (`lead`, `wholesale-b2b`, `complaint`,
   `other`) get dedicated targeted-prompt handlers with no new data fetch in v1.
3. **Send policy**: a per-agent auto toggle, defaulting OFF (full HITL today),
   flippable per agent in the console. A global master switch is preserved as a
   kill-switch.
4. **Grounded figures under Auto**: the per-agent toggle governs fully. A trusted
   deterministic appendix figure (delivery estimate, tracking number) does NOT
   force a hold. The money gate runs on the LLM-authored body only, so trusted
   figures are exempt by construction. This relaxes today's "any freight line
   always gets review" guard.
5. **The Texas fix** (US state / CA province name to country resolution) belongs to
   the shipping agent's grounder.
6. **Bounded commercial objective**: each sales-relevant agent has an explicit
   first-class goal to advance the sale, strictly subject to the honesty and
   compliance constraints below. The objective is sustainable revenue through trust,
   never revenue at the expense of honesty. `complaint` and `other` are excluded.
7. **Origin is per-product, never stated to the customer**: CJ warehouses vary by
   product (CN, EU, US, and others); the catalog is not CN-only. The shipping agent
   resolves the real origin per product where known and falls back to a conservative
   default otherwise. The customer-facing reply gives the calculated delivery time
   and never names the origin country. This is both more accurate (an EU-warehoused
   item to an EU customer has no customs leg and a shorter transit) and compliant
   (no fulfilment-origin claim either way).

## Architecture

### The agent contract

One module per category, all implementing the same contract. The agent is a small
object, not an autonomous loop.

```ts
interface CategoryAgent {
  category: InboxLabel;          // 'shipping-returns', etc.
  displayName: string;           // "Shipping & Returns" - shown in console

  // 1. GROUND - deterministic, NO LLM. Reads D1/CJ/Shopify. Never throws; on any
  //    miss returns { confident:false } so the drafter safely hedges.
  ground(ctx: AgentContext): Promise<Grounding>;

  // 2. PROMPT - category-specific instructions, built from base facts + grounding.
  promptFragment(g: Grounding): string;

  // 3. APPENDIX - optional verbatim line the LLM must NOT author (e.g. the freight
  //    line). Trusted, deterministic, appended after the LLM body. null = none.
  deterministicAppendix(g: Grounding): string | null;
}

interface Grounding {
  confident: boolean;     // did we get real, fresh data? false => hedge
  facts: string;          // human-readable facts injected into the prompt
  quotesFigure: boolean;  // does this introduce a trusted number/date? (audit/policy input)
  data?: unknown;         // structured payload for the appendix (audit/repro)
}

interface AgentContext {
  store: TenantStore;          // D1 access (orders, warehouse, logistics, contacts)
  cfg: TenantConfig;
  admin: AdminGraphql | null;  // Shopify caller; null when not authed -> agents hedge
  thread: ThreadRow;
  conversation: string;        // full thread text (quote-stripped)
  latestMessage: string;       // the turn we are answering
  contactEmail: string;
}
```

### Registry and dispatch

```ts
const AGENTS: Record<InboxLabel, CategoryAgent> = { /* one per replyable category */ };
const agent = AGENTS[thread.primary_category] ?? AGENTS['other'];   // total, never undefined
```

`spam` and `automated` get no reply, so they have no agent. Every other category
maps to an agent; an unknown or unmapped value falls back to the `other` agent so
dispatch is total and the draft path never crashes.

### Generic drafter

`draftReply` becomes generic. The shared safety scaffolding stays in `draftReply`
(untrusted-data rule, the `customerAsks` workflow, UK English, no-greeting,
no-em-dash, JSON output contract) so it is not duplicated across 8 agents. Per call:

1. `g = await agent.ground(ctx)`
2. system prompt = `STORE_FACTS + agent.promptFragment(g) + g.facts`
3. single LLM call (unchanged client, validation, usage logging)
4. `body = draft.bodyText + (agent.deterministicAppendix(g) ?? '')`
5. `body = applySalutation(sanitizeOutbound(body))` (unchanged)

### Data flow

```
inbound email
  -> ingest -> classifyEmail -> decideDisposition          [UNCHANGED]
       -> thread.primary_category set
  -----------------------------------------------------------------
  composeDraftForThread (sweep.ts)                          [REWIRED]
    1. agent  = AGENTS[primary_category] ?? AGENTS['other']
    2. g      = await agent.ground(ctx)                     # deterministic, never throws
    3. draft  = await draftReply(llm, { agent, grounding: g, ... })
    4. body   = draft.bodyText + agent.deterministicAppendix(g)   # verbatim, if any
    5. body   = applySalutation(sanitizeOutbound(body))     [UNCHANGED]
    6. send?  = autoSendDecision({ autosend: master && agents[cat].autosend, draft, floor })
    7. insertDraft(status: send ? 'auto_send' : 'pending')  [UNCHANGED schema]
```

Guarantees:
- **Dispatch is total** - unknown/`other` always resolves to a fallback.
- **Grounding is isolated from drafting** - `ground()` does all I/O and returns a
  plain struct; the LLM call only ever sees text. A failed lookup yields
  `confident:false` and the hedge.
- **`admin: null` degrades gracefully** - order-status / product-question hedge when
  the merchant has not granted `read_orders` / `read_customers` yet. They light up
  automatically once re-auth lands, with no code change.

## The agents

Shared safety scaffolding lives in `draftReply`; each agent adds only its slant and
injected `g.facts`.

### Data-grounded (4)

| Agent | `ground()` reads | Confident when | Appendix (verbatim) | Prompt slant |
|---|---|---|---|---|
| shipping-returns | `deriveDestinationCountry`; resolve origin per product where known (real CJ warehouse, may be EU/US/CN), else conservative default origin; `getLogisticsRoute(origin, dest)` -> `doorToDoorBand`; returns + shipping-cost from static facts | route found and fresh (< staleness) | `Delivery to X: estimated A-B days.` (today's freight line, origin never named) | delivery time / cost / returns; hedge time if no route, cost still allowed from facts |
| order-status | `findCustomerByEmail` + new "recent orders + fulfillments/tracking" query; cross-ref local `orders` (CJ pipeline status/tracking) | exactly one order resolved (order # in message, else single recent) | `Order #1001: <status>, tracking <number> (<carrier>): <url>` | report grounded status; if none/ambiguous ask for order #; never invent status or tracking |
| product-question | `resolveLineRequest(admin, namedProduct)` -> resolved/ambiguous/none + `warehouse_products.detail` (stock, specs) | single product resolved | none (facts go in prompt, flagged) | answer from resolved facts, suggest next step (PDP/cart); ambiguous -> ask which item; none -> point to site |
| affiliate | reuse `partnership.ts` stance + screen verdict | always (policy-based) | none | today's affiliate slant: warm, ask audience/platform/reach, commit to nothing |

### Targeted-prompt (4)

| Agent | Grounding | Prompt slant |
|---|---|---|
| lead | none (v1) | buyer-funnel: move toward purchase, one concrete next step, no invented price/stock |
| wholesale-b2b | none | today's policy: not offering trade terms now, welcome to order individually via site |
| complaint | none (v1); sets owner `alert` | empathetic, de-escalate, offer to make it right; default toggle OFF (sensitive) |
| other | none | today's generic safe base: answer only what is asked from facts, hedge unknowns, decline non-CS pitches |

### Shipping agent: the Texas fix

`deriveDestinationCountry` (`src/inbox/freight.ts`) maps country names and ccTLDs but
not US state / CA province names, so "Texas" fell through to a hedge. Add a
state/province to country lookup inside the shipping grounder so "Texas" resolves to
`US`, "Ontario" to `CA`, etc. Keep the existing ambiguity guard (multiple distinct
destinations named -> hedge).

### Shipping agent: origin is per-product, not CN

CJ warehouses products in multiple countries (CN, EU, US, and others) depending on
the product. The earlier `cj_logistics` assumption of a single `CN` origin "for this
CN-only catalog" is therefore a simplification that can overstate delivery time: an
EU-warehoused item shipped to an EU customer has no customs leg
(`from_country === to_country` region) and a shorter transit, but a hardcoded `CN`
origin always adds the cross-border customs window.

Grounding priority for the shipping agent (most accurate first, each step defensible):

1. **Per-product origin** - when a specific product/variant is identified (named in
   the thread, or via an order/draft), read its real warehouse/origin from grounded
   data: the variant `supplier.warehouse` metafield or a fresh CJ freight quote
   (`bandFromQuote(aging, origin, dest, l)`, which already accepts an arbitrary
   origin). This yields the real transit and the correct customs decision for that
   item.
2. **Route matrix fallback** - when no product is identified, use
   `getLogisticsRoute(defaultOrigin, dest)`. The default origin stays conservative
   (CN today) so we never under-promise.
3. **Hedge** - missing/stale data -> `confident:false`.

Two hard rules hold in every branch:

- **Never under-promise dishonestly and never over-promise speculatively.** Quote a
  faster EU/US-warehouse time ONLY when grounded that the specific product ships from
  that warehouse to that customer. Absent that proof, fall back to the conservative
  default. This is the `only-real-and-defensible` rule applied to origin.
- **The reply never names the origin country.** It states the calculated time only
  (e.g. "estimated 7 to 23 days"), satisfying the no-fulfilment-origin-claim rule
  regardless of whether the true origin is CN, the EU, or the US.

The `cj_logistics` table and `doorToDoorBand` already support arbitrary origins (the
schema is keyed by `from_country`; `bandFromQuote` takes a `from` argument), so this
is a grounding-resolution change, not a storage change. Populating non-CN matrix
rows from the nightly sync is a follow-up that this design enables but does not
require for Phase 1.

## Commercial objective (bounded)

Sales-relevant agents have an explicit first-class goal: advance the sale. The
objective function is **maximize revenue subject to hard honesty and compliance
constraints** - sustainable revenue through trust, never revenue at the expense of
honesty. This is additive: it rides on top of the grounding-first contract above and
never overrides it. When a commercial nudge would require an ungrounded claim, the
grounding-first rule wins and the nudge is dropped.

### Commercial goal per agent

| Agent | Commercial goal | Notes |
|---|---|---|
| lead | **Flagship**: convert. Capture the minimum missing detail, then hand a real checkout via `createDraftOrder` / `propose-invoice`. One concrete next step, no pressure. | Draft-order creation needs `write_draft_orders` (re-auth); until then, direct to PDP/checkout. |
| product-question | Answer first, then exactly one concrete next step (PDP link, "reply with the size and I will set it up", add-to-cart). | The conversion CTA, not a hard sell. |
| shipping-returns | Reduce abandonment on delivery worry: state the honest delivery figure FIRST and plainly, THEN reassurance (tracking, returns cover). | Ordering is locked: never bury or reframe a long window (e.g. 23 days). |
| order-status | After resolving status, a soft relationship touch ("anything else for <pet>?"). No pressure. | Repeat-purchase, not upsell-on-a-problem. |
| affiliate | Keep gated; give a genuine good-fit affiliate a clear path. Commit to no terms. | Real channel; partnership.ts owns the gate. |
| wholesale-b2b | **Capture + owner-alert only.** Politely hold to current policy, capture the contact, alert the owner. | MUST NOT imply a wholesale program or follow-up exists or is coming. Gated on the owner actually having a trade offering (they do not today). |
| complaint | **Excluded.** Resolution and empathy only - no sale, no upsell. | Selling into a complaint is a dark pattern. |
| other | **Excluded.** Generic safe handling only. | |

### Flagship lever: the checkout path, not the nudge

The real conversion mechanism already exists in the codebase: `createDraftOrder`
(`src/shopify-drafts.ts`) and `propose-invoice.ts`. For a `lead` who states intent
("I want X"), the highest-value, fully-grounded action is to create the draft order
/ invoice and hand the customer a real checkout. The mandatory "one concrete next
step" CTA on `lead` and `product-question` is the second pillar. These move revenue;
the free-shipping nudge does not.

### Secondary, opportunistic: free-shipping-threshold nudge

"UK delivery is free over GBP 50" is a real, fixed fact and a legitimate honest
upsell, but a minor one: in an email thread we rarely know the live basket value,
and the threshold is UK-only (it does not apply to the EU GBP 14.99 or rest-of-world
GBP 23.99 tiers). Use it ONLY when the basket/order total is grounded (the customer
states it, or order-status / a draft order provides it) and the destination is UK.
Never invent the customer's basket value. This is opportunistic, not a primary
revenue driver.

### Cross-cutting commercial guardrails

These are hard limits, enforced in the shared prompt scaffolding for every
sales-relevant agent:

- Never invent discounts, prices, stock, delivery promises, urgency, or scarcity
  ("only 2 left" only if real and grounded).
- One nudge per reply, not repeated pushing across turns.
- Honesty is never traded for conversion: true delivery times and product facts
  stand as-is; reassurance never softens or hides them.
- No commitments the owner has not authorized (commission rates, wholesale terms,
  bespoke discounts).
- The complaint and other agents carry no commercial objective.

### Observability (what makes this an objective, not a wish)

To claim the design serves revenue, commercial intent must be measurable. Each draft
records a `commercial_intent` marker (did this reply carry a CTA or a grounded
nudge?) alongside the existing `quotes_price_order` flag. This is a one-column
addition to `inbox_drafts` (migration `0017`), surfaced in the console so the owner
can later see which agents drive action. Without it, the honest answer to "does this
maximize revenue" stays "we hope so."

### Send-policy interaction (state it plainly)

Commercial replies that mention money or commit to an order trip the universal money
gate (`mentionsMoney` on the LLM body, or `quotesPriceOrOrder`) and route to HITL.
That is correct and safe, but it means **commercial replies and auto-send rarely
co-occur**: the most revenue-active replies are exactly the ones a human reviews
before sending. The per-agent toggle still governs the figure-free commercial
replies (e.g. "reply with the size and I will set it up").

## Per-agent auto toggle

### Config

```ts
interface AgentSettings { autosend: boolean }              // room to grow (per-agent threshold later)
interface InboxConfig {
  // ...existing...
  autosend: boolean;                           // KEEP as a master kill-switch
  agents: Record<InboxLabel, AgentSettings>;   // per-agent toggles, all default false
}
```

Stored in the existing `tenant_config.inbox` JSON. A `resolveAgents(cfg)` helper
fills a default `{autosend:false}` for every known category, defeating the shallow
JSON-merge hazard (same pattern as `resolveLogistics`). A stored partial map can
never yield an `undefined` agent setting.

### Send policy

`autoSendDecision` (`src/inbox/autosend.ts`) changes one input: the global
`autosend` becomes `master && agents[category].autosend`. An agent auto-sends only
when the master switch is on, its own toggle is on, and the universal floor passes.

Universal floor stays as today:
- `low_confidence` (below `autoConfidenceThreshold`)
- `rate_limited` (`AUTO_RATELIMIT_PER_SENDER_DAY`)
- LLM-authored money (`mentionsMoney` on the model's body, or `quotesPriceOrOrder`)

`ALWAYS_HOLD_CATEGORIES` is removed as a hard rule. Those agents (complaint,
wholesale-b2b, affiliate) instead ship with their toggle defaulting OFF, so the
owner controls them.

Trusted-figure exemption: remove the `send: decision.send && !shippingLine` guard in
`sweep.ts`. The money gate runs on the LLM body only (computed before the appendix
is appended), so the trusted freight/tracking appendix never trips it. This is what
makes the toggle meaningful for shipping-returns and order-status.

### Console

Below the existing master "Reply mode" switch (top of the Inbox panel), add an
"Agents" panel listing each replyable category: display name, a one-line "grounds
in ..." description, and an Auto/Review toggle. Toggles are disabled (greyed) when
the master is off. Reuses the existing `.reply-mode` styling and the same
settings-save path. `src/console/page.ts` is one large template literal, so
`tests/console.test.ts` must pass after edits, and browser-JS strings must keep
their existing escaping.

## Error handling

All failures degrade to today's safe behaviour; nothing new can crash the draft
path.

- `ground()` wraps every read in try/catch and returns `confident:false` on any
  failure; the prompt then instructs the hedge.
- `admin: null` -> order-status / product-question hedge.
- Stale / missing logistics, ambiguous product, no order found -> `confident:false`
  -> hedge.
- Unknown / `other` category -> fallback agent.
- LLM failure -> `draftReply` returns null -> retried next sweep (unchanged).
- Deterministic appendix is appended only when `confident`; never a half-grounded
  figure.

## Testing

- Per-agent unit tests: feed a mocked `AgentContext` (fixture store/admin) and
  assert `Grounding` (`confident`, `facts`, `quotesFigure`) and appendix formatting.
- Registry totality: every `InboxLabel` resolves to an agent or the `other` fallback.
- Send policy: table tests over master x per-agent toggle x floor; explicit
  trusted-figure-exemption test; `resolveAgents` default-fill test (mirrors the
  `resolveLogistics` shallow-merge tests).
- Shipping regression: "Texas" -> US resolution; existing `logistics.test.ts` stays
  green.
- order-status: order-# match / single-recent fallback / ambiguous -> hedge /
  `admin:null` -> hedge.
- product-question: resolved / ambiguous / none.
- Shipping origin: per-product origin used when grounded (EU-warehoused item to an EU
  customer -> no customs leg, shorter band); conservative default origin when no
  product is identified; the reply never names the origin country.
- Commercial: CTA present on `lead` / `product-question`; `complaint` and `other`
  carry no commercial nudge (exclusion test); `wholesale-b2b` captures without
  implying trade terms exist; free-shipping nudge fires ONLY when basket total is
  grounded AND destination is UK; `commercial_intent` marker set correctly.
- Console: `tests/console.test.ts` passes after `page.ts` edits.
- Integration: `composeDraftForThread` end-to-end with a fake LLM, one per category.

## Migration and backward-compatibility

Config needs no migration: `inbox` is JSON; `resolveAgents` fills all-OFF defaults,
so behaviour is identical to today (full HITL) until the owner flips a toggle. The
master switch is preserved. The existing `replyGuidance` continues to apply to every
agent as the owner's standing voice override.

One small schema migration (`0017`) adds a `commercial_intent INTEGER NOT NULL
DEFAULT 0` column to `inbox_drafts` for the observability requirement above. It is
backfill-safe (defaults to 0 for existing rows) and orthogonal to the per-agent
config.

## Phasing (for the implementation plan)

- **Phase 1**: framework (contract, registry, dispatch, generic `draftReply`),
  per-agent config + `resolveAgents`, send-policy change + trusted-figure exemption,
  console toggle panel, and migrate existing behaviour into agents
  (shipping-returns incl. the Texas fix, affiliate via partnership.ts, lead,
  wholesale-b2b, complaint, other, and a basic product-question that reuses
  `resolveLineRequest`). Commercial objective at the prompt level: CTA discipline on
  `lead` / `product-question`, shipping-objection ordering, `wholesale-b2b` capture +
  owner-alert, `complaint` / `other` exclusion, opportunistic free-shipping nudge.
  `commercial_intent` marker + migration `0017` + console surface.
- **Phase 2**: order-status new Shopify "recent orders + tracking" query and the
  draft-order checkout handoff via `createDraftOrder` (both depend on the outstanding
  `read_orders` / `read_customers` / `write_draft_orders` re-auth); per-product
  origin resolution for the shipping agent (real warehouse via `supplier.warehouse` /
  CJ quote, EU/US/CN); deeper product-question grounding (warehouse detail, stock,
  specs); optional nightly sync of non-CN logistics matrix rows.

## Open dependencies

- Order-status grounding and the lead draft-order checkout handoff require the
  merchant re-auth for `read_orders`, `read_customers`, and `write_draft_orders`
  (tracked separately). Until then those agents hedge or direct to PDP/checkout; no
  blocker for Phase 1.
- Per-product origin resolution (Phase 2) depends on grounded per-variant warehouse
  data (`supplier.warehouse` metafield or a fresh CJ quote). Phase 1 uses the
  conservative default origin, which is correct and defensible meanwhile.
