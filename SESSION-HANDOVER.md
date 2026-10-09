# Session handover: after Delete at CJ (2026-10-09)

Written 2026-10-09 11:30Z at the owner's request before a PC restart. It
replaces the 2026-10-08 08:30Z handover. Facts marked "verified" were checked
first-hand at 11:24Z to 11:26Z; re-check anything before repeating it to the
owner (a note is a lead, not a fact).

## 0. How to resume when the owner types "continue"

1. Read this file to the end.
2. Re-run the checks in section 8 and compare with section 1.
3. Report the state to the owner in a few lines, say what changed if
   anything did, and offer the next item from section 5.
4. Do not deploy to production, press any button that acts at CJ, or change
   fulfilment settings without a fresh, explicit go from the owner.

Nothing is mid-flight. There is no unanswered owner question; section 5 item
1 is an open offer.

## 1. State (verified 11:24Z to 11:26Z)

- **Production = `785ed15e8bd5`** (`curl
  https://pawscout.activepaw.co.uk/healthz` at 11:24:50Z). master =
  origin/master = `785ed15` before this file's own docs commit; CI on
  `785ed15` success. A docs-only commit for this file follows it, so a
  production deploy now would change nothing at runtime.
- Working tree: clean apart from three owner files that must be left alone:
  `GRAPHITE-HANDOVER.md`, `cart-summary.png`, `how-we-bundle.png`. No
  unmerged branches, no extra worktrees. `stash@{0}` from 2026-07-11 is not
  from this work; leave it.
- **Live fulfilment config (D1 read 11:25Z): `mode = pawscout`,
  `createOnly = 1`.** PawScout creates the supplier order at CJ for an order
  that passes its checks and leaves it unpaid; the owner pays at CJ and
  presses **I paid this**. PawScout never pays in create-only.
- Orders in PawScout: 3, all `cancelled`, none marked paid: #1001
  (`8016041476434`, June test), #1002 (`8505727222098`), #1003
  (`8506621854034`, `SD2610081831150667400`).
- **At CJ every order reads `TRASH`** (read 09:35:59Z through
  `/api/cj-order-diag`): the two June orders and both test orders. **The
  never-pay list is empty.** #1003 was `SD2610081831150667400` / numeric
  `2610081831170660600`; #1002 was `SD2610081301230654600` / numeric
  `2610081301260650000`.
- Security ledger: 22 open, the same ids as before (section 4).

## 2. What happened since the last handover (2026-10-08 08:30Z)

T1, T2, T6 and T7 were already done. This stretch was T5, the first real
PawScout create-only order, and the work it surfaced.

Production deploys, each on the owner's explicit go through the guarded
script (staging first, no migrations, smoke 3 of 3). The last two were
verified first-hand this session; the earlier rows come from the backlog
memory and git log.

| Production | Deployed (UTC) | What |
|---|---|---|
| `1d4a6952a439` | 10-08 11:44 | Deployed for the T5 run; fulfilment was switched to `pawscout`, create-only, at 11:45Z |
| `729e17e5a25f` | 10-08 16:00 | Create-only really creates only (it had tried to pay) |
| `1cddfef09535` | 10-09 00:34 | Take over an order CJ holds after a failed create; retry error rows |
| `fc33103834e0` | 10-09 01:39 | Record a found order under its `SD` id |
| `d832897b30c3` | 10-09 09:31 | **Delete at CJ** button on cancelled orders |
| `785ed15e8bd5` | 10-09 10:25 | Delete at CJ counts only a confirmed delete |

After `d832897` went live the owner's earlier "proceed" covered pressing
Delete at CJ on both test orders: #1003 at 09:34Z (`CREATED` -> `TRASH`),
then #1002 at 09:35Z (`IN_CART` -> `TRASH`). Both were checked
independently through the diag route and the D1 trail before the never-pay
list was cleared. The full record is in `docs/decisions/0002-money-loop.md`,
sections dated 2026-10-09.

## 3. Delete at CJ: what is known

