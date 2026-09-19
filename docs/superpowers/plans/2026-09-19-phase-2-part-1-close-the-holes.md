# Phase 2 Part 1: Close the Holes in the Money Loop (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No order that was cancelled or refunded can be bought from the supplier, a cancel after the supplier order exists reaches the owner, webhook subscriptions are assured and visible, the tracking write-back uses the supported mutation, and every order leaves a trail.

**Architecture:** Decisions live in small pure modules (`src/order-gate.ts`, `src/order-cancel.ts`) that are unit tested without a network. `src/fulfil-run.ts`, `src/index.ts` and `src/jobs.ts` only wire them. All database access stays in `src/tenant-store.ts`. One new append-only table, `order_events`.

**Tech Stack:** Cloudflare Workers, Hono, D1, vitest 4 with `@cloudflare/vitest-pool-workers`, Shopify Admin GraphQL 2026-04.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-2-money-loop-design.md` (approved by the owner 2026-09-19: "proceed"). Parent PRD: `docs/superpowers/specs/2026-09-18-production-grade-programme-prd.md`.

**Branch:** `phase-2-money-loop`, cut from master. Staging deploys from the branch. Production deploys from master after the merge, only on the owner's explicit go.

## Global Constraints

- Test first. Write the failing test, RUN it, see it fail for the right reason, then write the code. Report the observed failure text.
- No agent commits, pushes, deploys, or runs `scripts/rehearse-migrations.mjs`. The orchestrator commits through the gate.
- Never pass `--no-verify`. Never run `wrangler deploy` or `wrangler d1 migrations apply --remote`.
- All D1 access goes through `src/tenant-store.ts`. `tests/guard.test.ts` scans every file under `src/`, comments included, for raw D1 access; do not write `.prepare(` or `env.DB` anywhere else, not even in a comment.
- Every new table carries `shop` first in its primary key, and every new store method binds `this.shop`.
- No em dash and no en dash anywhere: code, comments, tests, docs, alert text.
- Owner alert text: plain, factual, no customer name, address, email or phone. Never claim or imply UK fulfilment.
- `order_events.detail` never holds a name, address, email or phone.
- Match the surrounding code: comment density, naming, 2 space indent, single quotes.
- Before editing a shared file (`src/tenant-store.ts`, `src/index.ts`, `src/fulfil-run.ts`, `src/jobs.ts`), run `python -P -m graphite context <file>` and `python -P -m graphite impact <file>` and read the call sites named. Use the graph, not grep, for who-calls questions. Single-file greps for literal text are fine.
- `src/console/page.ts` is one template literal holding HTML, CSS and browser JS. `tsc` cannot see errors inside it. After any edit run `npx vitest run tests/console.test.ts` and `npm run lint`. Double every backslash inside it.
- Python that prints must start with `sys.stdout.reconfigure(encoding='utf-8')`. Do not put backslash escapes inside a Bash heredoc; use the Edit or Write tool.
- Leave these untracked files alone: `GRAPHITE-HANDOVER.md`, `cart-summary.png`, `how-we-bundle.png`.
- Stay inside this repository.

## Verified facts the tasks rely on (checked 2026-09-19)

- These five documents validate against the Admin 2026-04 schema: the gate query in Task 2, `fulfillmentCreate(fulfillment: FulfillmentInput!)`, `webhookSubscriptions(first: 50) { nodes { id topic uri } }`, and `webhookSubscriptionCreate` with `topic: ORDERS_CANCELLED` and `topic: REFUNDS_CREATE` using `webhookSubscription: { uri, format: JSON }`.
- `callbackUrl` and `WebhookSubscription.endpoint` are deprecated; use `uri`.
- `CUSTOMERS_REDACT`, `CUSTOMERS_DATA_REQUEST` and `SHOP_REDACT` are NOT values of `WebhookSubscriptionTopic`. Today's `registerWebhooks` asks for them and fails on all three, quietly, at every install. They are configured in the app configuration, not through the API, and leave this plan's topic list.
- `orders.status` has no CHECK constraint (`migrations/0007_orders.sql`), so new status values need no table rebuild.
- `tests/fulfil-run.test.ts` uses `noAdmin`, a fake that answers `{}` to every query. Under a gate that fails closed, `{}` reads as "order missing". Task 5 changes that shared helper once; no other test file uses it.
- No test drives `/webhooks/orders-paid` over HTTP today. `tests/affiliate-console.test.ts` (from line 240) shows the pattern for a correctly signed request against the real Hono app.
- The daily chain in `src/jobs.ts` is a list of stages `{ name, maxMs, run(ctx, offset, deadline) }`; `ctx` carries `store`, `admin`, `cfg`, `env`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `migrations/0041_order_events.sql` | The trail table | 1 |
| `src/tenant-store.ts` | `addOrderEvent`, `listOrderEvents`, `countTrailingOrderEvents`, `address_json` in `updateOrder`, erasure of trail rows | 1 |
| `tests/order-events-store.test.ts` | Store tests for the trail | 1 |
| `src/order-gate.ts` (new) | The pre-spend read and the pure decision | 2 |
| `src/fulfil.ts` | Export `addressComplete` (one word changes) | 2 |
| `tests/order-gate.test.ts` (new) | One test per decision row | 2 |
| `src/webhooks.ts` | Topic list, `ensureWebhooks`, `listWebhookTopics` | 3 |
| `tests/webhooks.test.ts` | Ensure and read-back tests | 3 |
| `src/order-cancel.ts` (new) | Cancel and refund decisions and their application | 4 |
| `tests/order-cancel.test.ts` (new) | One test per status row | 4 |
| `src/fulfil-run.ts`, `tests/fulfil-run.test.ts` | Wire the gate, the trail, mixed origin, `fulfillmentCreate`, failure alerts | 5 |
| `src/index.ts`, `src/jobs.ts`, `tests/order-webhook-routes.test.ts` (new) | Routes, API, daily stage | 6 |
| `src/console/page.ts`, `tests/console.test.ts` | Timeline, subscription line, button | 7 |
| `docs/decisions/0002-money-loop.md`, `docs/RUNBOOK-ORDERS.md`, `docs/STATES.md`, `src/system-states.ts` | Decisions, the part 2 procedure, the state map and its registry | 8 |

Order: Task 1 alone first. Then Tasks 2, 3, 4 and 8 in parallel (disjoint files). Then Task 5. Then Tasks 6 and 7 in parallel. Then Task 9 (acceptance).

---

### Task 1: The order trail (storage)

**Files:**
- Create: `migrations/0041_order_events.sql`
- Modify: `src/tenant-store.ts` (the orders section near `updateOrder`, and `redactOrders` / `redactShop`)
- Test: `tests/order-events-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exported from `src/tenant-store.ts`):

```ts
export type OrderEventKind =
  | 'received' | 'held' | 'queued' | 'released'
  | 'gate-passed' | 'gate-held' | 'gate-unreadable' | 'address-refreshed'
  | 'stock-ok' | 'stockout' | 'supplier-order-created' | 'awaiting-payment' | 'paid'
  | 'tracking-found' | 'tracking-written' | 'tracking-write-failed'
  | 'cancel-received' | 'refund-received' | 'owner-alerted' | 'operator-action' | 'error';

export interface OrderEventRow {
  shop: string; shopify_order_id: string; seq: number; at: string; kind: OrderEventKind; detail: string | null;
}

// methods on TenantStore
addOrderEvent(shopifyOrderId: string, kind: OrderEventKind, detail?: string | null): Promise<void>;
listOrderEvents(shopifyOrderId: string): Promise<OrderEventRow[]>;            // seq ascending
countTrailingOrderEvents(shopifyOrderId: string, kind: OrderEventKind): Promise<number>;
```

