# Phase 2: Prove the Money Loop (design)

Status: DRAFT for owner review. No code is written until the owner approves this document.

Parent: `docs/superpowers/specs/2026-09-18-production-grade-programme-prd.md`, property P-B ("a real paid order reaches the supplier, ships, and the customer gets tracking, with the unhappy paths handled").

## 1. Owner direction

1. 2026-09-19, after the phase 1 deploys: "go" (start phase 2).
2. 2026-09-19, asked how the first real order should be paid at the supplier, with three options on the table: "fix the holes then do A".

Option A was: the worker creates the supplier order and stops; the owner pays it by hand in the supplier's site; nothing moves money automatically; automatic payment becomes a later, separate proof.

So this phase has two parts, in this order:

- **Part 1, close the holes.** Code only. No real order is needed to build or test it.
- **Part 2, the supervised proof.** Real orders on the live shop, paid at the supplier by the owner, each with an evidence trail.

## 2. What exists today (measured first-hand 2026-09-19)

The whole loop is 639 lines: `src/fulfil.ts`, `src/fulfil-run.ts`, `src/shopify-orders.ts`.

- **Receive.** The `orders/paid` webhook (`src/index.ts`, `/webhooks/orders-paid`) validates the HMAC, parses the order, and holds it for a human when an item is not mapped to a supplier product, the address is incomplete, risk is high, the total is over GBP 100, or it is not paid. Otherwise it is queued with a 60 minute grace period (`fulfil_after`).
- **Submit.** Every 15 minutes `processDueOrders` takes queued orders past their grace, reads Shopify's fraud recommendation, resolves each line to a supplier variant, checks source stock, creates the supplier order, then either stops (`createOnly`, the owner pays by hand and is emailed) or pays from the supplier wallet.
- **Track.** `pollTracking` asks the supplier for a tracking number on every `submitted` and `awaiting-payment` order, writes it to Shopify, and Shopify notifies the customer.
- **Operate.** The console lists orders and can release, hold or cancel a row. That cancel changes only our own row.

Live state:

- `tenant_config.fulfil` is `mode: manual`, `createOnly: true`, alert email set. In `manual` the submit step is skipped entirely, so a real order today is queued and nothing reaches the supplier.
- The `orders` table holds one row: test order #1001, GBP 15.99, cancelled, with the note "test 2026-06-15: createOrderV2 OK except wallet unfunded". The supplier wallet has never been funded.

## 3. The holes

| # | Hole | Evidence | Cost if left |
|---|---|---|---|
| H1 | An order cancelled or refunded during the grace period is still bought | Before spending, `processDueOrders` reads only `Order.risk`. Nothing reads `cancelledAt` or the financial status. The only subscribed order topic is `ORDERS_PAID` (`src/webhooks.ts`) | Real money spent and a parcel sent to a customer who cancelled |
| H2 | A cancel after the supplier order exists reaches nobody | No `orders/cancelled` or `refunds/create` handler. Under option A the owner could pay the supplier for an order the customer already cancelled | Same, and it is the exact path option A uses |
| H3 | A new webhook topic can never reach the already installed shop | `registerWebhooks` runs only inside `/auth/callback`. `shopify.app.toml` declares no subscriptions. Nothing reads back what is registered | The fix for H2 would ship and silently never fire |
| H4 | The tracking write-back has never run and uses a deprecated mutation | `fulfillmentCreateV2`; Shopify's schema validator says "use `fulfillmentCreate`". `src/shopify-admin.ts` records that API 2026-04 has runtime rules that schema validation cannot see (the `@idempotent` break). A failure today is a `console.warn` and nothing else | The customer never gets tracking and nobody is told |
| H5 | An order leaves no trail | The row holds only its current status. There is no record of what happened, when, or why | The phase's exit criterion ("each with an evidence trail") cannot be met, and a failed order cannot be reconstructed |
| H6 | A multi-item order silently takes one origin | `origin = resolved.origin; // last wins`, and freight is estimated from the first line only | A wrong-warehouse order with no warning |

Not holes for this phase (section 9): the supplier client cannot read the wallet balance or cancel a supplier order; the app holds `read_orders` only, so cancelling or refunding in Shopify stays with the owner in the admin.

## 4. Approaches considered for H1 and H2

