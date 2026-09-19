# 0002: The money loop, part 1 (close the holes)

## Status

Accepted, 2026-09-19.

## Context

Measured first-hand on 2026-09-19 (design doc, section 2 and 3): the order to
supplier loop was 639 lines across `src/fulfil.ts`, `src/fulfil-run.ts` and
`src/shopify-orders.ts`, and it had six gaps.

- An order cancelled or refunded during its 60 minute grace window was still
  bought, because the only check before spending read Shopify's fraud
  recommendation and nothing else.
- A cancellation that arrived after the supplier order already existed
  reached nobody, which matters most under the owner's chosen path for the
  first real order: option A, where the owner pays the supplier by hand, so
  a missed cancellation is a real invoice that could still get paid.
- A new webhook topic could never reach the shop that had already installed
  the app, because registration only ran inside the OAuth callback.
- The tracking write-back used a mutation Shopify's schema validator already
  flags as deprecated, and had never run for a real order.
- An order left no record beyond its current status, so a failed or disputed
  order could not be reconstructed.
- An order with lines resolving to more than one supplier warehouse silently
  shipped from whichever line resolved last.

Further gaps came to light during the build itself, closed by the decisions
below: an owner alert could be marked as delivered before it was actually
confirmed sent; a failed order webhook had no bounded retry contract with
Shopify; a cancellation could lose a race against the pipeline that read the
row moments earlier; an order paid by the owner's own hand had no periodic
check once its supplier order existed; and a delivery address that changed
after a supplier order was created could reach a payment silently.

This phase (part 1) closes all of the above. It ships no automatic supplier
payment and no way to cancel a supplier order through the supplier's API;
those stay out of scope (design doc, section 9).

## Decision

Build the following, together closing every gap named above:

- **D1, both a pull gate and webhooks, not one or the other.** A pull check
  (`src/order-gate.ts`) reads Shopify's live state immediately before any
  money moves. Two webhook routes, `/webhooks/orders-cancelled` and
  `/webhooks/refunds-create`, carry the cancel and refund events. Reason: the
  pull check is the only thing that can catch a cancellation that happened
  while no webhook was in flight, and it does not depend on a delivery
  arriving; the webhooks are the only way to learn that an order changed
  after its supplier order already exists, which the pull check by design
  cannot see once money has moved. Neither covers what the other covers.
  Cost if wrong: with the pull check alone, a cancellation or refund that
  lands after the supplier order was created (and, under option A, possibly
  already paid by the owner) would reach nobody, which is exactly the gap
  the webhooks exist to close. With webhooks alone, the order is exposed for
  as long as a delivery is delayed or lost, and Shopify's own delivery is
  not guaranteed on any single attempt.

- **D2, the gate fails closed; the risk policy keeps failing open.** When the
  gate's read of Shopify fails, the order is left exactly where it was and
  tried again on the next 15 minute run; after four failed reads in a row
  (about an hour) the owner is alerted once. The existing fraud-risk policy
  (`riskHold` in `src/fulfil.ts`) is unchanged: an unreadable risk score still
  lets the order through. Reason: a wrong guess on "was this order cancelled"
  spends real money on a customer who no longer wants the order; a wrong
  guess on "is Shopify's fraud score readable" only costs a further 15 minute
  wait. Cost if wrong: if liveness also failed open, an outage in Shopify's
  API would let a cancelled or refunded order be bought during the outage,
  the exact loss this phase exists to prevent. If risk failed closed instead,
  every order would hold whenever the risk read hiccups, which (per the
  existing comment in `src/fulfil.ts`) trains an operator to rubber-stamp
  holds rather than read them.

- **D3, the worker registers its own webhook subscriptions**, rather than
  declaring them in `shopify.app.toml`. `ensureWebhooks` creates whatever is
  missing and, whenever it created anything, reads the subscriptions back
  (when nothing needed creating, the first read already is the final state),
  both from a console button
  and once a day for every active shop. Reason: it needs no CLI deploy and no
  new app version to reach an already-installed shop, and a subscription that
  Shopify silently drops (Shopify's own guidance says a repeatedly-failing
  subscription gets removed) heals again within a day instead of staying
  broken until the owner notices. Cost if wrong: nothing today stops a future
  change from also declaring a topic in `shopify.app.toml`, which would leave
  two places claiming to own the same subscription list; this decision is
  what makes the worker the one to check first if that ever happens.