`updateOrder` additionally accepts `address_json` (same COALESCE pattern as its other fields).

- [ ] **Step 1: Write the migration**

```sql
-- Order trail (phase 2): one append-only row per step an order goes through,
-- so a failed or disputed order can be reconstructed and the owner can see what
-- happened without reading logs. `detail` is short plain text and must never
-- hold a name, an address, an email or a phone number.
CREATE TABLE order_events (
  shop              TEXT NOT NULL,
  shopify_order_id  TEXT NOT NULL,
  seq               INTEGER NOT NULL,   -- 1, 2, 3 ... per order
  at                TEXT NOT NULL,      -- ISO time
  kind              TEXT NOT NULL,
  detail            TEXT,
  PRIMARY KEY (shop, shopify_order_id, seq)
);
```

- [ ] **Step 2: Write the failing tests** in `tests/order-events-store.test.ts` (setup as in `tests/fulfil.test.ts`: `applyD1Migrations` in `beforeEach`):
  1. `addOrderEvent` numbers events 1, 2, 3 for one order, and a second order in the same shop starts again at 1.
  2. `listOrderEvents` returns them in `seq` order with the kinds and details given.
  3. Two shops with the SAME order id do not see each other's events (two `TenantStore` instances).
  4. `detail` longer than 300 characters is stored cut to 300.
  5. `addOrderEvent` does not throw when the database throws: build a `TenantStore` over a fake `db` whose `prepare` throws, call it, expect it to resolve.
  6. `countTrailingOrderEvents('O1', 'gate-unreadable')` is 0 with no events, 2 after `[gate-passed, gate-unreadable, gate-unreadable]`, and 0 again after a following `gate-passed`.
  7. `redactOrders(['O1'])` removes O1's events and leaves O2's.
  8. `redactShop()` removes every event for the shop and leaves another shop's.
  9. `updateOrder('O1', { address_json: '{"city":"X"}' })` changes `address_json` and leaves `status` alone.

- [ ] **Step 3: Run them and see them fail.** `npx vitest run tests/order-events-store.test.ts`. Expected: failures naming the missing methods or the missing table.

- [ ] **Step 4: Implement.**
  - `addOrderEvent` is ONE statement so the number cannot collide:
    `INSERT INTO order_events (shop, shopify_order_id, seq, at, kind, detail) SELECT ?1, ?2, COALESCE(MAX(seq), 0) + 1, ?3, ?4, ?5 FROM order_events WHERE shop = ?1 AND shopify_order_id = ?2`
  - Wrap the whole body in try/catch; on failure `console.warn('order event not recorded for <id> (<kind>): <message>')` and return. The trail must never fail the step that raised it.
  - `countTrailingOrderEvents`: read the most recent 20 events by `seq DESC` and count from the top while `kind` matches.
  - `redactOrders`: delete the matching `order_events` rows in the same chunk loop. `redactShop`: add `DELETE FROM order_events WHERE shop = ?1` to its batch.

- [ ] **Step 5: Run the tests to green**, then `npx vitest run tests/fulfil.test.ts tests/guard.test.ts` and `npm run typecheck`. Any test that enumerates the tables `redactShop` must cover has to stay green; if one fails because it does not know `order_events`, add the table to it.

---

### Task 2: The live-order gate (pure)

**Files:**
- Create: `src/order-gate.ts`
- Modify: `src/fulfil.ts` (add `export` to `addressComplete`, nothing else)
- Test: `tests/order-gate.test.ts`

**Interfaces:**
- Consumes: `riskHold`, `addressComplete`, `OrderAddress` from `src/fulfil.ts`; `AdminGraphql` from `src/shopify-admin.ts`.
- Produces:

```ts
export const ORDER_GATE_QUERY: string;   // exactly the document below

export interface OrderSnapshot {
  exists: boolean;
  cancelledAt: string | null;
  financialStatus: string | null;     // Shopify displayFinancialStatus
  fulfillmentStatus: string | null;   // Shopify displayFulfillmentStatus
  riskRecommendation: string | null;  // ACCEPT | INVESTIGATE | CANCEL | NONE | null
  address: OrderAddress | null;       // null when Shopify returned no shipping address
}

export type GateRead = { ok: true; snapshot: OrderSnapshot } | { ok: false; error: string };

/** Never throws. ok:false means "could not tell", which the caller treats as DO NOT SPEND. */
export function readOrderGate(admin: AdminGraphql, shopifyOrderId: string): Promise<GateRead>;

export type GateHoldReason = 'refunded' | 'not-paid' | 'already-fulfilled' | 'on-hold' | 'order-missing' | 'incomplete-address' | 'high-risk' | 'medium-risk-value';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | null;

export type GateDecision =
  | { action: 'proceed'; address: OrderAddress; addressChanged: boolean; riskLevel: RiskLevel }
  | { action: 'cancel'; reason: 'shopify-cancelled' }
  | { action: 'hold'; reason: GateHoldReason; riskLevel: RiskLevel };

export function decideGate(
  s: OrderSnapshot,
  stored: { address: OrderAddress | null; totalPrice: number; skipRisk: boolean }
): GateDecision;
```

The document, verbatim:

```graphql
query pawscoutOrderGate($id: ID!) {
  order(id: $id) {
    cancelledAt
    closed
    displayFinancialStatus
    displayFulfillmentStatus
    risk { recommendation }
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
  }
}
```

Decision order (first match wins):

1. `exists` false: hold `order-missing`.
2. `cancelledAt` set: cancel `shopify-cancelled`.
3. `financialStatus`, compared in upper case: `REFUNDED`, `PARTIALLY_REFUNDED` or `VOIDED` hold `refunded`; anything other than `PAID`, including null, holds `not-paid` (amended in fix round 1: the gate is a whitelist on payment).
4. `fulfillmentStatus`, compared in upper case: `FULFILLED` or `PARTIALLY_FULFILLED` hold `already-fulfilled`; `ON_HOLD` holds `on-hold` (added in fix round 1); any other value, and null, passes this step.
5. Address: take `s.address` when Shopify returned one, else the stored one (a missing Shopify address is NOT a change). If the chosen address fails `addressComplete`: hold `incomplete-address`. `addressChanged` is true only when Shopify returned an address and it differs from the stored one after trimming and lower-casing every field.
6. Risk, unless `skipRisk`: `riskHold(s.riskRecommendation, stored.totalPrice)`; a value holds with that reason. `riskLevel` is `HIGH` for `CANCEL`, `MEDIUM` for `INVESTIGATE`, `LOW` for any other non-null value, else null.
7. Otherwise proceed.

`readOrderGate`: calls `admin(ORDER_GATE_QUERY, { id: 'gid://shopify/Order/<id>' })`; `order` null or absent gives `exists: false`; maps `countryCodeV2` to `countryCode`; null strings become `''`; any throw gives `{ ok: false, error: message }`.