| Approach | Catches a cancel during grace | Catches a cancel after the supplier order exists | Survives a missed webhook |
|---|---|---|---|
| A pull check just before money moves | Yes | No | Yes |
| Cancel and refund webhooks only | Yes | Yes | No |
| **Both (chosen)** | Yes | Yes | Yes, for the part where money moves |

The pull check is the guard on the money: it asks Shopify the authoritative question at the last moment and does not depend on an event having arrived. The webhooks are the state and alert path: they are the only way to learn of a cancel after the supplier order exists. Neither replaces the other.

## 5. Design, part 1

### 5.1 Live-order gate (H1)

One Admin GraphQL read, immediately before any money-moving step, replacing today's separate risk read. Validated against the 2026-04 schema:

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

A pure function decides, so the whole table is unit tested without a network:

| Shopify says | Decision |
|---|---|
| `cancelledAt` is set | Row becomes `cancelled`. Never sent to the supplier |
| Financial status is `REFUNDED`, `PARTIALLY_REFUNDED` or `VOIDED` | Row becomes `held`, reason `refunded`. An operator decides |
| Fulfillment status is `FULFILLED` or `PARTIALLY_FULFILLED` | Row becomes `held`, reason `already-fulfilled` (someone shipped it another way) |
| The order does not exist | Row becomes `held`, reason `order-missing` |
| Shipping address differs from the stored one | The fresh address is used and stored. If it is now incomplete, the row is `held`, reason `incomplete-address` |
| Risk recommendation | Exactly today's `riskHold` policy, unchanged |
| None of the above | Proceed |

Rules:

- **The gate fails closed.** If the read fails, this order is not processed this tick and is tried again on the next one. Today's risk read fails open on purpose, and that reasoning still holds for risk alone; it does not hold for "was this order cancelled", where a wrong guess costs money and a delay costs 15 minutes. After 4 consecutive failed reads (one hour) the owner is alerted once.
- **The gate runs before `createOrder` and again before `payBalance`.** The second run matters for a pay retry, where the supplier order already exists.
- **An operator release skips the risk decision, as today, but never the liveness decisions.** An operator cannot release a cancelled order into the supplier.

### 5.2 Cancel and refund events (H2)

Two new HMAC-validated webhook routes, same shape as `/webhooks/orders-paid` (always 200, errors logged): `/webhooks/orders-cancelled` and `/webhooks/refunds-create`. Both need only `read_orders`, which the app has.

What a cancel does, by the row's status when it arrives:

| Row status | Result | Owner alert |
|---|---|---|
| No row | Nothing (not one of ours) | None |
| `held` or `queued` | `cancelled` | None. Nothing was bought |
| `awaiting-payment` | `cancelled` | "Order X was cancelled. DO NOT pay supplier order Y. Cancel it at the supplier." |
| `submitted` | `cancelled` | "Order X was cancelled AFTER it was paid at the supplier (order Y). Ask the supplier to cancel it if it has not shipped." |
| `fulfilled` | unchanged | "Order X was cancelled after it shipped. This is now a return." |
| `error`, `cancelled` | `cancelled` | None |

A refund without a cancel: if no supplier order exists yet, the row is `held` with reason `refunded`; if one exists, the row is unchanged and the owner is alerted with the refund amount and the supplier order id.

Both handlers are idempotent: a repeated delivery finds the row already in its final state, writes no second event and sends no second alert. Alerts go through the existing `alertOwner` (`src/owner-alert.ts`).

### 5.3 Webhook assurance (H3)

- `ensureWebhooks(shop, accessToken, appUrl)`: for each required topic, create the subscription if it is missing. It uses `uri` (Shopify has deprecated `callbackUrl`). "Already taken" counts as success, as today.
- A read-back, `webhookSubscriptions(first: 50)`, returns the topics actually registered. The result is stored and shown on the console's order card as "Order events: 3 of 3 subscribed", with the missing topics named when there are any.
- It runs in the daily maintenance chain for every active shop, and from a console button "Check order events", so a new topic reaches an installed shop without a reinstall and a dropped subscription heals within a day.
- `/auth/callback` calls the same function, so there is one list of topics in the codebase.
- If the read-back shows a required topic missing after an ensure, the owner is alerted.

### 5.4 Tracking write-back (H4)