- **D4, the three privacy topics left the API topic list.**
  `CUSTOMERS_REDACT`, `CUSTOMERS_DATA_REQUEST` and `SHOP_REDACT` are not
  values of Shopify's `WebhookSubscriptionTopic` (checked against the
  2026-04 schema, 2026-09-19); they are configured in the app configuration,
  not through the Admin API. The existing `registerWebhooks` had been asking
  for all three on every install and failing on them quietly, which this
  phase discovered while building the read-back that `ensureWebhooks` needed
  anyway. Reason: an API call that can never succeed does not belong in a
  list a read-back is meant to make trustworthy. Cost if wrong: had these
  stayed in the list, `ensureWebhooks` would report them missing forever,
  the console's subscription line would never show fully subscribed even
  when every real order topic is fine, and daily alerts about missing
  subscriptions would fire on installs where nothing is actually wrong with
  order events. Leaving the API list does not mean privacy compliance is
  handled: whether those three are correctly configured in the app
  configuration is outside what this worker can check, and is not verified
  by this phase.

- **D5, a refund without a cancellation holds the order rather than
  cancelling it.** When no supplier order exists yet, a refund holds with
  reason `refunded`, for the owner to decide. When a supplier order already
  exists, the order's status is left unchanged and the owner is alerted with
  the refund amount and the supplier order id instead. Reason: a partial
  refund can be a goodwill gesture on an order the shop still intends to
  ship, so treating every refund as a cancellation would stop orders that
  were never meant to stop. Cost if wrong: one extra operator decision on an
  order that was, in fact, fully refunded and should have auto-cancelled;
  weighed against the alternative of auto-cancelling (and, worse, alerting
  as if cancelled) an order a goodwill refund should not have stopped.

- **D6, a mixed-origin order holds.** If an order's lines resolve to more
  than one supplier warehouse, nothing is sent to the supplier and the row
  holds with reason `mixed-origin`. Reason: splitting one order across
  warehouses is phase 5 work; guessing which single origin to use, as the
  code did before this phase (`origin = resolved.origin`, last line wins),
  is worse than asking the owner. Cost if wrong: every mixed-origin order
  needs the owner until phase 5 ships, instead of shipping automatically
  from a guessed warehouse with no warning to anyone.

- **D7, option A first: the owner pays the supplier by hand.** This phase
  builds create-only submission (the supplier order is created and the flow
  stops there) and does not build automatic payment from the supplier
  wallet or a way to read its balance. Reason: the owner's direction on
  2026-09-19 was "fix the holes then do A"; automatic payment is a larger
  and separate risk (spending money with nobody in the loop to catch a
  mistake), and the supplier wallet has never been funded or proven under
  real load. Cost if wrong: fulfilment stays slower than it would be with
  automatic payment, because the owner must log in to the supplier's site
  and pay each order by hand, until automatic payment is designed, built and
  proven as its own separate piece of work.

- **D8, three real orders, not one, prove part 2.** The supervised proof
  (design doc, section 6) runs a happy-path order, an order cancelled during
  the grace window, and an order cancelled after its supplier order exists.
  Reason: the phase's exit criteria name a rehearsed cancellation and a
  rehearsed refund by number; a happy path alone would prove only that money
  can move, not that the guardrails around it work. Cost if wrong: card
  processing fees on the two orders that are deliberately cancelled and
  refunded (runs 2 and 3), against the alternative of shipping this phase
  having only ever exercised its happy path for real.

