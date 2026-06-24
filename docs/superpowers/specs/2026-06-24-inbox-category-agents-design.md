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
- No DB migration. Per-agent settings live in the existing `tenant_config.inbox`
  JSON column.

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
| shipping-returns | `deriveDestinationCountry` -> `getLogisticsRoute('CN', dest)` -> `doorToDoorBand`; returns + shipping-cost from static facts | route found and fresh (< staleness) | `Delivery to X: estimated A-B days.` (today's freight line) | delivery time / cost / returns; hedge time if no route, cost still allowed from facts |
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
- Console: `tests/console.test.ts` passes after `page.ts` edits.
- Integration: `composeDraftForThread` end-to-end with a fake LLM, one per category.

## Migration and backward-compatibility

No DB migration. `inbox` is JSON; `resolveAgents` fills all-OFF defaults, so
behaviour is identical to today (full HITL) until the owner flips a toggle. The
master switch is preserved. The existing `replyGuidance` continues to apply to every
agent as the owner's standing voice override.

## Phasing (for the implementation plan)

- **Phase 1**: framework (contract, registry, dispatch, generic `draftReply`),
  per-agent config + `resolveAgents`, send-policy change + trusted-figure exemption,
  console toggle panel, and migrate existing behaviour into agents
  (shipping-returns incl. the Texas fix, affiliate via partnership.ts, lead,
  wholesale-b2b, complaint, other, and a basic product-question that reuses
  `resolveLineRequest`).
- **Phase 2**: order-status new Shopify "recent orders + tracking" query (depends on
  the outstanding `read_orders` / `read_customers` re-auth) and deeper
  product-question grounding (warehouse detail, stock, specs).

## Open dependencies

- Order-status grounding requires the merchant re-auth for `read_orders` and
  `read_customers` (tracked separately). Until then the agent hedges; no blocker for
  Phase 1.