- CJ's Order Delete: `DELETE /shopping/order/deleteOrder?orderId=<numeric
  id>`. It takes only `CREATED` or `IN_CART`. An `UNPAID` or later order
  cannot be deleted through the API; it is cancelled in CJ's dashboard.
  Settled on first use: it takes the numeric id, sent through the relay as a
  `DELETE`.
- A deleted order does not vanish: CJ still lists it and answers it under
  the order number, the `SD` id and the numeric id, as `TRASH`.
- The button (`src/order-supplier-delete.ts`, route action `cj-delete` on
  `/api/order-action`) shows next to a `cancelled` order not marked paid.
  It looks the order up by the order number PawScout gave CJ (the long
  Shopify order id), refuses anything not `CREATED`/`IN_CART`, paid, or under
  another number, and takes a second click within 8s. Since `785ed15` it
  records `supplier-order-deleted` only when the read-back shows the same
  order number and `SD` id as `TRASH` or `CANCELLED`; anything else records
  `supplier-delete-unconfirmed` and answers 502. That path cannot be shown
  in production (nothing at CJ is deletable now); the tests are its
  evidence. Do not create a test order to prove it.
- CJ's order detail names its ids its own way: `orderId` is numeric,
  `orderNum` is PawScout's order number, `cjOrderCode` is the `SD` id (the
  list calls it `cjOrderId`). The detail's own `cjOrderId` is something else
  and changes with status; never use it.

## 4. Security ledger: 22 open, all accounted for

Read it with `aramid ledger filter --status open`. None needs action.

- 10 semgrep `new Function()` entries in test files, suppressed by reviewed
  `.aramid-suppressions.toml` entries.
- 9 LLM-review findings fixed in live code (114e2e7b, b4b33fbf, 53d7292e,
  2f32d185, 0029992d, 901d2392, 9cb8eddc, 82d77aaa, ab7ce5d8) and 3 killed
  mutants (e90e99d3, 17f1323, 9d40cb6e). Measured 2026-10-08: they will not
  drain by waiting. The LLM resolver clears a finding only when its exact
  evidence text leaves the file, and the mutation consumer samples only one
  or two mutants per run. The owner chose "verify each fix"; all 12 were
  verified real. Never edit a line just to remove its evidence.

## 5. Open items, in order

1. **Offer, not yet answered:** hide the Delete at CJ button on a row whose
   supplier order CJ already shows as `TRASH` (cosmetic; pressing it now
   just says CJ already shows the order as `TRASH`, and nothing is sent).
   It needs a production deploy, so it needs the owner's go.
2. **Unproven until a real order flows** (create-only is live, so the next
   real order exercises them; watch, do not force):
   - the tracking number filling in when CJ ships (`trackNumber`,
     `trackingUrl`, `logisticName` are the field names the live detail
     carries, still empty);
   - the awaiting-payment email as the owner receives it;
   - the automatic payment call (`payBalance` by order id, where CJ's notice
     points pay-type 3 orders at `payBalanceV2`). Automatic payment is off,
     and no CJ pay endpoint is ever called as a test.
3. **T3, whenever:** re-check upstream with
   `npm view @cloudflare/vitest-pool-workers version dependencies.miniflare`,
   `npm view wrangler version dependencies.miniflare`, then
   `npm view miniflare@<each> dependencies.sharp dependencies.undici`.
   Remove an `overrides` entry only when both miniflares declare
   sharp >= 0.35.5 and undici >= 7.29.1, then confirm `npm audit` shows 0
   high. Last checked 2026-10-08 09:40Z: unchanged.

## 6. Gotchas

- **The auto-mode permission classifier denied a production deploy** when
  the go was the single word "proceed". An explicit "deploy <sha> to
  production" from the owner then went through. Never retry a denied call
  or route around it; ask the owner for an explicit sentence.
- **The strict graphite hook denies a cross-file grep whose pattern holds a
  known symbol** (seen: `FAIL`, `order`, `attempt`, `email`, `open`, `api`,
  `text`). Use `python -P -m graphite query "callers X"` or `search`, or
  grep ONE file per command. The graph does not index TypeScript type
  aliases (`OrderEventKind` has no node); say so when you fall back.
- **Cloudflare D1 flaps with code 7403**, including in the guarded
  deploy's state gathering, before anything is deployed. Simply re-run.
- **Post-deploy `/healthz` lags about 15s**; the smoke retries and catches
  up, and so should a hand check.
- **`wrangler d1 execute --json` prints banner text before the JSON**: parse
  from the first `[`. The fulfil settings live in `tenant_config.fulfil`
  (JSON), not a `config` table.
- **Session-authed routes:** Playwright on
  `https://admin.shopify.com/store/fb-store-10015/apps/pawscout-1/app`, find
  the frame whose URL starts with `https://pawscout.activepaw.co.uk/`, take
  `window.shopify.idToken()`, fetch with `Authorization: Bearer`. The
  Orders list is in the Ops view: set `location.hash = '#/ops'` in the frame,
  then click `#ordbtn` (Refresh).
- **Console JS lives in template literals** (`src/console/page.ts`,
  `src/console/*-js.ts`): tsc cannot see errors inside, and apostrophes or
  backslashes in its JS strings break it. Run `tests/console.test.ts` and
  `npm run lint` after any edit.
- **`git rev-parse --short A B`** fails ("Needed a single revision"); use
  plain `git rev-parse A B`. `grep -P` is unavailable in this shell.
- **The pre-push hook runs the gate and takes minutes**; run the push in the
  background and wait for it.
- **Deploy timing:** a pending migration makes the guarded deploy export the
  production DB; keep clear of minutes 0/15/30/45 and 04:17 UTC.

## 7. Standing rules (short)

Production deploy only on the owner's explicit go, only via
`npm run deploy -- --env production`; a request to build something is not a
deploy go unless the offer it answers said it included the deploy. Staging
needs no go. Never `--no-verify`. Auto-push after commits. aramid and
graphite are tools: use their commands, never talk to their agents; the
agent channel carries only bug reports and improvements. Never use the
demo-store2 Python scripts app or the claude.ai Shopify connector for Admin
API work. Never call a CJ pay endpoint as a test. Do not release or recreate
#1002 or #1003. No em or en dashes in code, docs or customer text. Stay
inside this repository. Do it yourself rather than asking the owner to.
Leave the three owner files above alone.

## 8. Quick state checks

```
curl -s https://pawscout.activepaw.co.uk/healthz
git -C F:/Projects/Shopify/demo-store2/pawscout-worker status --short --branch
git -C F:/Projects/Shopify/demo-store2/pawscout-worker log --oneline -3
gh run list --branch master --limit 1
aramid ledger filter --status open
npx wrangler d1 execute pawscout --remote --json --command "SELECT json_extract(fulfil,'$.mode') mode, json_extract(fulfil,'$.createOnly') createOnly FROM tenant_config WHERE shop='4qkudm-ez.myshopify.com'; SELECT order_name, status, cj_order_id, owner_paid_at FROM orders"
npm run deploy -- --env production --dry-run
```

CJ's view of the orders (read only): `POST /api/cj-order-diag` with `{}` for
the list, or `{"orderId": "<order number or SD id>"}` for one order, through
the admin iframe as in section 6.

Durable memory: `pawscout-backlog.md`, top bullets of the RESUME block, was
updated through 2026-10-09 11:30Z.
