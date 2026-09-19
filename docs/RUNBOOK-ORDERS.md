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
| `held` | Something needs the owner (or the team) to decide before this order goes any further. Nothing has been sent to the supplier. | Read the reason(s) shown next to the order (see "Hold reasons" below), then press Release to send it back into the queue, or Cancel it. A released order is due straight away, on the next 15 minute run, not an hour later. |
| `awaiting-payment` | The supplier order has been created but not paid. Either PawScout is set to create orders only and leave the paying to you (see "Create-only", below), or an automatic payment attempt failed for a money reason. | Pay the supplier order shown next to the order (labelled "CJ" in the console) at the supplier's own site. **PawScout cannot see that you paid it:** the order stays `awaiting-payment` here, and the console banner keeps naming it, until the supplier ships and a tracking number arrives. It only ever reaches `submitted` when PawScout itself paid it. Before paying anything in this list, check that supplier order's own state at the supplier, so a slow shipment is never paid for twice. |
| `submitted` | The supplier order was created and PawScout itself has paid it. An order you paid by hand never shows this status (see `awaiting-payment` above). | Nothing normally. See the note below: once an order reaches this status, PawScout stops re-reading it against Shopify; a cancellation or refund that does reach it by webhook is still alerted. |
| `fulfilled` | A tracking number has been written back into Shopify, and Shopify has sent the customer its own shipping notification. | Nothing. |
| `cancelled` | This order will not be sent to the supplier. If a supplier order already existed when the cancellation happened, check whether you received one of the alerts below telling you what to do about it. | Depends on the alert, if any; see "Alerts" below. |
| `error` | Something went wrong while trying to process this order, for example the supplier had no stock for one of the items, or a step failed unexpectedly. | Read the reason shown next to the order to understand what happened. The console does not currently offer a button to send this order back into the queue by itself; ask whoever maintains PawScout to move it back to `queued` if it should be retried. |

Pressing Release or Cancel in the console only changes PawScout's own record
of the order. Cancel does not cancel or refund the order in Shopify, and
Release does not un-cancel one. To actually cancel or refund an order, do it
in the Shopify admin, as you always have; PawScout will then react to that
through the gate and the webhooks described below. Today the console shows
Release and Cancel buttons only next to a `held` order, and a Cancel button
next to a `queued` one; an `error` order has no button in the console (see
above).

