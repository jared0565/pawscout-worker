# Orders runbook

What happens to a paid order, what the statuses and alerts mean, and what to
do about each one. Written for the shop owner. Read this before you act on an
order that looks stuck, held, or unexpected, and before running the
supervised proof described at the end.

Throughout this document, "the supplier" means the dropshipping supplier
PawScout buys from (shown in the console and in some order ids as "CJ").
PawScout never pays a customer back and never cancels an order at the
supplier by itself; both of those always need you.

## The short version

When a customer pays, PawScout checks the order, waits an hour in case it
gets cancelled or refunded, then (only if you have switched fulfilment on)
sends it to the supplier. Depending on how you have it configured, PawScout
either pays the supplier automatically or creates the order and leaves the
paying to you. Once the supplier ships, PawScout writes the tracking number
back into Shopify, and Shopify sends the customer its own shipping email.
At every one of those steps, if Shopify shows the order as cancelled or
refunded, PawScout stops rather than guessing.

## Order statuses

| Status | What it means | What to do |
|---|---|---|
| `received` | Defined in PawScout's own records as a possible status, but no part of PawScout today ever leaves an order sitting in it: the moment an order is recorded, it is written straight into either `queued` or `held`. You should not expect to see this status in the console. | Nothing; there is nothing in this status today. |
| `queued` | The order passed its checks and is waiting out its one hour grace window. It will be sent to the supplier automatically once that hour passes, unless fulfilment is off or something changes first. | Nothing, unless you want to stop it yourself: press Cancel next to the order in the console. |
| `held` | Something needs the owner (or the team) to decide before this order goes any further. **A held order may already have a supplier order**, and often does: every stop found by the 15 minute re-check below happens to an order that already has one, as does an address change caught after it was created. The console shows the supplier order's id next to any order that has one. PawScout has not paid it. | Read the reason(s) shown next to the order (see "Hold reasons" below), then press Release to send it back into the queue, or Cancel it. **Before you press Cancel, look for a supplier order id next to the order**: Cancel only changes PawScout's own record, so a supplier order left behind by it is one nobody is watching any more. Cancel it at the supplier yourself, or handle the order by hand. A released order does not wait out another hour: the next 15 minute run picks it up, or the one after that when a run took the order less than ten minutes before (see "Run fulfilment now appearing to do nothing" below). |
| `awaiting-payment` | PawScout has created the supplier order and has not paid it. Either PawScout is set to create orders only and leave the paying to you (see "Create-only", below), or an automatic payment attempt failed for a money reason. | Check the supplier order shown next to the order (labelled "CJ" in the console) at the supplier's own site, and pay it there if it is still unpaid. **PawScout cannot see a payment you make at the supplier, so tell it:** press **I paid this** next to the order, then press it again within 8 seconds to confirm. From then on the console shows the order as "paid by you, waiting for tracking", it leaves the banner and the overview's count of orders PawScout has not paid, and PawScout never pays that supplier order itself. The order keeps its `awaiting-payment` status on purpose, so the 15 minute re-check below still watches it for a cancellation, and its tracking number still syncs back when the supplier ships. Pressed it by mistake? **Not paid after all** next to the order puts it back in the list. Until you press I paid this, the order stays in the banner even if you have paid it, so check a supplier order's own state at the supplier before paying anything in this list. An order only ever reaches `submitted` when PawScout itself paid it. |
| `submitted` | The supplier order was created and PawScout itself has paid it. An order you paid by hand never shows this status (see `awaiting-payment` above). | Nothing normally. See the note below: once an order reaches this status, PawScout stops re-reading it against Shopify; a cancellation or refund that does reach it by webhook is still alerted. |
| `fulfilled` | A tracking number has been written back into Shopify, and Shopify has sent the customer its own shipping notification. | Nothing. |
| `cancelled` | This order will not be sent to the supplier. If a supplier order already existed when the cancellation happened, check whether you received one of the alerts below telling you what to do about it. | Depends on the alert, if any; see "Alerts" below. |
| `error` | Something went wrong while trying to process this order, for example the supplier had no stock for one of the items, or a step failed unexpectedly. Nothing retries it by itself. You are emailed about it (see "Order `<name>` could not be sent to the supplier" below), except for a stockout, which has its own email. | Read the reason shown next to the order to understand what happened. **If the order's timeline says `failed at create` or `failed at record`, an order for it may already exist at the supplier** (the request can reach the supplier while its answer is lost on the way back). Look for **the order number PawScout gives the supplier** and deal with whatever you find there BEFORE anything is retried, or it will be ordered twice. That number is the long Shopify order id: the digits at the end of the order's page address in the Shopify admin. It is not the short order name the shop shows next to the order (`#1002`), which the supplier never sees. It is the number the email about this order prints, and the number meant everywhere below by "the order number at the supplier". The console does not currently offer a button to send this order back into the queue by itself; ask whoever maintains PawScout to move it back to `queued` if it should be retried. |