- [ ] **Step 1: Write the failing tests** in `tests/order-gate.test.ts`, one `it` per line:
  1. A live paid unfulfilled ACCEPT order with the same address proceeds, `addressChanged: false`, `riskLevel: 'LOW'`.
  2. `exists: false` holds `order-missing`.
  3. `cancelledAt` set cancels `shopify-cancelled`.
  4. Cancelled AND refunded cancels (precedence).
  5. `REFUNDED` holds `refunded`. 6. `PARTIALLY_REFUNDED` holds `refunded`. 7. `VOIDED` holds `refunded`.
  8. `FULFILLED` holds `already-fulfilled`. 9. `PARTIALLY_FULFILLED` holds `already-fulfilled`.
  10. Shopify address differs: proceeds with the SHOPIFY address and `addressChanged: true`.
  11. Shopify address differs only in case and surrounding spaces: `addressChanged: false`.
  12. Shopify address null, stored complete: proceeds with the stored address, `addressChanged: false`.
  13. Shopify address present but missing `zip`: holds `incomplete-address`.
  14. Both addresses null: holds `incomplete-address`.
  15. `CANCEL` recommendation holds `high-risk` with `riskLevel: 'HIGH'`.
  16. `INVESTIGATE` at GBP 41 holds `medium-risk-value`; at GBP 39 proceeds with `riskLevel: 'MEDIUM'`.
  17. `skipRisk: true` with `CANCEL` proceeds. 18. `skipRisk: true` with `cancelledAt` set STILL cancels.
  19. `readOrderGate`: an admin that throws gives `{ ok: false }` and does not throw.
  20. `readOrderGate`: `{ order: null }` gives `exists: false`.
  21. `readOrderGate`: maps `countryCodeV2: 'GB'` to `countryCode: 'GB'` and sends the id as `gid://shopify/Order/123`.

- [ ] **Step 2: Run and see them fail** (`npx vitest run tests/order-gate.test.ts`): module not found.
- [ ] **Step 3: Implement** `src/order-gate.ts` and export `addressComplete`.
- [ ] **Step 4: Green**, then `npm run typecheck`, `npm run lint`, `npx vitest run tests/fulfil.test.ts tests/guard.test.ts`.

---

### Task 3: Webhook assurance

**Files:**
- Modify: `src/webhooks.ts`
- Test: `tests/webhooks.test.ts`

**Interfaces:**
- Consumes: `AdminGraphql`, `makeAdminGraphql` from `src/shopify-admin.ts`.
- Produces:

```ts
/** The ONLY list of API-managed topics in the codebase. */
export const REQUIRED_TOPICS: readonly { topic: string; path: string }[];
// APP_UNINSTALLED /webhooks/uninstall, ORDERS_PAID /webhooks/orders-paid,
// ORDERS_CANCELLED /webhooks/orders-cancelled, REFUNDS_CREATE /webhooks/refunds-create

export const ORDER_EVENT_TOPICS: readonly string[];   // ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']

export interface WebhookStatus {
  ok: boolean;          // true when nothing required is missing after the read-back
  present: string[];    // required topics registered at OUR uri
  created: string[];    // topics this call created
  missing: string[];    // required topics still absent after the read-back
  errors: string[];     // one message per failed create or list
  checkedAt: string;    // ISO time
}

export function listWebhookTopics(admin: AdminGraphql): Promise<{ topic: string; uri: string }[]>;
/** Never throws. Lists, creates what is missing, then LISTS AGAIN and reports from that read-back. */
export function ensureWebhooks(admin: AdminGraphql, appUrl: string): Promise<WebhookStatus>;
/** Kept for /auth/callback: same signature as today, now a thin wrapper over ensureWebhooks. */
export function registerWebhooks(shop: string, accessToken: string, appUrl: string, fetchImpl?: typeof fetch): Promise<RegisterResult>;
```

Documents, verbatim:

```graphql
query pawscoutHooks { webhookSubscriptions(first: 50) { nodes { id topic uri } } }

mutation pawscoutHook($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    userErrors { message }
    webhookSubscription { id }
  }
}
```

Rules: a topic counts as present only when registered at `appUrl + path` (a subscription of the same topic at another uri is not ours). A `userErrors` message matching `/already been taken/i` counts as success. The three privacy topics are removed from the list, with a comment giving the reason recorded under "Verified facts". `registerWebhooks` returns `{ ok: true }` when `missing` is empty, else `{ ok: false, error: 'missing: <topics>' }`.

- [ ] **Step 1: Write the failing tests** (a fake `AdminGraphql` that records calls and answers from a mutable list of registered `{ topic, uri }`):
  1. Nothing registered: creates all four, `created` lists four, `missing` empty, `ok` true.
  2. All four present at our uri: no create call is made, `present` lists four.
  3. `ORDERS_PAID` present at a DIFFERENT uri: it is created at ours.
  4. A create returns a real user error: the topic is in `missing`, the message is in `errors`, `ok` false, and the other topics are still attempted.
  5. "already been taken" is not an error.
  6. The list query throws: `ok` false, one error, nothing thrown.
  7. The create variables use `uri`, never `callbackUrl`.
  8. `REQUIRED_TOPICS` holds exactly those four topics and none of the three privacy topics.
  9. `registerWebhooks` still resolves `{ ok: true }` for a fetch fake that lists nothing then accepts every create and lists all four.
  Rewrite the existing tests that asserted the privacy topics; keep what they proved about one failing topic not stopping the others.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, `npm run typecheck`, `npm run lint`.

---

### Task 4: Cancel and refund decisions

**Files:**
- Create: `src/order-cancel.ts`
- Test: `tests/order-cancel.test.ts`