**Once PawScout itself has paid a supplier order, that order stops being
re-read against Shopify for a cancellation or a refund.** PawScout re-checks
`awaiting-payment`, `held` and `error` orders that carry a supplier order
against Shopify every 15 minutes (see "How PawScout catches a cancellation
once a supplier order exists" below). An order you paid by hand is still
`awaiting-payment` as far as PawScout knows, so it stays in that check until
its tracking number arrives. A `submitted` order (paid by PawScout) is not
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
(which supplier order is waiting to be paid) and next to an `error` order
(what failed; this text can include the supplier's own message).

| Reason | What it means | What to do |
|---|---|---|
| `unmapped-items` | One or more products in the order are not linked to a supplier product. | Link the product to a supplier product, or handle the order by hand, then Release. |
| `incomplete-address` | The shipping address is missing something PawScout needs to ship it (name, first address line, city, postcode, or country). | Complete the address on the order in Shopify, then Release. PawScout reads the address from Shopify again when it checks the order, so a completed address will be picked up. |
| `high-risk` | Shopify's own fraud check flagged this order. | Look at the order in the Shopify admin and decide whether to proceed, then Release or Cancel. |
| `medium-risk-value` | Shopify's fraud check flagged this order as worth a second look, and its total is over GBP 40. | Same as `high-risk`, but only for orders large enough that a second look is worth it; smaller orders with the same flag are not held. |
| `over-threshold` | The order's total is over GBP 100. | Review it before releasing. This is a size check, not necessarily a problem. |
| `not-paid` | Shopify does not show this order as paid. | Check the order's payment status in Shopify before releasing. |
| `on-hold` | The merchant (you) paused this order in Shopify itself. | Check the order in the Shopify admin; release it here once you have decided in Shopify. |
| `refunded` | Shopify shows this order refunded (fully, partly, or voided). A supplier order may already exist for it: the check that runs before spending, and the 15 minute re-check, both write this reason on orders that already have one. | Decide whether to Release it anyway or Cancel it, and check whether a supplier order exists for it: the console shows its id next to any order that has one, the alert you received names it, and so does the order's timeline. See "A refund without a cancellation" below. |
| `already-fulfilled` | Shopify shows this order already fulfilled some other way, for example shipped by hand. | Check before releasing, so the supplier is not asked to ship a duplicate. |
| `order-missing` | PawScout could not find this order in Shopify when it last checked. | Check the order directly in Shopify. |
| `mixed-origin` | The products in this order would need to ship from more than one supplier warehouse. PawScout does not split orders across warehouses. | Decide by hand: order it from the supplier yourself, split it into separate Shopify orders, or contact the customer. |
| `address-changed-after-supplier-order` | The delivery address changed in Shopify after the supplier order was already created there, so the supplier order still carries the OLD address. PawScout has already saved the new address on this order and told you by email, but has not paid the supplier order and will not until you act. | Correct the address on the supplier order at the supplier (or, if the supplier cannot change it, cancel it there and handle the order by hand), then press Release. Releasing this order is your statement that the supplier order now carries the correct address; PawScout does not check that for you. |
| `shopify-cancelled` | The order was cancelled in Shopify. The order's status is `cancelled`; this reason just records why. | Nothing extra beyond what the status and any alert already tell you. |

## A refund without a cancellation

A refund and a cancellation are not the same thing to PawScout, on purpose. A
partial refund can be a goodwill gesture on an order you still want to ship.

- If no supplier order exists yet, a refund holds the order with reason
  `refunded` (see the table above), so you decide.
- If a supplier order already exists, the order's status does not change.
  Instead you get an alert naming the refund amount and the supplier order,
  so you can decide whether the supplier order should still go ahead.

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
- Two findings are deliberately passed over here: Shopify showing the order
  already fulfilled some other way, and PawScout not being able to find the
  order in Shopify at all. Neither stops the order and neither raises an
  alert, because neither says that the money came back. An order fulfilled
  by hand elsewhere, or one removed from Shopify, will therefore keep
  sitting in `awaiting-payment` with nothing said about it. Check any order
  you are about to pay in the Shopify admin first.

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
reached you.

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
The order was cancelled in Shopify while PawScout was creating its supplier
order, or while an automatic payment for it was failing for lack of balance
at the supplier. Do not pay that supplier order; cancel it at the supplier.

**"Order `<name>` was cancelled while its supplier order was being paid"**
The order was cancelled in Shopify at the exact moment PawScout was paying
its supplier order, and the payment had already gone through by the time the
cancellation was noticed. Ask the supplier to cancel it if it has not
shipped; if it has shipped, treat it as a return.

**"Order `<name>`: payment to the supplier was stopped"**
Something about the order changed in Shopify (the exact reason is named in
the email, for example a cancellation, a refund, or the order being paused)
after its supplier order was created but before PawScout paid it, so
PawScout did not pay it. Cancel the named supplier order yourself, at the
supplier.

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
  `awaiting-payment`, waiting for you to pay it by hand), there is nothing
  to release: correct the address on the supplier order at the supplier
  before you pay it, or, if you have already paid it, ask the supplier to
  update the address before it ships.

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
that number into Shopify has failed four times in a row. The customer has
not been told. Tell the customer the tracking number yourself while the
cause is found; PawScout keeps retrying every 15 minutes.

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
The supplier order was created and is waiting for you to pay it. This is the
same information the `awaiting-payment` status and the console's own banner
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

Check all four of these, in order, before placing any real order:

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
4. A product has been chosen for the three runs below: one with a single
   variant, a low price, in stock at the supplier, and already linked to a
   supplier product.

### The three runs

Each run is a real order, placed by you on the live shop with a real card.

**Run 1, happy path.** Buy the item. When the "awaiting payment" email
arrives, pay that supplier order by hand.
What should happen: the order's timeline shows every expected step, ending
with a written tracking number; the Shopify order shows fulfilled with a
working tracking link; you, as the customer, receive Shopify's own shipping
email.
This run has failed if: any of those steps is missing from the timeline, the
shipping email never arrives, the tracking write-back keeps failing, or the
tracking link does not open.

**Run 2, cancel during the grace window.** Buy the item, then cancel and
refund it in the Shopify admin within the hour.
What should happen: the order becomes `cancelled`, and once the hour has
passed, no supplier order exists for it.
This run has failed if: a supplier order exists for it.

**Run 3, cancel after the supplier order exists.** Buy the item, wait for
the "awaiting payment" email, then cancel and refund it in the Shopify
admin.
What should happen: you receive the "do NOT pay the supplier" alert, and the
order becomes `cancelled`. You then cancel the unpaid supplier order
yourself, at the supplier.
This run has failed if: no alert arrives, or the order is still shown as
`awaiting-payment`.

### What it costs, and what to do if something looks wrong

One real product, bought and shipped (run 1), plus the card processing fees
on the two orders you deliberately cancel and refund (runs 2 and 3). If
anything in a run looks wrong, switch fulfilment mode back to Manual
straight away using the off switch above, and find the cause before trying
the next run.

Every run's evidence, the order's timeline, the Shopify order's own
timeline, the supplier order id, and the emails you received, gets written
into `docs/decisions/0002-money-loop.md`.