- **D9, the marker that stops retrying is written only after the thing it
  records has happened.** Every order alert goes through one function
  (`deliverOrderAlert`, `src/order-alert.ts`) that sends first and only then
  writes what happened: `owner-alerted` when the email provider actually
  accepted it, `owner-alert-failed` when it did not, `owner-alert-unconfigured`
  when there is nobody to tell. A failed alert is retried by the 15 minute
  order tick until one is accepted, at most 12 attempts since the alert was
  first raised and for at most 24 hours, at most 10 re-sends in one tick, and
  this runs whatever `fulfil.mode` is set to. Reason: this is the same
  principle as D3's webhook read-back; marking an alert "told" before delivery
  is confirmed can silently lose the one message that stops a payment. Cost if
  wrong: a slightly later trail write while the send itself is awaited, in
  exchange for a trail that only ever claims delivery it can back up.

- **D10, the intent to alert is recorded before the attempt.** Every order
  alert first writes an `owner-alert-due` trail row before the send is even
  attempted; at a webhook door this write is awaited before the route
  answers, and a refused write answers 500 so Shopify redelivers. Reason: the
  send itself can run in a background task that the platform can end shortly
  after the response goes back, and without a durable record of the intent, a
  killed background task leaves nothing behind for the retry sweep to find.
  Cost if wrong: one more trail row per alert attempt, and the sweep
  deliberately leaves a due row alone for its first minute (that send may
  still be genuinely in flight), so a very fast repeat delivery inside that
  minute changes nothing rather than racing it.

- **D11, "nobody to tell" is its own trail kind, never an error line matched
  by its text.** `owner-alert-unconfigured` records that there was no alert
  address or no email key configured, as its own named kind rather than a
  distinctly worded `error` row. Reason: matching on an error line's exact
  wording is fragile - a message can be re-cut at a different length or
  reworded later - and this was found more than once during review. Cost if
  wrong: one more named kind for the owner to see in a trail line, in exchange
  for the trail's own logic never depending on matching text.

- **D12, a cancel always wins, and is recorded before the row's status
  moves.** `applyCancel` (`src/order-cancel.ts`) writes its `cancel-received`
  marker, carrying the row's status at that moment, before it changes the row
  to `cancelled`; if that write is itself refused, the function throws so the
  webhook route answers 500 and Shopify redelivers into what looks, from
  here, like a clean first delivery. A repeat delivery re-applies the status
  change if it never landed, and reconstructs whichever alert was due. Reason:
  a cancellation must win against the order pipeline even when the pipeline
  read the row only seconds earlier, and the only way to guarantee that
  without a lock is to make the whole sequence replayable from any point it
  could be interrupted. Cost if wrong: a marker write the database keeps
  refusing becomes repeated 500 answers, which spend the bounded retries of
  D16 and end in its give-up alert rather than in a quiet loss; and because
  nothing claims the row first, two deliveries of one cancellation arriving
  at the same moment can both alert (see the residuals below).

- **D13, money that moves by hand gets its own periodic check, and that check
  never holds a row for an address change alone.**
  `recheckUnsettledSupplierOrders` (`src/fulfil-run.ts`) re-reads, every 15
  minutes, every order that carries a supplier order and is not yet settled
  (`awaiting-payment`, `held` or `error`), oldest first, rotating through the
  backlog a page at a time. When Shopify shows the order cancelled, refunded,
  not paid, on hold, or without a usable address, it stops the row and tells
  the owner, the same way the pipeline's own pre-spend check does; when only
  the delivery address changed, it saves the new address and alerts, but
  deliberately leaves the row's status untouched. Two findings are passed
  over entirely: `already-fulfilled` and `order-missing` are neither held
  nor alerted here, because neither says that the money came back (the cost
  is in the residuals below). Reason: the pre-spend check
  only exists at the moment the worker itself is about to pay; when the owner
  pays by hand instead there is no such moment, so a cancellation or a stale
  address can only be caught by asking again later, and holding the row for
  an address change alone would pull it out of this very check and out of the
  tracking poll while the owner still has to pay it. Cost if wrong: one more
  Shopify read per unsettled order every 15 minutes, and an order this check
  cancels can only be revived by hand.

- **D14, one walk of the trail is the sole authority on what is pending; the
  database query only chooses candidates.** The store's own query
  (`listOrderIdsWithPendingAlerts`) narrows down which orders the 15 minute
  sweep looks at; for each one, the sweep still reads that order's whole
  trail itself (`pendingAlerts`) before deciding what to resend. Reason:
  keeping the "what still needs telling" rule in exactly one place means the
  database query can stay simple, or change later, without ever being allowed
  to disagree with what actually gets resent. Cost if wrong: the database
  query has to stay conservative - it would rather look at an order that
  turns out not to need resending than skip one that does - which costs a
  small number of wasted reads, never a missed alert.

