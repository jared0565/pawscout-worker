# Inquiry sourcing: sell what a customer asks for, even when it is not stocked locally

Status: BUILT and live (2026-09-30, merge daf71b4, production 12:10Z). APPROVED by the owner
2026-09-30 ("Approve, owner imports"; storefront "Show overseas too", added as part D). Part D
stays dormant until the theme sends overseas=1 (channel round 288).

## Why

Aloha (inbox, 2026-09-29) asked "do you sell trackable dog collar incase my dog gets missing?".
The draft said we could not find one and sent her to the website search. The owner searched
our tools, found nothing, and found the product by hand at the supplier: P03 Smart GPS Wireless
Pet Tracker (SKU CJPC262132401AZ), a dog collar with a GPS unit, stocked in China only.
Importing it was refused: `no-local-stock`, "local qty 0 < floor 10 for lane GB (stock by
country: CN:5429)".

Owner rule, 2026-09-30: "local-for-local rule apply if the item is stocked locally, but if item
is available somewhere, we must get the actual information from CJ and inform the inquirer about
it. The goal is to always make the sale. Just make the customer aware about the situation."

## What already works (measured in code, 2026-09-30)

- Every market is still `transitional` (`LOCAL_ONLY_MARKETS` is empty in `src/local-markets.ts`).
  A transitional market's catalog already includes China-hub products whenever the hub can
  deliver to it (`computeMarketExclusions`), and `sellableToBuyer` already says they are sellable.
  So once a China-stocked product is imported, checkout, market catalogs and delivery profiles
  handle it. Nothing in the market or checkout side changes.
- `confirmAndImport` takes `opts.localWarehouses`; its local-stock gate checks stock in exactly
  those warehouses. Nightly discovery, replenishment and ghost-click imports pass nothing and so
  stay local-only.
- `CjClient.freightEstimate(vid, from, to)` returns the supplier's own quote (price, days,
  carrier), and `originsByPid` returns stock by warehouse country.
- The nightly jobs that re-check products already in the catalog keep a China-only product in
  stock: `syncStoreInventory` takes stock summed across every warehouse (`stockByPid`), not the
  local lane, and `cullStaleProducts` has no lane check. The local-lane checks in `jobs.ts`
  (lines 392 and 972) are admission gates for NEW products only.

## The three parts

### A. Import for an inquiry (owner-triggered)

New console action `POST /api/inbox/source-import { pid, threadId }`, owner only.

- Destination: the thread's derived country (`deriveDestinationCountry`), GB when unknown.
- Warehouses passed to `confirmAndImport`: the destination's local lane, plus `CN` when that lane
  is transitional and the China hub can deliver there (the same route truth the market catalogs
  use). Every other gate is unchanged: curation, pet floor, image vetting, stock floor,
  profitability and the competition check.
- Returns the new product's handle and our price, or the gate's refusal reason.
- The nightly jobs and the storefront ghost-click import are untouched.

### B. The inbox catalog search also finds supplier items

`/api/inbox/catalog` keeps searching our catalog first. Below our results it shows supplier
results:

- A query that looks like a supplier SKU (`CJ` plus letters and digits) is looked up directly.
  The CJ client has no SKU lookup yet; the endpoint is confirmed with one live call before it
  is built.
- Otherwise the supplier's relevance search (listV2, every warehouse), filtered by the new
  storefront matcher (`titleAnswersQuery`, title mode) and the pet floor; top 5.
- For each: title, image, our price (the pricing rule, freight included), where it is stocked,
  whether that is local for this customer, the supplier's delivery estimate to the customer, and
  an Import button (part A).

### C. The drafter on a catalog miss

- The thread reader gains one field, `productQuery`: the product the customer asks about as a
  short search phrase ("gps dog collar"). The product agent searches our catalog with it instead
  of the raw first 80 characters of the message.
- Still no catalog match: the agent runs the supplier lookup from part B for the customer's
  country and grounds the draft on the best match: what it is (from the supplier's description
  only), our price, and the supplier's delivery estimate. The draft must say plainly that the item
  is not held locally and ships from overseas, with that estimate. It never names the origin
  country, the supplier or the SKU, and never implies UK dispatch.
- The figures come from the same functions the import and the product page use: the price from
  the import's pricing rule, the delivery time from the nearest-route formula plus processing
  days that writes `supplier.delivery_days`. No second formula.
- The customer's country comes from the thread. If it is unknown, the draft gives the UK
  figures only if the thread points to the UK, and otherwise asks the customer where they are.
  (The import itself may default to the GB lane.)
- Such a draft is held with the reason `sourcing_offer`, so the owner imports the item (part A)
  before sending and can add the link. If the import is refused or reprices the item, the draft
  is regenerated from the imported product before it is sent.
- No supplier match either: the draft says plainly that we do not stock one right now and that
  the team will look into it. It never sends the customer to the website search.

### D. Storefront search shows overseas items too (owner choice, 2026-09-30)

- `/proxy/search` keeps local results first. When they fill fewer than `limit` cards, it adds
  China-hub results for a transitional buyer lane the hub can deliver to (same CJ search, same
  relevance and pet gates, cached under the existing `kw3:CN:<kw>` key).
- Every ghost card gains a `delivery` field: `{ overseas: boolean, days: string | null }`,
  `days` from the same nearest-route formula the product page uses. An overseas item with no
  known route is not shown.
- The ghost-click import (`/proxy/product`) takes the buyer's `country` and passes the same
  warehouse set as part A, so a clicked overseas card can import.
- Disclosure is not optional, and the worker cannot render it: the theme draws the cards.
  Overseas cards are returned ONLY when the request carries `overseas=1`, which the theme sends
  once it shows "Ships from overseas, about N days" on the card and the preview. Until then the
  worker change is invisible. The theme change is recommended to the theme's agent over the
  channel; that agent decides and builds it.

## Rules this keeps

Local stock is still preferred everywhere it exists. No UK fulfilment claim and no origin country.
Only grounded figures. No supplier brand, name or SKU in customer text. Drafts stay held for the
owner. Nightly sourcing stays local-only.

## Cost

A catalog miss adds one supplier search plus, for up to 3 candidates, an origins read and a
freight quote (the supplier allows about one request a second). The console search does the same
for up to 5 results, only when the owner searches.

## Owner decisions (2026-09-30)

1. Part C holds the draft for the owner to import. No product is added to the catalog from an
   inbound email alone.
2. Storefront search shows overseas items too, with the delivery note (part D).
