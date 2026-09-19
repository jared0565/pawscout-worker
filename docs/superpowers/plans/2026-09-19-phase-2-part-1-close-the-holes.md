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

export type GateHoldReason = 'refunded' | 'already-fulfilled' | 'order-missing' | 'incomplete-address' | 'high-risk' | 'medium-risk-value';
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
3. `financialStatus` is `REFUNDED`, `PARTIALLY_REFUNDED` or `VOIDED`: hold `refunded`.
4. `fulfillmentStatus` is `FULFILLED` or `PARTIALLY_FULFILLED`: hold `already-fulfilled`.
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
/** Order id and refunded amount from a refunds/create payload. */
export function refundInfo(raw: unknown): { orderId: string; amount: number; currency: string };

export function applyCancel(store: TenantStore, shopifyOrderId: string): Promise<CancelOutcome>;
export function applyRefund(store: TenantStore, info: { orderId: string; amount: number; currency: string }): Promise<CancelOutcome>;
```

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