- **D15, a trail detail is always classified, never copied.** A failed step
  is recorded as a fixed phrase (for example, that writing tracking back to
  Shopify failed), never as the supplier's or Shopify's own error text. A
  failed read of Shopify keeps only our own "Shopify HTTP" plus status number
  wording, which carries nothing of Shopify's; any other failure of that read
  is the fixed phrase `read failed`.
  Reason: a supplier's rejection message, or a Shopify write-back error, can
  echo the address or phone number sent with the order, and trail rows are
  what gets pasted into this decision record as evidence. Cost if wrong: the
  trail says where an order failed but not the full reason; the complete
  message still reaches the worker's own logs, the failed order's own
  `hold_reasons` value (which is stored, is shown in the console, and is NOT
  covered by this rule today), and, where relevant, the text of an alert sent
  to the owner - never the stored trail.

- **D16, a failed order webhook asks Shopify to try again, a bounded number
  of times.** When the processing of a paid, cancelled or refunded event
  throws, the route answers 500, which is safe because every handler can be
  replayed. Failures are counted per delivery (Shopify keeps the same
  `X-Shopify-Webhook-Id` across its own retries of one event,
  `src/webhook-retry.ts`): the first three answer 500, the fourth answers 200
  and sends the owner "An order event from Shopify could not be processed",
  and any after that answer 200 quietly. A payload that can never succeed
  still answers 200 at once. Reason: before this, a route answered 200 even
  when its own processing had thrown, and Shopify only redelivers what did
  not get a 2xx, so one database blip could lose a cancellation for good;
  but Shopify removes a subscription after 8 failed deliveries in 4 hours, so
  asking for retries without a limit would trade one lost event for losing
  all of them. An owner alert that fails to send is deliberately NOT a reason
  to answer 500: Shopify cannot heal our email, and those failures would
  spend the same 8. Cost if wrong: an event that fails four times is dropped
  with one email as its only trace (that email is not recorded in an order's
  trail and is not retried), and the counter lives in the same database as
  everything else (see the residuals below for what that means in an
  outage).

## Alternatives considered and why not

| Approach | Catches a cancel during the grace window | Catches a cancel after the supplier order exists | Survives a missed webhook delivery |
|---|---|---|---|
| A pull check only, just before money moves | Yes | No | Yes |
| Cancel and refund webhooks only | Yes | Yes | No |
| Both (chosen, D1) | Yes | Yes | Yes, for the part where money moves |

A pull-only design was rejected because it cannot see anything once the
supplier order already exists; a webhook-only design was rejected because a
single missed delivery, however rare, is exactly the failure mode a
guardrail on real money cannot accept.

## Consequences

Every order PawScout pays itself clears a live check against Shopify's own
record of it twice: once before the supplier order is created, and again
before it is paid. Under option A, where the owner pays by hand, only the
first of those exists, and the 15 minute re-check of D13 is what watches the
order between creation and payment. A Shopify outage now delays orders rather than risking a wrong spend,
at the cost of the owner being alerted after an hour of that delay. A
webhook subscription that quietly stops working is caught within a day by
the same mechanism that keeps it registered in the first place, instead of
being caught only when a cancellation is missed for real. The owner's one
already-existing off switch, `fulfil.mode` back to `manual`, still stops
every automatic submission and payment at once; nothing in this phase adds a
second way to do that. Real supplier payment stays a manual, one-order-at-a-
time act by the owner until a later phase proves it safe to automate.

## Accepted residuals

Known, deliberately unclosed gaps, each judged safer to leave than to fix in
this phase.