- Move to `fulfillmentCreate` with `FulfillmentInput`. The input shape the code builds is unchanged. Validated against the 2026-04 schema.
- A failure is recorded in the order's trail. After 4 consecutive failures for one order the owner is alerted once, with the tracking number, so the customer can be told by hand while the cause is found.
- Schema validation cannot prove this mutation at runtime. The supervised proof in part 2 is its real test, and it is safe to find out there: a failed write-back leaves the order shipped and the write is retried every 15 minutes.

### 5.5 Order event trail (H5)

New table, migration `0041_order_events.sql`, append only:

```sql
CREATE TABLE order_events (
  shop              TEXT NOT NULL,
  shopify_order_id  TEXT NOT NULL,
  seq               INTEGER NOT NULL,   -- 1, 2, 3 ... per order
  at                TEXT NOT NULL,      -- ISO time
  kind              TEXT NOT NULL,
  detail            TEXT,               -- short plain text, no customer data
  PRIMARY KEY (shop, shopify_order_id, seq)
);
```

- Kinds: `received`, `held`, `queued`, `released`, `gate-passed`, `gate-held`, `gate-unreadable`, `address-refreshed`, `stock-ok`, `stockout`, `supplier-order-created`, `awaiting-payment`, `paid`, `tracking-found`, `tracking-written`, `tracking-write-failed`, `cancel-received`, `refund-received`, `owner-alerted`, `operator-action`, `error`.
- Every status change and every money-adjacent step writes exactly one event. Writing an event never fails the step that raised it.
- All access goes through `src/tenant-store.ts`, so the tenant-isolation tripwire (`tests/guard.test.ts`) keeps holding. `shop` leads the primary key.
- `detail` never holds a name, an address, an email or a phone number. The privacy webhooks already erase `orders` rows; they are extended to erase `order_events` rows for the same orders.
- The console's order row gains an expandable timeline that reads this table.
- This is the first migration to travel the phase 1 path for real: staging first, the rehearsal against a copy of production, then the guarded production deploy.

### 5.6 Mixed-origin hold (H6)

If the lines of one order resolve to more than one origin, the row is `held` with reason `mixed-origin` and nothing is sent to the supplier. Splitting an order across warehouses is phase 5 work; until then a human decides.

## 6. Design, part 2: the supervised proof

Preconditions, each checked and recorded before the first order:

1. Part 1 is on production through the guarded deploy (the owner's go), with migration 0041 applied staging first.
2. The console shows all three order events subscribed.
3. The owner switches `fulfil.mode` to `pawscout` in the console and leaves `createOnly` on.
4. A product is chosen for the runs: single variant, low price, in stock at the supplier, mapped.

Three runs. The owner places each order on the live shop with a real card.

| Run | What the owner does | What must happen | What would be a failure |
|---|---|---|---|
| 1. Happy path | Buys the item. When the email arrives, pays the supplier order by hand | Trail: received, queued, gate-passed, stock-ok, supplier-order-created, awaiting-payment, then tracking-found and tracking-written once the supplier ships. The Shopify order shows fulfilled with a working tracking link. The owner, as the customer, receives Shopify's shipping email | Any step missing from the trail; no email; the write-back failing; the tracking link not opening |
| 2. Cancel during grace | Buys the item, then cancels and refunds it in the Shopify admin inside 60 minutes | The row becomes `cancelled`. After the grace time passes, no supplier order exists for it | A supplier order exists for this order |
| 3. Cancel after the supplier order exists | Buys the item, waits for the "awaiting payment" email, then cancels and refunds in the admin | The "DO NOT pay" alert arrives. The row is `cancelled`. The owner cancels the unpaid supplier order at the supplier | No alert; or the row still `awaiting-payment` |

What it costs: one real product bought and shipped (run 1), and the card processing fees on two refunded orders. If anything in a run is wrong, the owner switches `fulfil.mode` back to `manual` in the console, which stops all submission at once, and the cause is found before the next run.

Every run's evidence (the trail rows, the Shopify order timeline, the supplier order id, the emails received) is written into the phase's decision record.

## 7. Testing

- Test first, with the failing test observed, as in phase 1.
- The gate decision table, the cancel-by-status table and the mixed-origin rule are pure functions with one test per row.
- The two new webhook routes get the same tests `/webhooks/orders-paid` has: a bad HMAC is refused, a repeated delivery changes nothing, a handler error still answers 200.
- `ensureWebhooks` is tested against a fake Admin API: missing topics are created, present ones are not, the read-back names what is missing.
- The event trail: every transition writes exactly one event; a failing event write does not fail the step.
- What staging can and cannot prove: staging has no shop, so no Shopify event can reach it. Staging proves that migration 0041 applies on real D1 and that the worker starts. The proof of the loop itself is part 2, on the live shop, on purpose.

## 8. Risks

| Risk | Handling |
|---|---|
| The gate fails closed and Shopify's API is down for hours | Orders wait, nothing is bought wrongly, and the owner is alerted after one hour |
| A cancel webhook never arrives | The gate still stops the order before money moves. After the supplier order exists, only the webhook can tell us. Shopify retries a failed delivery up to 8 times over 4 hours and REMOVES a subscription that keeps failing (shopify.dev, "Troubleshoot webhooks", read 2026-09-19), so a broken handler would silently end the subscription. The daily ensure and read-back in 5.3 exist for exactly that, and Shopify's own guidance recommends the same check |
| `fulfillmentCreate` fails at runtime for a reason the schema cannot show | Found in run 1, where it is harmless: the order has shipped, the write retries, the owner is alerted with the tracking number |
| The owner pays a supplier order for a cancelled order anyway | The alert names the supplier order id and says not to pay. The supplier client still cannot cancel a supplier order by itself (section 9) |
| Turning `mode` to `pawscout` exposes paths that have never run live | `createOnly` stays on, so the worst case is an unpaid supplier order. `mode: manual` is the off switch |

## 9. Non-goals for this phase

- Automatic payment from the supplier wallet, and reading the wallet balance. That is option B, a later and separate proof.
- Cancelling a supplier order through the supplier's API.
- Cancelling or refunding a Shopify order from the worker (needs `write_orders`). Phase 5.
- Checkout shipping rates that match the quote (CarrierService), returns, customer order status. Phase 5.
- Splitting one order across warehouses. Phase 5. This phase only refuses to guess.
- A Shopify development store and a staging copy of the app (open decision O2). Not needed for option A; it becomes necessary in phase 4.
- The per-stage run ledger and quiet-cron alarm for all jobs. Phase 3. Only the order trail is pulled forward.

## 10. Exit criteria (each is a check that can fail)

1. With the gate's read stubbed to "cancelled", "refunded", "fulfilled", "missing" and "unreadable", no test reaches `createOrder` or `payBalance`.
2. On production, the console reports all three order events subscribed, from a read-back and not from the act of subscribing.
3. Migration 0041 reaches production staging first, through the rehearsal, with the refusals from phase 1 still in force.
4. Run 1 ends with the Shopify order fulfilled, a working tracking link, the customer shipping email received, and a complete trail.
5. Run 2 ends with no supplier order for the cancelled order.
6. Run 3 ends with the "DO NOT pay" alert received and the row `cancelled`.
7. A decision record `docs/decisions/0002-money-loop.md` holds the evidence of each run and every ruling made along the way.

## 11. Rulings made in this document, for the owner to overturn

| Ruling | Why | Cost if wrong |
|---|---|---|
| The liveness gate fails closed, while the risk policy keeps failing open | A wrong guess on liveness spends money; a delay costs 15 minutes | Orders wait while Shopify's API is unreachable |
| Cancel and refund webhooks are registered by the worker itself, not declared in `shopify.app.toml` | It needs no CLI deploy or new app version, it heals a dropped subscription, and it works the same for every future shop | Two places could one day declare topics; this document makes the worker the only one |
| A refund without a cancel holds the order instead of cancelling it | A partial refund can be a goodwill gesture on an order that should still ship | One extra operator click on a fully refunded order |
| A mixed-origin order is held | Guessing the warehouse is worse than asking | Multi-item orders need a human until phase 5 |
| Three real orders, not one | The exit criterion names a rehearsed cancel and refund; a happy path alone proves half the property | Card fees on two refunded orders |

## 12. Open owner decisions

| # | Decision | Needed by |
|---|---|---|
| Q1 | Approve this design, or change it | Before any code |
| Q2 | Which product the three runs use (or let the worker side propose one: cheapest mapped single-variant item in stock) | Before part 2 |
| Q3 | The delivery address for run 1 | Before part 2 |