Pressing Release or Cancel in the console only changes PawScout's own record
of the order. Cancel does not cancel or refund the order in Shopify, and
Release does not un-cancel one. To actually cancel or refund an order, do it
in the Shopify admin, as you always have; PawScout will then react to that
through the gate and the webhooks described below. I paid this, and its undo,
also only change PawScout's own record: they pay nothing and tell the supplier
nothing. Today the console shows Release and Cancel buttons only next to a
`held` order, a Cancel button next to a `queued` one, and I paid this (or Not
paid after all, once pressed) next to an `awaiting-payment` order that has a
supplier order; an `error` order has no button in the console (see above).

**Once PawScout itself has paid a supplier order, that order stops being
re-read against Shopify for a cancellation or a refund.** PawScout re-checks
`awaiting-payment`, `held` and `error` orders that carry a supplier order
against Shopify every 15 minutes (see "How PawScout catches a cancellation
once a supplier order exists" below). An order you paid by hand stays
`awaiting-payment` whether or not you pressed I paid this, so it stays in that
check until its tracking number arrives. A `submitted` order (paid by PawScout) is not
part of that check, and is only ever looked at again to find its tracking
number. If a
`submitted` order is cancelled or refunded in Shopify and the cancel or
refund webhook is lost, nobody will notice from PawScout's side. A `held`
order that already has a supplier order is also not checked for tracking
until it is released back into the queue.

## Hold reasons

Shown next to a `held` order (and, for `shopify-cancelled`, next to a
`cancelled` one). An order can carry more than one. The same place in the
console also shows a free-text reason next to an `awaiting-payment` order
(which supplier order PawScout has not paid) and next to an `error` order
(what failed; this text can include the supplier's own message). When the 15
minute re-check below stops an `awaiting-payment` order, the reason naming
its supplier order is dropped, because that order must not be paid now; the
supplier order's id is still shown next to the order itself. An `error`
order's own reason is always kept, because it is the only record of why that
order failed, so a `held` order can show the supplier's own message too.

| Reason | What it means | What to do |
|---|---|---|
| `unmapped-items` | One or more products in the order are not linked to a supplier product. | Link the product to a supplier product, or handle the order by hand, then Release. |
| `incomplete-address` | The shipping address is missing something PawScout needs to ship it (name, first address line, city, postcode, or country). | Complete the address on the order in Shopify, then Release. PawScout reads the address from Shopify again when it checks the order, so a completed address will be picked up. |
| `high-risk` | Shopify's own fraud check flagged this order. | Look at the order in the Shopify admin and decide whether to proceed, then Release or Cancel. |
| `medium-risk-value` | Shopify's fraud check flagged this order as worth a second look, and its total is over GBP 40. | Same as `high-risk`, but only for orders large enough that a second look is worth it; smaller orders with the same flag are not held. |
| `over-threshold` | The order's total is over GBP 100. | Review it before releasing. This is a size check, not necessarily a problem. |
| `not-paid` | Shopify does not show this order as paid. | Check the order's payment status in Shopify before releasing. |
| `on-hold` | The merchant (you) paused this order in Shopify itself. | Check the order in the Shopify admin; release it here once you have decided in Shopify. |
| `refunded` | Shopify shows this order refunded (fully, partly, or voided). A supplier order may already exist for it: the check that runs before spending, and the 15 minute re-check, both write this reason on orders that already have one. | **PawScout cannot carry this order any further, and Release will not change that:** the check before spending reads Shopify's refund again on the next run and stops it again, with the same reason and the same email. Anything still to be done for this order has to be done by hand: see "A refund without a cancellation" below for exactly what. Check whether a supplier order exists for it: the console shows its id next to any order that has one, the alert you received names it, and so does the order's timeline. |
| `already-fulfilled` | Shopify shows this order already fulfilled some other way, for example shipped by hand. | Check before releasing, so the supplier is not asked to ship a duplicate. |
| `order-missing` | PawScout could not find this order in Shopify when it last checked. | Check the order directly in Shopify. |
| `mixed-origin` | The products in this order would need to ship from more than one supplier warehouse. PawScout does not split orders across warehouses. | Decide by hand: order it from the supplier yourself, split it into separate Shopify orders, or contact the customer. |
| `freight-mismatch` | Before booking, PawScout asks the supplier what it charges TODAY to deliver this exact basket (every line, every quantity) to the order's own country, and compares it with what was allowed for: the synced nightly rate for that route, per unit, times the units ordered (the rate the checkout delivery charge and the prices are built on). The live figure was above that by more than a quarter plus one dollar, or there was no synced rate for the route to compare with. Both figures are in the order's timeline (`freight-quoted`) and in the email. Nothing was sent to the supplier. | Look at the two figures. If the order is still worth booking at the live cost, press Release: the live figure the hold showed becomes the approved cost, and the next run books it as long as the supplier's quote is then within a quarter plus one dollar of that figure. If the quote has risen further by then, or the held figure cannot be found in the timeline, the order is held again with this reason and you get a new email with the new figure; Release again to approve that one. If not, cancel it and refund the customer. A route with no synced rate means the nightly logistics sync has not covered it: check the sync. |
| `no-freight-route` | The supplier offers no delivery channel at all from the chosen warehouse to the order's country for this basket. Nothing was sent to the supplier. | Check the route at the supplier (a different warehouse may serve it). Order it by hand if it can be served, otherwise contact the customer and cancel. Release only re-runs the same check. |
| `address-changed-after-supplier-order` | The delivery address changed in Shopify after the supplier order was already created there, so the supplier order still carries the OLD address. PawScout has already saved the new address on this order and told you by email, but has not paid the supplier order and will not until you act. | Correct the address on the supplier order at the supplier (or, if the supplier cannot change it, cancel it there and handle the order by hand), then press Release. Releasing this order is your statement that the supplier order now carries the correct address; PawScout does not check that for you. |
| `supplier-order-not-confirmed-unpaid` | The order came back to the queue (for example after Release) with a supplier order already created, and just before paying it PawScout read that order at the supplier. The supplier did not report it as unpaid (`CREATED`), or the order could not be read at all, so it may already have been paid by hand. PawScout has not paid it. What the supplier reported is in the order's timeline and in the email. | Check the supplier order at the supplier. If it is still unpaid, pay it there, or press Release: PawScout reads it again and pays it once the supplier shows it unpaid. If it is paid, there is nothing more to pay, but a held order is not polled for tracking, so add the tracking in Shopify by hand once it ships. |
| `shopify-cancelled` | The order was cancelled in Shopify. The order's status is `cancelled`; this reason just records why. | Nothing extra beyond what the status and any alert already tell you. |

## A refund without a cancellation

A refund and a cancellation are not the same thing to PawScout, on purpose. A
partial refund can be a goodwill gesture on an order you still want to ship.

- If no supplier order exists yet, a refund holds the order with reason
  `refunded` (see the table above), so you decide.
- If a supplier order already exists, the refund itself does not change the
  order's status. You get an alert naming the refund amount and the supplier
  order, so you can decide whether the supplier order should still go ahead.

**What actually happens next, and it is not what those two lines alone
suggest.** Within 15 minutes the re-check below reads the same refund in
Shopify, holds the order with reason `refunded`, and sends you a second
email telling you not to pay the supplier order. Both emails are about one
refund; the second one overrules the first. From then on:

- **PawScout cannot send a refunded or partly refunded order to the supplier
  at all**, and it cannot pay one. Pressing Release does not change this: the
  check before spending reads the refund again on the next run and stops the
  order again, sending the same email each time.
- **A held order is not checked for a tracking number**, so if you have
  already paid that supplier order by hand and it ships, its tracking number
  will never be written into Shopify by PawScout and the customer will never
  get Shopify's shipping email.

So a goodwill refund on an order you still intend to ship is a case PawScout
hands entirely back to you. Do it by hand:

1. If no supplier order exists and you still want the goods sent, buy the
   order at the supplier yourself.
2. If a supplier order exists and you want it to go ahead, pay it at the
   supplier yourself (check its own state there first).
3. When it ships, enter the tracking number on the order in the Shopify
   admin yourself. That is what tells the customer.

If you do NOT want the order to go ahead, cancel the supplier order at the
supplier, and press Cancel in the console so the order stops being watched.

## How PawScout catches a cancellation once a supplier order exists

The check that runs just before PawScout itself pays a supplier order only
exists at the moment PawScout is about to spend money. When you are the one
paying the supplier order by hand instead (Create-only is on), there is no
such moment for PawScout to stand at. Instead, every 15 minutes, PawScout
re-reads every order that already has a supplier order and is not yet
settled (its status is `awaiting-payment`, `held`, or `error`), directly
against Shopify. Up to 20 orders are checked on each run, oldest first; if
there are more than that waiting, PawScout works through them in turn across
several runs rather than always checking the same ones and never reaching
the rest.

For each order it checks:

- If Shopify now shows it cancelled, PawScout applies the same cancellation
  handling described above (the order becomes `cancelled`, and you get
  whichever cancellation alert fits).
- If Shopify shows it refunded, not paid, paused, or without a usable
  address, PawScout stops the order (see "Hold reasons" above) and alerts
  you, the same as if the automatic check had caught it before spending.
- If only the delivery address changed, PawScout saves the new address and
  alerts you, but deliberately does NOT stop the order for that alone (doing
  so would take it out of this very check, and out of the tracking check,
  while you still have to pay it). See the address-changed alert under
  "Alerts you might receive" below for what to do.
- Two findings neither stop the order nor change its status, but you are
  told about each one once: Shopify showing the order already fulfilled some
  other way, and PawScout not being able to find the order in Shopify at all.
  Neither says that money came back, which is why the order is not stopped;
  both say something about money that is still about to go out, which is why
  you hear about them. They are raised only for an order in
  `awaiting-payment`, the ones you still have to pay, and only once per order
  and finding. See the two alerts under "Alerts you might receive" below.

This is a genuine second safety net, separate from Shopify's cancel and
refund webhooks: it works even if a webhook delivery is lost. It does not
run for an order that has already been paid by PawScout itself (`submitted`)
- see the note on that status above.

## The off switch

The fulfilment mode setting in the console (labelled "PawScout auto (create +
pay + track)" when it is on) is the one control that governs everything in
this document. Set it back to "Manual (queue only)" at any time, from the
console, to stop every automatic submission and payment at once. Nothing else
needs to change. Nothing more is sent to the supplier and nothing more is
paid. Orders that are already `queued` or `submitted` stay exactly where they
are; you decide what happens to them by hand. PawScout still watches orders
that already have a supplier order (`awaiting-payment`, `held` or `error`):
it will still stop one, or mark it cancelled, and tell you, if Shopify shows
it cancelled or refunded, and it still retries any alert that has not
reached you. That watch needs only the Shopify connection, so it also keeps
running if the supplier connection is removed or its key is rotated out,
which is exactly when an unsettled supplier order most needs watching.

The separate "Create-only" switch only matters while fulfilment mode is set
to PawScout auto. With it ON, PawScout creates the supplier order and stops,
leaving every payment to you (this is the setting used for the supervised
proof below). With it OFF, PawScout pays the supplier automatically from the
supplier account's balance.

## Reading an order's timeline

In the console's orders list, press an order's name (or number) to open its
timeline underneath it. Each line is one moment in that order's life, oldest
first: a time, a short label, and, where there is one, a little more detail.
The timeline never shows the customer's name, address, email, or phone
number, even for an event that involved them.

What the labels mean:

| Label | What happened |
|---|---|
| `received` | The order arrived from Shopify. |
| `held` / `queued` / `released` | The order's status changed to this. |
| `gate-passed` | The automatic check against Shopify's current record of the order, run just before money moves, found nothing wrong. |
| `gate-held` | That same check found a reason to stop (see "Hold reasons" above; the reason is in the detail). |
| `gate-unreadable` | That same kind of check could not read the order's current state from Shopify at all that time. If no supplier order exists yet, nothing was sent to the supplier because of it; if one already exists, it was not paid because of it. The detail is either `Shopify HTTP` followed by a status number, or the fixed phrase `read failed`; Shopify's own error text is never copied here (it is in the alert email after four failures in a row, and in PawScout's own logs). |
| `address-refreshed` | The shipping address had changed in Shopify since the order was received, and PawScout is using the newer one. |
| `stock-ok` | The supplier had enough stock for every line. |
| `stockout` | The supplier did not have enough stock. |
| `freight-quoted` | The supplier's live delivery cost for this exact basket to the order's country, the channel it would travel by, and the figure it was checked against (the synced rate times the units), for example `CN->US, 4 units: live USD 9.80 via Economy (12-20 days); allowed for USD 22.00`. Written on every booking, held or not. |
| `freight-unreadable` | The supplier's live delivery cost could not be read that time (the fixed phrase `quote failed`; the supplier's own text is never copied here). Nothing was sent to the supplier; the order stays queued and is retried every 15 minutes, and after four failures in a row you get the "delivery cost could not be checked" email. |
| `supplier-order-created` | An order was created at the supplier (the detail names its id). |
| `awaiting-payment` | The supplier order needs paying by hand. |
| `paid` | PawScout paid the supplier order. |
| `tracking-found` | A tracking number arrived from the supplier. |
| `tracking-written` | That tracking number was written into Shopify successfully. |
| `tracking-write-failed` | Writing that tracking number into Shopify failed. The detail is always the same fixed phrase, `write to Shopify failed`: the trail never copies Shopify's own error text. The actual reason is in the alert email you get after four failures in a row, and in PawScout's own logs. |
| `cancel-received` | Shopify told PawScout this order was cancelled. |
| `refund-received` | Shopify told PawScout this order was refunded. |
| `owner-alert-due` | PawScout has decided to email you about this order and has recorded that intention, before actually trying to send it. |
| `owner-alerted` | The email was sent and the provider confirmed it was accepted. |
| `owner-alert-failed` | An attempt to send that email failed; it will be tried again on a later run (see "How an alert reaches you" below). |
| `owner-alert-unconfigured` | PawScout tried to email you about this order, but no alert address or no email sending key is set up, so nobody could be told. |
| `operator-action` | The owner, or someone on the team, pressed Release or Cancel on this order in the console. |
| `error` | Something failed; the detail says what. This can also record that an alert was given up on after repeated failures (see below). |

## Checking that order events are reaching PawScout

Cancellations and refunds only reach PawScout if Shopify is actually sending
them. The orders card in the console shows a line for this, right under the
fulfilment mode line:

- `Order events: all 3 subscribed (checked <time>)` means Shopify is sending
  paid, cancelled, and refunded events to PawScout. Nothing to do.
- `Order events: MISSING <topics>. A cancel or refund can go unnoticed.`
  means one or more of those is not reaching PawScout right now. Press the
  "Check order events" button next to that line: it asks Shopify to
  (re)create whatever is missing, then reports the current state.
- `Order events: not checked yet` means nobody has run this check since the
  console started reporting it. Press "Check order events".
- `Order events: the check failed (<reason>), so nothing is known. Checked
  <time>.` means the last attempt to ask Shopify could not even complete; it
  is deliberately shown as "unknown", never as a confident list of what is
  missing, because a failed check is not proof that anything is actually
  wrong. Press "Check order events" to try again.

This check also runs once a day by itself, as the first thing PawScout's
daily maintenance does for the shop. If something is confirmed missing after that daily
attempt to fix it, you get an email alert (see below), because a missing
subscription means a cancellation or refund after a supplier order exists
could go unnoticed. If the daily check itself keeps failing to complete
(rather than succeeding and finding something missing), you get a
different alert once it has failed 3 days in a row, and again every 3 days
after that for as long as it keeps failing, because by then it is worth
knowing that PawScout cannot even tell whether it is covered.

## How an alert reaches you, and what happens when it cannot

Most of the alerts below (everything except the two "order events" alerts,
the "order event could not be processed" alert, and the two older "awaiting
payment" and "out of stock" emails, all described further down) go through
the same confirm-or-retry process:

1. **Due.** PawScout first records, in the order's own trail, that it intends
   to tell you something (`owner-alert-due`), before it even tries to send
   the email. For the first minute after that, the 15 minute sweep leaves a
   due alert with no failure yet alone, on the assumption that the original
   attempt to send it is still genuinely under way; only after that minute
   does an unresolved due alert count as ready to be tried again.
2. **Sent.** If the email provider accepts the message, the trail records
   `owner-alerted`. This is the only outcome that counts as "the owner was
   told".
3. **Failed.** If sending fails, the trail records `owner-alert-failed`, and
   PawScout tries again on a later 15 minute run, up to 12 attempts and for
   up to 24 hours since the alert was first raised. At most 10 alerts are
   retried in any one 15 minute run, so on a shop with many pending alerts at
   once, some wait for the next run.
4. **Unconfigured.** If there is no alert address, or no email sending key
   set up at all, the trail records `owner-alert-unconfigured` and PawScout
   does not keep trying, because there is nobody to try. **This is why the
   alert address and the email sending key must both be set up BEFORE you
   switch fulfilment mode to PawScout auto.** If an alert is marked this way
   and you configure alerting afterwards, that specific past alert stays
   quiet for good, even if Shopify delivers the same cancellation again; only
   a genuinely different event (a different refund, or a later stop on the
   same order) raises a new one.
5. **Given up.** If an alert still has not been delivered after 12 attempts,
   PawScout stops trying and records that in the trail as an `error` line
   naming the alert it gave up on. If, instead, 24 hours pass with fewer than
   12 failures, PawScout also stops trying, but today leaves no explicit
   "gave up" line for that case, only the individual failed-attempt rows
   already in the trail.

If the same email would have been sent more than once, for example because
Shopify redelivered the same cancellation twice, a "delivered" marker itself
failed to save, or the email provider took longer than 10 seconds to answer
(PawScout counts that send as failed and tries again, even if the first one
did arrive), you may occasionally receive the same alert twice.
This is expected and treated as the safer outcome compared to risking one
being lost.

A retried alert's email starts with a line explaining that it was raised
earlier and could not be delivered then, followed by the same subject line
and a short summary (the supplier order id and the tracking number, each
shown as "(not recorded)" when there is none, and the order's current
status), and it always ends by telling you not
to pay or settle anything at the supplier until you have opened that order's
trail in the console and read its full history.

## Alerts you might receive

Alerts arrive as an email to the alert address set in the console. Each one
below is shown with its exact subject line, so you can match it to what
lands in your inbox.

**Cancellations, by how far the order had already got:**

**"Order `<name>` was cancelled: do NOT pay the supplier"**
The order was cancelled in Shopify after a supplier order was created for
it, and PawScout has not paid that supplier order. PawScout has spent
nothing. Do not pay it. If it is still unpaid, cancel it yourself at the
supplier. If you had already paid it by hand, PawScout does not know that:
ask the supplier to cancel and refund it, and treat it as a return if it has
already shipped. The email says the same.

**"Order `<name>` was cancelled after you paid its supplier order"**
The same cancellation, for an order you had marked with I paid this. The
email gives the date you marked it. Ask the supplier to cancel and refund the
supplier order, and treat it as a return if it has already shipped. If it
turns out it was not paid after all, do not pay it now: cancel it at the
supplier.

**"Order `<name>` was cancelled after it was paid at the supplier"**
The order was cancelled in Shopify after PawScout had already paid the
supplier order. Ask the supplier to cancel it if it has not shipped yet. If
it has already shipped, treat this as a return.

**"Order `<name>` was cancelled after it shipped"**
The order was cancelled in Shopify after it had already shipped. Treat it as
a return.

**"Order `<name>` was cancelled and a supplier order exists for it"**
A more general version of the three alerts above, for an order whose status
does not fit one of those specific cases (for example, one an operator had
released back into the queue) but that still carries a supplier order. It
makes no claim about whether that supplier order has been paid. Check its
state directly at the supplier: cancel it there if it is unpaid, and treat
it as a return if it has already been paid.

**"Order `<name>` was refunded `<currency>` `<amount>`"** (sometimes with
"`(refund <id>)`" added at the end, when Shopify gave the refund its own id)
A refund landed on an order that already has a supplier order. The order's
status has not changed by itself. Decide, using the supplier order id and
its current status given in the email, whether that supplier order should
still go ahead.

**Stopped before or during the money moving:**

**"Order `<name>` was cancelled while its supplier order was being created"**
The order was cancelled in Shopify while PawScout was working on its supplier
order: creating it, or failing to pay it automatically for lack of balance at
the supplier. It can also reach an order you released back into the queue
whose supplier order already existed, and which you may have paid by hand
since, so the email makes no claim about payment either way. PawScout has not
paid it. Check its state at the supplier: cancel it there if it is unpaid,
and treat it as a return if it has been paid.

**"Order `<name>` was cancelled while its supplier order was being paid"**
The order was cancelled in Shopify at the exact moment PawScout was paying
its supplier order, and the payment had already gone through by the time the
cancellation was noticed. Ask the supplier to cancel it if it has not
shipped; if it has shipped, treat it as a return.

**"Order `<name>`: payment to the supplier was stopped"**
Something about the order changed in Shopify (the exact reason is named in
the email, for example a cancellation, a refund, or the order being paused)
after its supplier order was created but before PawScout paid it, so
PawScout did not pay it. It can also reach an order you released whose
supplier order already existed, and which you may have paid by hand since,
so the email makes no claim about payment either way. Check its state at the
supplier: cancel it there if it is unpaid, and treat it as a return if it has
been paid.

**"Order `<name>` was stopped and a supplier order exists for it"**
The automatic check found a reason to stop this order (the reason is named
in the email) after its supplier order already existed. The email makes no
claim about whether that supplier order has been paid; check its state
directly at the supplier.

**"Order `<name>`: the delivery address changed after the supplier order was
created"**
The customer's delivery address changed in Shopify after PawScout had
already created the order at the supplier, so the supplier order still
carries the OLD address. PawScout has already saved the new address on this
order here, either way. What to do next depends on the order's status when
you read the email:
- If the order's status is now `held` with reason
  `address-changed-after-supplier-order`, correct the address on the
  supplier order at the supplier (or cancel it there if the supplier cannot
  change it), then see that hold reason above for what releasing the order
  means.
- If the order's status did NOT change (most often because it is still
  `awaiting-payment`, which means only that PawScout has not paid it), there
  is nothing to release: correct the address on the supplier order at the
  supplier before you pay it, or, if you have already paid it by hand, ask
  the supplier to update the address before it ships.

**"Order `<name>` could not be sent to the supplier"**
A step failed and the order is now in `error`. The email names the step it
failed at and, when one exists, the supplier order id; it never repeats the
supplier's or Shopify's own error message. Nothing retries this order by
itself. If it failed at the create or the record step, or if it already had a
supplier order, the email says so and prints the order number at the supplier
(the long Shopify order id, as described under the `error` status above):
look for that number at the supplier before anything is retried, so it is not
ordered twice. Otherwise it says plainly that nothing was sent to the
supplier. One variant of this email opens differently: if the order was
cancelled in Shopify while the failing step was still running, the order
stays `cancelled` rather than becoming `error`, and the email says so instead
of saying it is now in error. The rest of it, including the order number to
look for, is the same. A failure caused by the supplier being out of stock
does not send this email; it sends the out of stock one below instead.

**An order still on your list to pay that Shopify says is finished with:**

**"Order `<name>` shows as fulfilled in Shopify and its supplier order is
still open here"**
Shopify says this order has shipped, but PawScout still lists its supplier
order among those it has not paid. If you shipped it some other way, do NOT
pay that supplier order: cancel it at the supplier. If you paid it and it
shipped, there is nothing to do. Sent once per order. Nothing is held and
nothing changes status because of it. One harmless false alarm is possible:
if PawScout's own tracking write-back reached Shopify but could not be
recorded here (see the tracking alert above), this email arrives with both of
its cases untrue.

**"Order `<name>` can no longer be found in Shopify and a supplier order
exists for it"**
PawScout cannot find this order in Shopify at all, while still listing a
supplier order for it as not paid. Shopify only lets an order be deleted once
it has been cancelled or archived, so this can be a cancellation whose
notification was lost followed by a deletion. It can also simply be an order
older than 60 days, which is as far back as PawScout can read. Do NOT pay
that supplier order until you have found out which it is. If you have already
paid it by hand, which PawScout cannot see, check its state at the supplier:
if the order turns out to have been cancelled, ask the supplier to cancel it,
and treat it as a return if it has shipped. The email says the same. Sent once
per order.

**Checks that could not be completed:**

**"Order `<name>` cannot be checked against Shopify"**
PawScout could not confirm this order's current state in Shopify on four
checks in a row (roughly the last hour, checking every 15 minutes). If no
supplier order exists yet, nothing has been sent to the supplier because of
it. If a supplier order already exists, PawScout will not pay it itself
until the check succeeds, and if you were about to pay it by hand, check the
order in Shopify first. PawScout keeps retrying by itself every 15 minutes;
you do not need to do anything unless the problem is on Shopify's side and
you can see that from the Shopify admin.

**"Order `<name>`: tracking could not be written to Shopify"**
The supplier has shipped this order and given a tracking number, but writing
that number into Shopify could not be confirmed on four attempts in a row.
Open the order in the Shopify admin and look: if it already shows fulfilled
with that tracking number, the customer has been told and there is nothing to
do (a write can reach Shopify while the confirmation of it is lost here, and
after that every retry fails for the same reason). If it does not, tell the
customer the tracking number yourself while the cause is found. PawScout
keeps retrying every 15 minutes, and while it is in this state it will send
this email about once an hour.

**"An order event from Shopify could not be processed"**
One of Shopify's paid, cancelled, or refunded webhook deliveries for this
order failed while PawScout was processing it, 4 times in a row (the email
names Shopify's own event name, for example `orders/cancelled`, and the
order id). PawScout has stopped asking Shopify to resend that one delivery,
because asking too many more times is what makes Shopify remove the whole
subscription. This alert is sent once per failed delivery, straight to your
inbox: it is not recorded in the order's own trail, and it is not retried if
sending it fails, so if the order looks like it never heard about a
cancellation, refund, or payment, check it directly in Shopify and in the
PawScout console.

**Shopify's own event feed:**

**"Order events are not fully subscribed"**
See "Checking that order events are reaching PawScout" above. This is sent
once a day, only when the check itself succeeded and found something
missing.

**"Order event subscriptions could not be checked"**
PawScout has not been able to even ask Shopify which order events it is
subscribed to, for at least 3 days in a row (the email says exactly how many
days, and why, if known); it repeats every 3 days after that while the
problem continues. Until a check succeeds, it is not known whether a
cancellation or refund is reaching PawScout at all. Open the console and
press "Check order events".

**Two older emails, sent once and not retried:**

These two do not go through the confirm-or-retry process described above; a
failed send is only logged, never tried again, so if you never receive one
you expect, check the order directly in the console.

**"Active Paw - order `<name>` awaiting payment in CJ"**
One subject, two meanings, and the email itself says which. Usually the
supplier order has just been created and is genuinely waiting for you to pay
it. But an order you released back into the queue, whose supplier order
already existed, gets this email again when it returns to the list, and that
one may have been paid by hand already: its text says the order is back in
the list after being released, that PawScout has not paid it, and to check
its state at the supplier before you pay it. Either way this is the same
information the `awaiting-payment` status and the console's own banner
already show; the email is a convenience, not the record of truth.

**"Active Paw - order `<name>` cannot be fulfilled (out of stock at source)"**
The order could not be sent to the supplier because an item was out of
stock there. The email explains what PawScout already did about it (for
example, hiding the item from sale) and suggests next steps (checking for a
restock, telling the customer, or refunding).

## What PawScout does not do

- It does not pay the supplier automatically while Create-only is switched
  on, and it never pays the supplier at all while fulfilment mode is set to
  Manual.
- It cannot cancel an order at the supplier through the supplier's own
  systems. Every supplier-side cancellation named in an alert above needs
  you to do it, at the supplier's site.
- It cannot cancel or refund a Shopify order. That always stays with you, in
  the Shopify admin; PawScout only reacts to what you (or a customer's bank)
  did there.
- It does not read or check the supplier account's balance.

## Part 2: the supervised proof

Once part 1 (everything above) is live, the loop is proven with real orders
on the live shop, each paid by the owner with a real card. This section is
the procedure for that.

### Before the first order

Check all five of these, in order, before placing any real order:

1. Part 1 is live in production: it went out through the guarded deploy with
   your go, and its database change has already been applied there.
2. The console's "Order events" line (see above) shows all 3 subscribed.
3. You have switched fulfilment mode to "PawScout auto" in the console, and
   left Create-only switched ON. Before you switch it, confirm that the alert
   address and the email sending key are both set: an alert raised while
   either is missing is recorded as "nobody to tell" and stays quiet
   afterwards (see "Unconfigured" under "How an alert reaches you" above),
   and run 3 below depends on an alert arriving. PawScout has two alert
   address settings: the alerts about money go to the inbox alert address
   when one is set, and otherwise to the orders card's alert address, while
   the "awaiting payment" email always goes to the orders card's address.
   Set both to the same address, or read both inboxes: run 1 waits on the
   "awaiting payment" email.
4. **The supplier's own Shopify app is not importing orders.** If CJ's own
   app is installed on this shop with its order import switched on, every
   paid order is created at the supplier TWICE: once by that app and once by
   PawScout, which knows nothing about the other one. Two unpaid supplier
   orders would then sit there for one Shopify order, in the very list you
   pay from. Open the supplier's app in the Shopify admin and confirm its
   order import is off before switching PawScout to auto. The console says
   the same thing next to the mode setting.
5. A product has been chosen for the three runs below: one with a single
   variant, a low price, in stock at the supplier, and already linked to a
   supplier product.

### The three runs

Each run is a real order, placed by you on the live shop with a real card.

**Run 1, happy path.** Buy the item. When the "awaiting payment" email
arrives, before paying, open the supplier's own order list and record that
**exactly one supplier order exists for this Shopify order**. Look through
that day's orders at the supplier rather than searching for one number only:
PawScout's orders carry the order number described under the `error` status
above, but an order placed by the supplier's own app may not carry it. Then
pay that supplier order by hand.
What should happen: the order's timeline shows every expected step, ending
with a written tracking number; the Shopify order shows fulfilled with a
working tracking link; you, as the customer, receive Shopify's own shipping
email. Between `stock-ok` and `supplier-order-created` the timeline shows
`freight-quoted`: the supplier's live delivery cost for this basket to your
address's country, and the figure it was checked against. Run 1 is the first
live proof of that check.
This run has failed if: any of those steps is missing from the timeline, no
`freight-quoted` line comes before `supplier-order-created`, more than one
supplier order exists for this Shopify order, the shipping email never
arrives, the tracking write-back keeps failing, or the tracking link does not
open.

**Run 2, cancel during the grace window.** Buy the item, then cancel and
refund it in the Shopify admin within the hour.
What should happen: the order becomes `cancelled`, and once the hour has
passed, no supplier order exists for it.
This run has failed if: a supplier order exists for it.

**Run 3, cancel after the supplier order exists.** Buy the item, wait for
the "awaiting payment" email, record that **exactly one supplier order exists
for this Shopify order** at the supplier, looking through that day's orders
there as in run 1, then cancel and refund it in the Shopify admin.
What should happen: you receive the "do NOT pay the supplier" alert, and the
order becomes `cancelled`. You then cancel the unpaid supplier order
yourself, at the supplier.
This run has failed if: no alert arrives, more than one supplier order exists
for this Shopify order, or the order is still shown as `awaiting-payment`.

### What you may see, and what it means

None of these is a failure. They are recorded here so nobody reads one as
one.

- **A `freight-mismatch` hold, or `freight-unreadable` lines, in run 1.**
  Before booking, PawScout asks the supplier what it charges today to deliver
  this exact basket to the order's country (see `freight-quoted` above). If
  that live cost is above what was allowed for by more than a quarter plus
  one dollar, or there is no synced rate for that route to compare it with,
  the order is held as `freight-mismatch` and you get an email
  with both figures; nothing is sent to the supplier. That is the check doing
  its job: read the two figures (see "Hold reasons" above), then press
  Release to approve the live cost and book it, or cancel and refund. A
  quote that has risen past that approved figure by more than the same
  margin when the order is booked holds it again. `freight-unreadable`
  means the supplier's cost could not be read that time: the order stays
  queued, is tried again every 15 minutes, and after four failures in a row
  you get the "delivery cost could not be checked" email.
- **A grant Shopify refuses, on the very first order.** Reading an order's
  state needs Shopify's protected customer data permissions. If one of the
  fields is refused, EVERY order fails the check closed, so run 1 shows a
  `gate-unreadable` line every 15 minutes and, after an hour, the "cannot be
  checked against Shopify" email. Nothing is sent to the supplier and nothing
  is paid, so it is safe; but know the signature. That pattern on the very
  first order means a missing permission, not an outage.
- **The "Order events" line stuck on MISSING.** Precondition 2 is the first
  time the subscriptions are created and read back for real on this shop. If
  Shopify records the address slightly differently from the one PawScout asks
  for, the line shows MISSING for good even though the events do arrive. That
  blocks the runs rather than corrupting them: it is visible, and nothing
  proceeds on a false "all subscribed".
- **Run 3 producing two emails, in either order.** The cancellation reaches
  PawScout two ways (Shopify's own notification and the 15 minute re-check),
  and the refund you make alongside it raises its own "decide whether the
  supplier order should still go ahead" email. So you may get both, in either
  order; and if the refund notification happens to arrive after the
  cancellation, the order is already `cancelled` and only the cancellation
  email comes. Any of those shapes is the run passing, as long as one email
  tells you not to pay.
- **An extra `address-refreshed` line in run 1.** The first check compares the
  address Shopify sent with the order against the one Shopify's API returns
  for it. If Shopify writes any part of it differently in the two places (the
  spacing of a phone number is the likeliest), the check saves the API's
  version and writes this line. Unless the address really was changed, it is
  cosmetic.
- **Duplicate `tracking-found` lines, or one `tracking-write-failed` next to
  a `tracking-written`.** These appear if the 15 minute run and a press of
  "Run fulfilment now" happen to overlap. The customer is told once either
  way.
- **"Run fulfilment now" appearing to do nothing.** A run takes each order it
  works on for ten minutes, counted from the moment it takes that order, so
  two runs that overlap cannot both send the same order to the supplier. Those
  ten minutes
  outlast the run itself, so a press of the button can find nothing to do for
  an order a recent run already took. Three cases look like this: press the
  button twice inside ten minutes and the second press skips the order the
  first one took; release an order that a run held, and the button does
  nothing for it until the rest of those ten minutes are up; and an order
  whose check against Shopify could not be read is not looked at again by the
  button for ten minutes either. In each case the order is picked up by the
  first 15 minute run that starts after those ten minutes are up.

### What it costs, and what to do if something looks wrong

One real product, bought and shipped (run 1), plus the card processing fees
on the two orders you deliberately cancel and refund (runs 2 and 3). If
anything in a run looks wrong, switch fulfilment mode back to Manual
straight away using the off switch above, and find the cause before trying
the next run.

Every run's evidence, the order's timeline, the Shopify order's own
timeline, the supplier order id, and the emails you received, gets written
into `docs/decisions/0002-money-loop.md`.