**Interfaces:**
- Consumes: `TenantStore`, `OrderRow` (Task 1's `addOrderEvent`), nothing from the network.
- Produces:

```ts
export interface OwnerAlert { subject: string; text: string }

export interface CancelOutcome { changed: boolean; alert: OwnerAlert | null }

/** Order id from an orders/cancelled payload ('' when absent). */
export function cancelledOrderId(raw: unknown): string;
/** Order id, the refund's own id, and the refunded amount from a refunds/create payload. */
export function refundInfo(raw: unknown): { orderId: string; refundId: string; amount: number; currency: string };

export function applyCancel(store: TenantStore, shopifyOrderId: string): Promise<CancelOutcome>;
export function applyRefund(store: TenantStore, info: { orderId: string; refundId: string; amount: number; currency: string }): Promise<CancelOutcome>;
```

**Amended in fix round 1 (2026-09-19), and binding on Task 6.** The task review showed that "skip when the last event matches" re-alerts on a redelivered cancel for a `fulfilled` row and on a third identical refund. Dedupe is on the identity of the event, read from the WHOLE trail: a cancel is deduped by an existing `cancel-received` event; a refund by Shopify's own refund id, which is written into the event detail as `refund <refundId>: <currency> <amount>`. Every refund on a known row writes `refund-received`, including on a `cancelled` row, which never alerts. Where the tables below disagree with this paragraph, this paragraph wins.

`refundInfo`: `orderId` is `order_id`; `amount` is the sum of `transactions[].amount` where `kind === 'refund'` (numbers may arrive as strings); `currency` is the first such transaction's `currency`, else `''`.

`applyCancel`, by the row's status when called:

| Status | New status | Events written | Alert |
|---|---|---|---|
| no row | none | none | null |
| `held`, `queued`, `received`, `error` | `cancelled` | `cancel-received` | null |
| `awaiting-payment` | `cancelled` | `cancel-received`, `owner-alerted` | subject `Order <name> was cancelled: do NOT pay the supplier`; text below |
| `submitted` | `cancelled` | `cancel-received`, `owner-alerted` | subject `Order <name> was cancelled after it was paid at the supplier` |
| `fulfilled` | unchanged | `cancel-received`, `owner-alerted` | subject `Order <name> was cancelled after it shipped` |
| `cancelled` | unchanged | none | null (`changed: false`) |

Alert texts, verbatim (`<name>` is `order_name` or the id, `<cj>` is `cj_order_id`):

- awaiting-payment: `Order <name> was cancelled in Shopify. Supplier order <cj> was created for it and is still unpaid. Do NOT pay it. Cancel it at the supplier. Nothing has been spent.`
- submitted: `Order <name> was cancelled in Shopify after supplier order <cj> was paid. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.`
- fulfilled: `Order <name> was cancelled in Shopify after it shipped (tracking <tracking_number>). Treat it as a return.`

`hold_reasons` on a cancel becomes `["shopify-cancelled"]`.

`applyRefund`: no row gives no change. A row with no `cj_order_id` and status `held`, `queued` or `received` becomes `held` with `hold_reasons` `["refunded"]`, event `refund-received`, no alert. A row WITH a `cj_order_id` (any status) is unchanged, events `refund-received` and `owner-alerted`, alert subject `Order <name> was refunded <currency> <amount>` and text `Order <name> was refunded <currency> <amount> in Shopify. Supplier order <cj> exists for it (status here: <status>). Decide whether the supplier order should still go ahead.` A row already `cancelled` writes nothing. The second delivery of the same refund must not alert twice: before alerting, skip when the last event is already `owner-alerted` with the same detail.

- [ ] **Step 1: Write the failing tests**: one per row of both tables, plus: a second `applyCancel` on the same order returns `changed: false`, writes no event and returns no alert; a second identical `applyRefund` returns no alert; `cancelledOrderId` reads a numeric `id` as a string; `refundInfo` sums two refund transactions given as strings and ignores a `kind: 'sale'` one; no alert text contains a customer name or address; no text contains an em or en dash.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** No network, no email here: the caller sends the alert.
- [ ] **Step 4: Green**, `npm run typecheck`, `npm run lint`, `npx vitest run tests/guard.test.ts`.

---

### Task 5: Wire the pipeline

**Files:**
- Modify: `src/fulfil-run.ts`, `tests/fulfil-run.test.ts`

**Interfaces:**
- Consumes: Task 1 (`addOrderEvent`, `countTrailingOrderEvents`, `address_json` in `updateOrder`), Task 2 (`readOrderGate`, `decideGate`), `alertOwner` from `src/owner-alert.ts`.
- Produces: `processDueOrders` and `pollTracking` gain one optional callback in `opts`: `alert?: (subject: string, text: string) => Promise<void>`. `runOrderPipelineForShop` passes `(s, t) => alertOwner(env, cfg, s, t)`. The return shapes are unchanged.

Changes, in the order the code runs:

1. **Test helper first.** In `tests/fulfil-run.test.ts` replace `noAdmin` with `liveAdmin(over?)`: a fake that answers the gate query with a live, paid, unfulfilled `ACCEPT` order whose shipping address equals the seeded `ADDRESS` (with `countryCodeV2: 'GB'`), and `{}` otherwise. Every existing test must pass unchanged in meaning.
2. **Gate before create.** Replace the `fetchOrderRisk` block with `readOrderGate` then `decideGate` (`skipRisk` = `!!o.cj_order_id || hasHoldHistory(o.hold_reasons)`). `fetchOrderRisk` and `ORDER_RISK` are deleted.
   - read `ok: false`: write `gate-unreadable` with the error, leave the row `queued`, `continue`. If `countTrailingOrderEvents(id, 'gate-unreadable')` is exactly 4 after the write, call `opts.alert` once with subject `Order <name> cannot be checked against Shopify` and text `Order <name> has been due for an hour but its state in Shopify could not be read (<error>). Nothing has been sent to the supplier. It is retried every 15 minutes.`, then write `owner-alerted`.
   - `cancel`: status `cancelled`, `hold_reasons` `["shopify-cancelled"]`, event `gate-held` detail `shopify-cancelled`, count it as `held`.
   - `hold`: status `held`, `hold_reasons` `[reason]`, `risk_level` when known, event `gate-held`, count as `held`.
   - `proceed`: event `gate-passed`; when `addressChanged`, store the new `address_json`, write `address-refreshed`, and use the fresh address for the supplier order; stamp `risk_level` as today.
3. **Mixed origin.** After resolving every line, if the resolved origins are not all equal: status `held`, `hold_reasons` `["mixed-origin"]`, event `gate-held` detail `mixed-origin: <origins>`, count as `held`, `continue`. No supplier order is created.
4. **Trail.** Write `stock-ok` after the stock check passes for all lines, `supplier-order-created` (detail: the supplier order id) after `createOrder`, `awaiting-payment` in `markAwaiting`, `paid` after `payBalance`, `stockout` or `error` (detail: the first 200 characters of the message) in the catch.
5. **Gate again before pay.** Immediately before `cj.payBalance`, run the gate again with `skipRisk: true`. `cancel` or `hold` stops the payment exactly as in point 2 (the supplier order id stays on the row) and additionally calls `opts.alert` with subject `Order <name>: payment to the supplier was stopped` and text `Order <name> changed in Shopify (<reason>) after supplier order <cj> was created and before it was paid. It has NOT been paid. Cancel it at the supplier.`
6. **Write-back.** `FULFILL` becomes `fulfillmentCreate(fulfillment: $f)` with `$f: FulfillmentInput!`; the variables are unchanged. In `pollTracking`: on a tracking number write `tracking-found` once (skip when the order's events already hold one); on success `tracking-written`; on failure `tracking-write-failed` with the message, and when `countTrailingOrderEvents(id, 'tracking-write-failed')` is exactly 4 call `opts.alert` with subject `Order <name>: tracking could not be written to Shopify` and text `Supplier order <cj> has shipped with tracking <number>, but writing it to Shopify has failed 4 times (<error>). The customer has not been told. It is retried every 15 minutes.`

- [ ] **Step 1: Change the helper and run the existing suite**: `npx vitest run tests/fulfil-run.test.ts`. Expected: still green (nothing uses the gate yet).
- [ ] **Step 2: Write the failing tests:**
  1. Gate says cancelled: no `createOrder`, no `payBalance`, row `cancelled`, a `gate-held` event.
  2. Gate says `REFUNDED`: no `createOrder`, row `held` with `["refunded"]`.
  3. Gate says `FULFILLED`: no `createOrder`, row `held`.
  4. Gate read throws: no `createOrder`, row stays `queued`, a `gate-unreadable` event, no alert on the first failure.
  5. Gate read throws on four consecutive runs: exactly ONE alert, on the fourth.
  6. An operator-released order (hold history) with a `CANCEL` recommendation is created (risk skipped), but with `cancelledAt` set it is NOT created.
  7. A changed Shopify address: `createOrder` receives the NEW address, the row's `address_json` is updated, an `address-refreshed` event exists.
  8. A pay retry (`cj_order_id` set, not `createOnly`) whose gate now says cancelled: `payBalance` is NOT called, the alert is sent, the row is `cancelled` and keeps its `cj_order_id`.
  9. Two lines resolving to `CN` and `GB`: no `createOrder`, row `held` with `["mixed-origin"]`.
  10. A happy `createOnly` run leaves the events, in order: `gate-passed`, `stock-ok`, `supplier-order-created`, `awaiting-payment`.
  11. A happy paying run ends with `paid`.
  12. `pollTracking` sends a document containing `fulfillmentCreate(` and not `fulfillmentCreateV2`.
  13. Write-back fails four polls in a row: four `tracking-write-failed` events, exactly one alert, the row is still `submitted`.
  14. Write-back succeeds: `tracking-found` then `tracking-written`, and a second poll of an already fulfilled order writes nothing.
- [ ] **Step 3: Run and see them fail.**
- [ ] **Step 4: Implement**, after `python -P -m graphite impact src/fulfil-run.ts`.
- [ ] **Step 5: Green** for the file, then `npx vitest run tests/fulfil.test.ts tests/order-gate.test.ts tests/console-glance.test.ts`, `npm run typecheck`, `npm run lint`.

---

### Task 6: Routes, API and the daily stage

**Files:**
- Modify: `src/index.ts`, `src/jobs.ts`
- Test: `tests/order-webhook-routes.test.ts` (new)

**Interfaces:**
- Consumes: Task 1, Task 3 (`ensureWebhooks`, `ORDER_EVENT_TOPICS`, `WebhookStatus`), Task 4 (`cancelledOrderId`, `refundInfo`, `applyCancel`, `applyRefund`), `alertOwner`.
- Produces (the console in Task 7 relies on these exact shapes):
  - `POST /api/orders` adds `hooks: { ok: boolean; missing: string[]; checkedAt: string } | null` (null when never checked), read from the cache key below.
  - `POST /api/order-events` body `{ id: string }` answers `{ ok: true, events: { seq: number; at: string; kind: string; detail: string | null }[] }`, or 404 `{ ok: false, error: 'Order not found' }`.
  - `POST /api/ensure-webhooks` runs `ensureWebhooks` for the session's shop, stores the result, answers `{ ok: true, hooks: WebhookStatus }`.
  - Cache key `job:order-webhooks` (through `putSearchCache`, `JOB_STAMP_TTL_DAYS`) holds the JSON of the last `WebhookStatus`.

Changes:

1. `/webhooks/orders-cancelled` and `/webhooks/refunds-create`: the same shape as `/webhooks/orders-paid` (validate, read the shop header, try, log, ALWAYS answer 200 `ok`). Call `applyCancel` / `applyRefund`; when the outcome carries an alert, send it with `alertOwner(c.env, cfg, subject, text)` inside `c.executionCtx.waitUntil`. Skip silently when the shop has no config.
2. `/webhooks/orders-paid`: after `insertOrderIfNew` returns true, write `received`, then `held` (detail: the holds joined by a comma) or `queued` (detail: `fulfil after <iso>`).
3. `/api/order-action`: after the update, write `operator-action` (detail: the action); `release` also writes `released`.
4. `makeRegistrar` keeps calling `registerWebhooks` (now the Task 3 wrapper).
5. `src/jobs.ts`: a daily stage `{ name: 'order-webhooks', maxMs: 1 * MIN_MS }` placed FIRST in the chain: `ensureWebhooks(ctx.admin, ctx.env.SHOPIFY_APP_URL)`, store the result under `job:order-webhooks`, and when `missing` holds any of `ORDER_EVENT_TOPICS` call `alertOwner` with subject `Order events are not fully subscribed` and text `These Shopify order events are not reaching PawScout: <topics>. Until they do, a cancelled or refunded order can go unnoticed after the supplier order exists. Open the console and press "Check order events".`

- [ ] **Step 1: Write the failing tests** in `tests/order-webhook-routes.test.ts`, driving the real Hono app with signed requests (copy `hmacBase64` and the env setup from `tests/affiliate-console.test.ts`):
  1. `/webhooks/orders-cancelled` with a bad signature answers 401 and changes nothing.
  2. A valid cancel for a `queued` order makes it `cancelled`.
  3. The same valid cancel delivered twice leaves one `cancel-received` event.
  4. A valid cancel for an unknown order answers 200.
  5. A valid cancel for an `awaiting-payment` order makes it `cancelled` (the alert send is a no-op without a Resend key; assert the `owner-alerted` event).
  6. `/webhooks/refunds-create` with a bad signature answers 401.
  7. A valid refund for a `queued` order with no supplier order makes it `held` with `["refunded"]`.
  8. `/webhooks/orders-paid` with a valid body writes `received` then `queued`.
  9. A malformed JSON body on each new route still answers 200.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, after `python -P -m graphite impact src/index.ts` and `python -P -m graphite impact src/jobs.ts`.
- [ ] **Step 4: Green**, then the tests that cover the daily chain's stage list (find them with `python -P -m graphite query "callers runDailyMaintenance"`), `npm run typecheck`, `npm run lint`.

---

### Task 6c: An order event is not lost when its processing fails

Added during execution (2026-09-19) by an orchestrator ruling. Runs right after Task 6.

**The hole (H8).** The three order webhook routes answer 200 even when their own processing threw. Shopify redelivers only a delivery that did NOT get a 2xx, so a database blip loses a paid order, a cancel or a refund for good, although every handler is idempotent and a redelivery would have healed it.

**Files:**
- Create: `src/webhook-retry.ts`, `tests/webhook-retry.test.ts`
- Modify: `src/index.ts`, `tests/order-webhook-routes.test.ts`

**Verified facts (shopify.dev, 2026-09-19):** any answer outside 2xx is a failed delivery; Shopify allows 1 second to connect and 5 seconds for the whole request; a failed delivery is retried up to 8 times over 4 hours with backoff, and if failures persist the subscription is REMOVED; the header `X-Shopify-Webhook-Id` identifies one delivery and stays the same across its retries.

**Interfaces:**
- Consumes: `TenantStore.getSearchCache(key)`, `TenantStore.putSearchCache(key, payload, ttlDays)`, `OwnerAlert` from `src/order-cancel.ts`, `alertOwner`, and the three order webhook handlers Task 6 left structurally alike in `src/index.ts`.
- Produces:

```ts
// src/webhook-retry.ts
export const MAX_WEBHOOK_FAILURES = 3;
export function onWebhookFailure(
  store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>,
  input: { webhookId: string | null; topic: string; orderId: string }
): Promise<{ status: 200 | 500; alert: OwnerAlert | null }>;
```

Changes:

1. **The failure contract** of `/webhooks/orders-paid`, `/webhooks/orders-cancelled` and `/webhooks/refunds-create`. It replaces "always answer 200" for these three routes only:
   - Bad signature: 401, as now.
   - A body that is not JSON, or has no usable order id, or a shop with no installation or config: 200, nothing written, as now. It can never succeed, so asking for a retry is pointless.
   - Processing THROWS: log the error with `console.error`, then answer what `onWebhookFailure` says. When it returns an alert, send it with plain `alertOwner` inside `c.executionCtx.waitUntil` (there may be no order row to hang a trail on).
   - If the shop's store cannot even be built, answer 500.

2. **`onWebhookFailure`** counts the failures of ONE delivery under the cache key `whfail:<webhookId>` (the value is the count as a string; `putSearchCache` with a lifetime of 1 day):
   - `webhookId` is null or empty: `{ status: 500, alert: null }`.
   - Reading or writing the counter throws: `{ status: 500, alert: null }` (a store that is down is a passing fault by nature).
   - The new count is 1, 2 or 3: `{ status: 500, alert: null }`. Shopify redelivers; the handlers are idempotent.
   - The new count is 4 or more: `{ status: 200, alert }`, so the failures stop well short of the 8 that make Shopify remove the subscription. The alert is returned ONLY when the new count is exactly 4 (one alert per delivery); above 4 the alert is null. Subject `An order event from Shopify could not be processed`. Text `PawScout failed <count> times to process a Shopify <topic> event (order <orderId>). It has stopped asking Shopify to resend it, because repeated failures make Shopify remove the subscription. Check this order in Shopify and in the PawScout console.`, with `(unknown)` in place of an empty `orderId`.
   - It never throws.

3. Never copy a thrown error's message into an alert or into a trail detail. It goes to `console.error` only.

- [ ] **Step 1: Write the failing tests.**
  `tests/webhook-retry.test.ts` (real D1 store for the counting tests): calls 1, 2 and 3 for one `webhookId` answer 500 with no alert; call 4 answers 200 with the exact subject and text (assert both whole); call 5 answers 200 with no alert; a different `webhookId` counts separately from 1; a null and an empty `webhookId` answer 500; a store whose `getSearchCache` rejects answers 500 and does not throw; a store whose `putSearchCache` rejects answers 500 and does not throw; an empty `orderId` prints `(unknown)`.
  `tests/order-webhook-routes.test.ts`: a valid cancel whose processing throws (make `TenantStore.prototype.getOrder` reject once with `vi.spyOn`, and restore it) answers 500; the SAME delivery id sent again, now succeeding, answers 200 and the order is `cancelled` with one `cancel-received` event; four failures of one delivery id answer 500, 500, 500, 200; the same first-failure 500 on `/webhooks/orders-paid` and on `/webhooks/refunds-create`; a malformed JSON body on all three routes still answers 200; a bad signature still answers 401 and counts nothing.
- [ ] **Step 2: Run them and see each fail for the right reason.**
- [ ] **Step 3: Implement**, after `python -P -m graphite impact src/index.ts`.
- [ ] **Step 4: Green**: both test files, `tests/webhooks.test.ts`, `tests/order-cancel.test.ts`, `tests/guard.test.ts`, then `npm run typecheck` and `npm run lint`.

---

### Task 6b: An owner alert is confirmed or retried

Added during execution (2026-09-19) by an orchestrator ruling. Runs after Task 6c and before Task 6d.

**The hole (H7).** `alertOwner` answers `void` and only logs a failed send, and every caller then writes `owner-alerted`. While the owner pays the supplier by hand, an email is the only thing that stops a payment for an order the customer cancelled. A provider failure at the wrong moment loses "do NOT pay the supplier" for good, and the trail says the owner was told.

**The principle:** the marker that stops retrying is written only after the thing it records has happened.

Not used as the retry driver: Shopify's webhook redelivery. Answering 500 because OUR email failed would spend Shopify's 8 allowed failures on a fault Shopify cannot heal.

**Files:**
- Create: `src/order-alert.ts`, `tests/order-alert.test.ts`
- Modify: `src/owner-alert.ts`, `src/order-cancel.ts`, `src/tenant-store.ts`, `src/fulfil-run.ts`, `src/index.ts`
- Modify tests: `tests/order-cancel.test.ts`, `tests/fulfil-run.test.ts`, `tests/order-webhook-routes.test.ts`, `tests/order-events-store.test.ts`, and the existing test of `alertOwner` if there is one (find it with `python -P -m graphite query "callers alertOwner"`).

**Interfaces:**
- Consumes: Task 1 (`addOrderEvent`, `listOrderEvents`), Task 4 (`OwnerAlert`, `applyCancel`, `applyRefund`), Task 5 (every alert site in `src/fulfil-run.ts`, and `runOrderPipelineForShop`), Task 6 (the one alert door `sendOrderAlert` in `src/index.ts`).
- Produces:

```ts
// src/owner-alert.ts
export type AlertResult = 'sent' | 'failed' | 'unconfigured';
export function alertOwner(env: Env, cfg: TenantConfig, subject: string, text: string, fetchImpl?: typeof fetch): Promise<AlertResult>;

// src/order-alert.ts
export type AlertSend = (subject: string, text: string) => Promise<AlertResult>;
export const MAX_ALERT_ATTEMPTS = 12;
export const ALERT_RETRY_WINDOW_HOURS = 24;
export function deliverOrderAlert(store: TenantStore, shopifyOrderId: string, alert: OwnerAlert, send: AlertSend): Promise<AlertResult>;
export function retryOrderAlerts(store: TenantStore, send: AlertSend, now?: Date): Promise<{ retried: number; delivered: number }>;

// src/tenant-store.ts
// OrderEventKind gains 'owner-alert-failed'. No migration: order_events.kind is TEXT with no CHECK.
listOrderIdsWithEventSince(kind: OrderEventKind, sinceIso: string): Promise<string[]>;
```

Changes:

1. **`alertOwner`** answers what happened and still never throws. No alert address or no Resend key: `'unconfigured'`. `sendEmail` answered ok: `'sent'`. `sendEmail` answered not ok, or threw: log the existing warning and answer `'failed'`. The other callers ignore the result; leave them alone unless the compiler objects.

2. **Trail meaning, from now on:**
   - `owner-alerted`, detail = the alert's subject: the email provider ACCEPTED this alert.
   - `owner-alert-failed`, detail = the subject: one send of this alert failed. It will be retried.
   - `error`, detail `owner alert not configured: <subject>`: there is nobody to tell. Never retried.
   - `error`, detail `owner alert abandoned after 12 attempts: <subject>`: written once, together with the 12th failure.
   A subject holds an order name and an instruction, never customer data. Never put an alert's TEXT in the trail.

3. **`deliverOrderAlert`** calls `send`, writes exactly one of the markers above for its result (plus the `abandoned` line when this failure is the 12th for that subject on that order), and answers the result. A `send` that throws counts as `'failed'`. It never throws.

4. **`retryOrderAlerts`**: take the order ids from `listOrderIdsWithEventSince('owner-alert-failed', now minus 24 hours)`. For each, read the whole trail in `seq` order and keep a map from subject to `{ firstAt, failures }`: an `owner-alert-failed` with detail S sets or increments S (`firstAt` is the `at` of the FIRST failure); an `owner-alerted` with detail S deletes S. After the walk, every subject still in the map with `failures < 12` and `firstAt` inside the window gets ONE re-send through `deliverOrderAlert`, with the same subject and this text (the row's values; the literal `(not recorded)` where a value is null):

   ```
   This alert was first raised at <firstAt> and could not be delivered then.

   <subject>.

   Supplier order: <cj_order_id>. Tracking: <tracking_number>. Status here: <status>.

   Open the PawScout console, Orders, and open this order's trail for the full history.
   ```

   An order id with no row is skipped. One order failing never stops the sweep. `retried` counts re-sends, `delivered` counts those that answered `'sent'`.

5. **Every order alert goes through `deliverOrderAlert`**: `applyCancel` and `applyRefund` STOP writing `owner-alerted` (they still return the alert, and their dedupe rules do not change); every site in `src/fulfil-run.ts` that awaits the alert and then writes `owner-alerted` becomes one `deliverOrderAlert(store, id, { subject, text }, alert)` with its subject and text unchanged, and the `alert` option's type becomes `AlertSend`; the one alert door in `src/index.ts` sends through `deliverOrderAlert` (still inside `waitUntil`, still exactly one `waitUntil` per alert, because the route tests count them).

6. **The alert counters in `src/fulfil-run.ts`** (`>= 4` trailing `gate-unreadable` or `tracking-write-failed`): an `owner-alert-failed` marker breaks the trailing run exactly as `owner-alerted` does, so a failed alert is retried by the sweep in change 4, not raised again on the next tick. Check that this holds and pin it with a test.

7. **`runOrderPipelineForShop`** builds `alert` from `alertOwner` and, BEFORE `processDueOrders`, runs `retryOrderAlerts(store, alert)` inside its own try/catch with a `console.warn`, so it runs whatever `fulfil.mode` is and cannot stop the pipeline.

- [ ] **Step 1: Write the failing tests.**
  `tests/order-alert.test.ts` (real D1 store, a fake `send`):
  1. `'sent'` writes one `owner-alerted` whose detail is the subject.
  2. `'failed'` writes one `owner-alert-failed` whose detail is the subject, and no `owner-alerted`.
  3. `'unconfigured'` writes one `error` with detail `owner alert not configured: <subject>` and nothing else.
  4. A `send` that throws is treated as `'failed'`, and `deliverOrderAlert` does not throw.
  5. `retryOrderAlerts` re-sends a failed alert once, with the same subject and the text above built from the row (assert the whole text for a row with a supplier order id and no tracking number).
  6. After a retry answers `'sent'`, a second `retryOrderAlerts` sends nothing.
  7. Two different failed subjects on one order are both retried; delivering one leaves the other pending.
  8. A subject with 12 failures is not retried, and the 12th failure wrote exactly one `abandoned` line.
  9. A failure whose FIRST failure is older than 24 hours is not retried (pass `now`).
  10. An `owner-alerted` for subject A does not clear a pending subject B.
  11. No alert TEXT ever appears in the trail (seed a text holding a marker word, assert no detail contains it).
  `tests/order-cancel.test.ts`: every expectation of `['cancel-received', 'owner-alerted']` becomes `['cancel-received']`, and the refund equivalents likewise, with the returned alerts unchanged.
  `tests/fulfil-run.test.ts`: at each alert site, a `send` answering `'failed'` leaves `owner-alert-failed` and NO `owner-alerted`, and a `send` answering `'sent'` leaves `owner-alerted` with the subject as its detail; change 6's pin.
  `tests/order-webhook-routes.test.ts`: the alerting cancel on an `awaiting-payment` order now leaves `error` with detail `owner alert not configured: ...` in the trail (the tests have no Resend key) instead of `owner-alerted`; the `waitUntil` counts are unchanged.
  `tests/order-events-store.test.ts`: `listOrderIdsWithEventSince` returns each order id once, honours the time bound and the kind, and never returns another shop's orders.
- [ ] **Step 2: Run them and see each fail for the right reason.**
- [ ] **Step 3: Implement**, after `python -P -m graphite impact` on every file you modify, and `python -P -m graphite query "callers alertOwner"` to see every caller of the function whose return type changes.
- [ ] **Step 4: Green**: the five test files above, `tests/guard.test.ts`, `tests/webhooks.test.ts`, `tests/webhook-retry.test.ts`, `tests/console.test.ts`, then `npm run typecheck` and `npm run lint`.

---

### Task 6d: A supplier order that must not be paid as it stands is always flagged

Added during execution (2026-09-19) by orchestrator rulings, from the Task 5 review and from three findings the security gate's own reviewer opened on the pushed branch. Runs LAST among the code tasks, after Task 6b (its alerts go out through `deliverOrderAlert`).

While the owner pays the supplier by hand, there is no moment "just before the payment" for a gate to stand at. So whenever a supplier order exists and something makes paying it wrong, the owner must be told, by every path that can notice.

- **H9.** `applyCancel` alerts only for `awaiting-payment`, `submitted` and `fulfilled`. Rows in other statuses hold a supplier order too: an operator release maps a row back to `queued` and keeps `cj_order_id`; a pre-pay gate hold writes `held` and keeps it; a failed or timed-out payment lands in `error` and keeps it. A cancel of any of these tells nobody.
- **H10.** `applyCancel` decides from a status it read BEFORE its own write. The pipeline side was made atomic; the webhook side was not. Sequence: the pipeline is waiting on `createOrder`; the cancel reads `queued` and chooses no alert; the pipeline's conditional write succeeds (the row is not cancelled yet) and emails "pay it"; the cancel then writes `cancelled`. Nobody is told not to pay.
- **H11.** A cancel reaches us by webhook only. If that delivery is lost, or the subscription was removed and the nightly check has not healed it yet, an order sits in `awaiting-payment` while Shopify says cancelled, and the owner pays it.
- **H12.** A delivery address changed after the supplier order was created is saved here and then ignored: the pipeline pays (or asks the owner to pay) a supplier order that still carries the OLD address, while the trail shows the new one.

**Files:**
- Modify: `src/order-cancel.ts`, `src/fulfil-run.ts`
- Modify tests: `tests/order-cancel.test.ts`, `tests/fulfil-run.test.ts`

**Interfaces:**
- Consumes: Task 2 (`readOrderGate`, `decideGate`), Task 4 (`applyCancel`, `OwnerAlert`), Task 5 (`processDueOrders`, `runOrderPipelineForShop`, `updateOrderUnlessCancelled`), Task 6b (`deliverOrderAlert`, `AlertSend`).
- Produces:

```ts
// src/fulfil-run.ts
export function recheckAwaitingPayment(
  store: TenantStore, admin: AdminGraphql, send: AlertSend, opts?: { max?: number }
): Promise<{ checked: number; cancelled: number; addressChanged: number }>;
// GateHoldReason is NOT widened; the new hold reason is a plain string written by this file:
//   'address-changed-after-supplier-order'
```

## Part A: `applyCancel` writes first, then decides from a fresh read (H9, H10)

1. Order of work on a first delivery (the dedupe on an existing `cancel-received` stays first and unchanged): read the row; write `cancelled` with `["shopify-cancelled"]` unless the row is `fulfilled` or already `cancelled`; write `cancel-received`; READ THE ROW AGAIN; decide the alert from both reads:
   - the FIRST read's status was `awaiting-payment`, `submitted` or `fulfilled`: that status's alert, texts unchanged, with the supplier order id and tracking number taken from the SECOND read;
   - otherwise, the SECOND read has a `cj_order_id`: subject `Order <name> was cancelled and a supplier order exists for it`, text `Order <name> was cancelled in Shopify. Supplier order <cj order id> exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.` (No claim about payment: such a row can be unpaid or paid.)
   - otherwise none.
   An already `cancelled` row still raises nothing. Why this closes the race: if the pipeline wrote its supplier order id before our second read, we alert; if it writes after, its own conditional status write is refused (the row is cancelled) and the pipeline alerts. Say that in the function's comment.

## Part B: a changed address never reaches a payment silently (H12)

2. In `processDueOrders`, whenever the row ALREADY has a supplier order (`o.cj_order_id` at the pre-create position, which is every pay-retry, or the id just created at the pre-pay position) and the gate's `proceed` decision says `addressChanged`: save the new address and write `address-refreshed` as today, then STOP: set the row `held` with hold reason `address-changed-after-supplier-order` through `updateOrderUnlessCancelled`, write `gate-held` with that reason as its detail, count it as `held`, do NOT pay, do NOT call `opts.notify`, and alert:
   - subject: `Order <name>: the delivery address changed after the supplier order was created`
   - text: `The delivery address of order <name> was changed in Shopify after supplier order <cj order id> was created, so the supplier order still carries the old address. Do NOT pay it as it stands. Correct the address on the supplier order at the supplier, then release the order in the PawScout console. If the supplier cannot change it, cancel the supplier order there and handle this order by hand.`
   Because the new address is saved before the hold, a later release no longer sees a change and carries on. A row with NO supplier order keeps today's behaviour (refresh the address and carry on: the supplier order is then created with the new one). The alert never holds the address itself.

## Part C: rows awaiting a hand payment are re-read in Shopify on every tick (H11, H12)

3. **`recheckAwaitingPayment`**: for each row of `listOrders('awaiting-payment')` (at most `max`, default 20): `readOrderGate(admin, id)`.
   - Unreadable: skip the row and write nothing (the next tick tries again).
   - `cancelledAt` is set: `applyCancel(store, id)` and, when it returns an alert, `deliverOrderAlert`. Count `cancelled`. Because `applyCancel` dedupes on the trail, a cancel that ALSO arrives by webhook is handled exactly once, whichever comes first.
   - Otherwise, Shopify's shipping address is present and differs from the stored one (use `decideGate` with the stored address and `skipRisk: true`, and act only on a `proceed` decision whose `addressChanged` is true): exactly change 2's save, hold and alert. Count `addressChanged`.
   - Anything else (including a gate `hold` such as `refunded`): nothing. A refund without a cancel stays with the webhook path on purpose: it is not an instruction to stop, and the gate read carries no refund identity to dedupe on.
4. **`runOrderPipelineForShop`** runs `recheckAwaitingPayment(store, admin, alert)` right after `retryOrderAlerts` and BEFORE `processDueOrders`, inside its own try/catch with a `console.warn`, so it runs whatever `fulfil.mode` is and cannot stop the pipeline.

- [ ] **Step 1: Write the failing tests.**
  `tests/order-cancel.test.ts`: for EACH of `held`, `queued`, `received` and `error`, a row WITH a supplier order gets the exact Part A generic alert on the first delivery and none on the second, and a row WITHOUT one gets none; the race: a store wrapper whose `updateOrder` (the cancel's own write) first lets a simulated pipeline set `cj_order_id` and `awaiting-payment` on the row, so the first read says `queued` with no supplier order and the second read has one: the generic alert IS returned and the row ends `cancelled`; the three per-status alerts are unchanged and take the supplier order id from the second read.
  `tests/fulfil-run.test.ts`: a pay-retry (`queued` with `cj_order_id`) whose Shopify address differs: the row ends `held` with `["address-changed-after-supplier-order"]`, the stored address is the NEW one, nothing is paid, `notify` is not called, the exact alert is delivered, and the alert text contains neither the old nor the new street; the same at the pre-pay position (the address changes between the two gate reads); after a release the same row proceeds (no second hold); a row WITHOUT a supplier order whose address differs proceeds and creates the supplier order with the new address (today's behaviour, pinned). `recheckAwaitingPayment`: a cancelled row becomes `cancelled` and the "do NOT pay the supplier" alert is delivered once across two runs; a cancel already handled by the webhook path sends nothing; a changed address holds and alerts once across two runs; a live unchanged row is untouched and nothing is sent; an unreadable gate writes nothing; a gate `hold` (`refunded`) does nothing; the `max` bound is honoured; and `runOrderPipelineForShop`-level wiring is pinned the way the file already pins its other steps (or, if that function is not drivable in tests, say so in the report and pin the call order by reading).
- [ ] **Step 2: Run them and see each fail for the right reason.**
- [ ] **Step 3: Implement**, after `python -P -m graphite impact src/order-cancel.ts` and `python -P -m graphite impact src/fulfil-run.ts`.
- [ ] **Step 4: Green**: both test files, `tests/order-alert.test.ts`, `tests/order-webhook-routes.test.ts`, `tests/order-gate.test.ts`, `tests/guard.test.ts`, then `npm run typecheck` and `npm run lint`.

---

### Task 7: Console

**Files:**
- Modify: `src/console/page.ts`
- Test: `tests/console.test.ts`

**Interfaces:**
- Consumes: the three API shapes produced by Task 6.
- Produces: nothing for other tasks.

Changes inside the orders card:

1. Under the mode line, a status line with id `hookline`: `Order events: all 3 subscribed (checked <local time>)` in the ok style; `Order events: MISSING <topics>. A cancel or refund can go unnoticed.` in the warning style; `Order events: not checked yet` when `hooks` is null.
2. A button with id `hookbtn`, label `Check order events`, calling `/ensure-webhooks`, then re-rendering the line. Disabled while running, like the other buttons in this card.
3. Each order row's name becomes a button (`class="ghost"`, `data-ev="<id>"`). Pressing it calls `/order-events` and toggles a row beneath holding the timeline: one line per event, `<local time> · <kind> · <detail>`, every value through `esc(...)`.

- [ ] **Step 1: Add failing assertions** to `tests/console.test.ts` in its existing style: the page source contains `hookline`, `hookbtn`, `/ensure-webhooks`, `/order-events`, and the three status texts.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Browser JS in this file uses `var` and `function`, no arrow functions, no template literals; follow `loadOrders`.
- [ ] **Step 4: Green**: `npx vitest run tests/console.test.ts`, then `npm run lint` (its `no-useless-escape` rule is what catches a single backslash inside the template literal).

---

### Task 8: Decision record, runbook, state map

**Files:**
- Create: `docs/decisions/0002-money-loop.md`, `docs/RUNBOOK-ORDERS.md`
- Modify: `docs/STATES.md`, and `src/system-states.ts` only if `tests/system-states.test.ts` requires a registry entry for what is added (this task owns that file; no other task touches it)

- [ ] **Step 1: `docs/decisions/0002-money-loop.md`.** Same shape as `docs/decisions/0001-deploy-safety.md`. Record, each with its reason and its cost if wrong: both a pull gate and webhooks; the gate fails closed while the risk policy keeps failing open; the worker registers its own webhooks; the three privacy topics left the API list because they are not API topics (so the install had been failing on them quietly); a refund without a cancel holds; mixed origin holds; option A (the owner pays the supplier by hand) first, automatic payment later; three real orders, not one. End with a section "Evidence from the supervised runs" whose body is the single sentence: `Written when the runs happen; this record is not complete without it.`
- [ ] **Step 2: `docs/RUNBOOK-ORDERS.md`.** For the owner, plain language: what each order status means; what each hold reason means and what to do; what each alert means and what to do (use the exact subjects from Tasks 4, 5 and 6); the off switch (`fulfil.mode` back to `manual` stops all submission at once); how to read an order's timeline; the part 2 procedure (the four preconditions and the three runs from section 6 of the spec, with what would count as a failure for each).
- [ ] **Step 3: `docs/STATES.md`.** Add the order statuses, the hold reasons (including `shopify-cancelled`, `refunded`, `already-fulfilled`, `order-missing`, `mixed-origin`) and the `job:order-webhooks` stamp, each with its probe. `tests/system-states.test.ts` pins this file against the console register: read it first, follow the format it enforces, and keep it green (`npx vitest run tests/system-states.test.ts`).
- [ ] **Step 4:** No em or en dash in any of the three files. No claim of UK fulfilment.

---

### Task 9: Acceptance of part 1 (orchestrator)

- [ ] Whole repo with every agent idle: `npm test` (full suite), `npm run test:scripts`, `npm run typecheck`, `npm run lint`, each with its own exit code read.
- [ ] Spec exit criterion 1, shown to be able to fail: temporarily make `decideGate` return `proceed` for a cancelled snapshot, see Task 5 test 1 go red, restore, see it green.
- [ ] `npm run deploy -- --env staging` from the branch: migration 0041 applies to staging D1, `/healthz` reports the branch label, smoke passes.
- [ ] `node scripts/deploy.mjs --env production --dry-run` from the branch refuses (not master / not merged), and says why.
- [ ] Final whole-branch review on the most capable model, one fix wave, one scoped re-review, residuals adjudicated.
- [ ] Merge to master only with the owner's go for production in hand or pending; the production deploy itself runs the rehearsal because migration 0041 is pending, so it must start off the cron marks (not at minutes 0, 15, 30, 45, not at 04:17 UTC).

## Self-review against the spec

| Spec section | Task |
|---|---|
| 5.1 gate, fails closed, before create and before pay, release never skips liveness | 2, 5 |
| 5.2 cancel and refund events, by status, idempotent, `alertOwner` | 4, 6 |
| 5.3 ensure, `uri`, read-back, daily, console button, auth callback, alert when missing | 3, 6, 7 |
| 5.4 `fulfillmentCreate`, trail on failure, alert after 4 | 5 |
| 5.5 `order_events`, isolation, no customer data, erasure, console timeline, migration through the phase 1 path | 1, 6, 7, 9 |
| 5.6 mixed origin | 5 |
| 7 testing rules | every task |
| 10 exit criteria 1 to 3 | 9 (4 to 7 belong to part 2) |