- PawScout never learns that the owner paid a supplier order by hand. Such
  an order stays `awaiting-payment`, and the console banner keeps listing it,
  until the supplier ships and a tracking number arrives; `submitted` is only
  ever written when PawScout itself paid. Every text that reads this status
  therefore says "PawScout has not paid it", never "it is unpaid", and says
  what to do in both cases. The risk left over is the owner paying one
  supplier order twice, so the runbook says to check a supplier order's own
  state at the supplier before paying it. A console action by which the owner
  tells PawScout "I paid this" was considered and left for a later decision:
  it changes what `submitted` means and takes the order out of the periodic
  check of D13.
- The periodic check says nothing when Shopify reports the order already
  fulfilled some other way, or cannot find it at all. The row keeps its
  status, and the console keeps listing its supplier order as one to pay.
- A retry marker for one alert can delay a DIFFERENT alert's own
  consecutive-failure count on the same order, for as long as that other
  alert keeps retrying, bounded at about three hours (12 attempts, 15 minutes
  apart). The order itself stays exactly as safely held back as before;
  only the second alert's timing shifts.
- An alert not delivered inside its 24 hour retry window is not retried
  again. If it reached 12 failed attempts first, the trail records an
  `error` line naming it as abandoned. If it simply aged past 24 hours on
  fewer failures, there is today no such line, only its individual
  failed-attempt rows. Either way, a later webhook redelivery of the same
  event is still treated as never having been told, and alerts again.
- If the database accepts a trail write but reports it as failed, the same
  line is written a second time. This shows as a harmless duplicate row in
  the order's trail, never as a duplicate action.
- If the trail row that marks an alert as delivered cannot itself be
  written, the alert is sent again on the next 15 minute run even though it
  already reached the owner. The owner may see the same email more than
  once.
- Once an order has been paid (`submitted`), nothing re-reads it against
  Shopify again until it either gets a tracking number or an operator
  releases it. A `held` order that already has a supplier order is not
  polled for tracking either, only re-checked against Shopify, until it is
  released.
- Pressing "Run fulfilment now" more than once inside the same 15 minute
  window re-reads the same page of watched orders rather than moving on to
  the next one; it does not make extra progress through a large backlog
  faster than pressing it once would.
- The checks that stop an order or flag a changed address decide from the
  order's own current status and reasons, not from whether an alert about it
  was ever delivered. An alert that was already given up on is therefore not
  raised again by these particular checks, even if it was never actually
  read.
- During a Shopify outage, an order stuck on the pre-spend check is re-read
  every 15 minutes and adds one trail line each time it fails (about 96
  lines a day for one order checked on every tick). The owner is alerted
  once after the fourth failed check in a row; because that alert's own
  trail lines interrupt the run of failures, the next alert waits for
  another four in a row, so once an outage settles in, the owner hears about
  it roughly once an hour, not once every 15 minutes.
- If PawScout is interrupted at the exact moment between the supplier
  accepting an order and this system saving that order's id, a real supplier
  order can exist that this system cannot name or find again.
- Two deliveries of the exact same Shopify cancellation arriving at the same
  moment can both raise an alert. The result is at most a duplicate email,
  never a duplicate action at the supplier.
- If the 15 minute schedule itself stops running, an alert that is due
  simply waits until the schedule starts again. Nothing is lost, only
  delayed.
- If PawScout's own database is down at the exact moment a cancel or refund
  webhook arrives, the failure counter for that delivery cannot be recorded
  either, so PawScout always asks Shopify to try the delivery again rather
  than ever reaching its own fourth-failure alert. If the database and the
  underlying problem both stay down for long enough, Shopify can still give
  up on its own (after 8 tries over 4 hours) and remove the subscription,
  with nobody told by this path; only the daily order-events check (see the
  runbook) would eventually notice and re-create it.
- The order trail's table carries an index meant to keep a growing table's
  own alert lookups fast, but a database only starts using a new index once
  it has enough real data to judge it worthwhile. This was measured during
  the build on a local copy of the schema holding 326 thousand trail rows: the same
  timing with or without the index before that judgement had been made, and
  about five times faster once it had. This is a local measurement, not a
  claim about production performance today, since the live table starts out
  far smaller. Nothing to do until the trail has grown substantially; then
  whoever maintains PawScout should run `PRAGMA optimize` and check that the
  index is actually being used.

## Evidence from the supervised runs

Written when the runs happen; this record is not complete without it.
