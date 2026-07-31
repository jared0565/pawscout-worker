# Profitability agent repositioning + product-referrer index

**Date:** 2026-07-31
**Status:** Design approved by owner. Not yet planned, not yet implemented.

## Problem

The profitability agent archives products it has already admitted to the catalog.
Every archive leaves a permanent 404, and those 404s are now polluting the Google
Merchant Centre feed. The codebase already recorded the symptom without fixing the
cause: `src/blog/article-health.ts:3-5` says *"the agent archives products
continuously, so generation-time grounding rots"*, and the response at the time was a
nightly repair pass rather than removing the archiving.

The owner's position: the agent belongs at the **entry** to the catalog, not inside
it. Once a product is in inventory the agent must not take it down. The only
legitimate takedown is a product with no movement at all, and even that must not
break a blog post that points at the product.

## Evidence

All measured first-hand on 2026-07-31 against production D1 and the live storefront.
These numbers are the basis for the design; do not re-derive them.

| Measure | Value |
|---|---|
| `product_links` live (`imported`) | 48 |
| `product_links` archived | 112 (every row has a handle) |
| `product_links` draft / failed | 19 / 268 |
| `profit_actions` `drop` | 126, first 2026-07-09, **last 2026-07-19T22:01Z** |
| `profit_actions` `reprice` | 138, last 2026-07-28T08:00Z |
| Archived URLs sampled live | 2/2 returned **404**, no redirect |
| `product_events` in last 30 days | 136 |
| Cull standdown threshold | `CULL_MIN_WINDOW_EVENTS = 100` (`jobs.ts:68`) |
| Live products with >=1 event in 30d | 46 of 48 |

Two conclusions follow, and they point at different fixes:

1. **The agent has not dropped in 12 days but is still repricing.** The archive path is
   armed, not disabled. Drops most likely stopped because the 2026-07-19 CN-seller fix
   improved reference prices (economics), not because any code path was turned off.
   Repositioning the agent is therefore **preventive** - it stops the next wave.
2. **The 404s Google reports today come from the 112 already-archived URLs.** Only a
   redirect backfill addresses those. Repositioning alone would leave them 404ing
   indefinitely.

The cull is currently **armed** (136 > 100) but not dangerous: 46 of 48 live products
have an event in the window, so only ~2 are candidates. Its own comment records the
failure mode it was built to prevent - *"48 products culled in a week on ~2 events/day
store-wide"* (`jobs.ts:66`).

## What already exists

Do not rebuild these.

- **Import-time profitability gate: already present.** `src/proxy/import.ts:283`,
  described in-file as "the entry gate", dormant unless `cfg.profit.enabled`.
- **30-day no-movement cull: already present**, with a restore path
  (`jobs.ts:108-166`, `index.ts:808`).
- **`syndication_ledger`: already present** in D1 - what was posted and where.
- **Guard-test pattern: already present.** `tests/guard.test.ts` enforces "no raw D1
  access" with a positive control so it cannot be silently neutered.

Missing: any profitability gate in `src/proxy/search.ts` (it gates pet-relevance,
price, popularity and warehouse only), and any product-to-referrer index.

### Three archive paths

This is the load-bearing structural fact. Three independent code paths archive
products today, and two were written by copying the third - `profit-console.ts:219`
literally says *"mirroring the cull path"*:

| Path | Location | Used by |
|---|---|---|
| `archiveProduct` | `src/proxy/inventory.ts:108` | profit agent only (graph: `callers archiveProduct` = count 1, `decision_grade`) |
| inline `ARCHIVE` | `src/jobs.ts:130` | the no-movement cull |
| inline `SET_PRODUCT_STATUS` | `src/profit-console.ts:228` | owner's manual console archive |

`archiveProduct` sets `status: ARCHIVED` and creates **no** `urlRedirect`. That is the
mechanical cause of every 404.

## Owner decisions

Captured 2026-07-31. Seven decisions, all explicit.

1. **The agent keeps reprice, loses archive entirely.** Only archiving mints 404s.
   Freezing reprice too would let a product whose CJ cost rises sit live at a loss with
   nothing catching it.
2. **Every archive creates a Shopify URL redirect** to the best congruent live product,
   falling back to its collection.
3. **Backfill all 112 existing archived URLs**, not forward-only. The owner initially
   chose forward-only and switched once the "drop wave already ended, 112 are 404ing
   now" evidence was presented.
4. **Index scope is product -> any internal referrer** (blog articles, curated
   Shop-this-guide blocks, syndicated social posts), not blog-only. Off-platform social
   links can never be repaired after the fact, which is why they are in scope.
5. **The cull's movement rule is unchanged.** Zero view/atc/order events in 30 days
   already matches "no movement at all", and is conservative in practice. Only the gate
   and redirect are added in front of it.
6. **The search gate uses a cheap deterministic margin check** at read time - no LLM, no
   eBay, no network calls - because it runs on a live shopper request. The full
   judgment still runs at import if the shopper clicks.
7. **No congruent replacement means refuse the archive.** Content integrity wins over
   catalog tidiness; the product stays live and is surfaced in the console.

### Ruled out

**Graphite cannot serve as the referrer index.** It indexes *source code* - functions,
imports, call edges. Which article mentions which product is *runtime content* living
in Shopify articles and D1 rows. The graph has no visibility into it. The owner raised
this as an option; it was ruled out on this basis.

## Architecture

```
ADMISSION (gates decide)          LIVE (may reprice, never archive)     TAKEDOWN (one door)
─────────────────────────         ─────────────────────────────────     ───────────────────
import.ts entry gate ──┐                                                 cull (zero events/30d)
                       ├──► catalog ──► reprice ──► 'drop' ──► FLAG      console manual archive
search.ts ghost gate ──┘                            (never archives)            │
                                                                                ▼
                                                                archiveProductGuarded()
                                                                1. referrers? → replace in article
                                                                2. no congruent replacement → REFUSE
                                                                3. create URL redirect
                                                                4. archive
```

**Chosen approach: a single guarded chokepoint.** One function becomes the only way a
product can be archived; all three existing paths are rewritten to call it and their
raw mutations are deleted. A guard test fails if any `status: 'ARCHIVED'` mutation
appears outside it.

This was chosen over gating each of the three call sites, and over post-hoc nightly
reconciliation. Per-call-site gating repeats the exact duplication that produced three
paths in the first place. Post-hoc reconciliation accepts a window of live 404s and
wrong article links, which is what `article-health` already does and what proved
insufficient.

Its decisive advantage: "the agent has no reachable archive path" becomes a **provable**
property rather than a convention.

## Components

### New

- **`src/catalog/archive-guard.ts`** - `archiveProductGuarded(admin, store, pid, reason)`.
  The only archive door.
- **`src/catalog/referrers.ts`** - index build and `referrersFor(handle)`.
- **`migrations/0035_product_referrers.sql`** - the index table.
- **Redirect backfill** - one-off over the 112 existing archived handles.

### Changed

- **`src/profitability.ts`** - in `judgeImportedLink`, a `drop` verdict on a **live**
  product becomes a **flag** for owner review instead of an archive. The signal is
  preserved; the action is removed. `decideProfitAction` itself is untouched, because
  the entry gate still needs `drop` to mean "refuse admission".
- **`src/jobs.ts`**, **`src/profit-console.ts`**, **`src/proxy/inventory.ts`** - raw
  archive mutations deleted, all routed through the guard.
- **`src/proxy/search.ts`** - cheap `netAfterAdsGbp` margin check applied to ghost
  cards. Ghost cards are supplier products *not* in the catalog, so this gate
  structurally cannot touch inventory products; live catalog results in search come
  from Shopify itself.
- **`src/types.ts`** and tenant config - **the flag split** (below).

### The flag split

`cfg.profit.enabled` currently gates *both* the import entry gate (`import.ts:283`) and
the live sweep (`runProfitAgent` early-returns on the same flag,
`profitability.ts:578`). Keeping the entry gate while removing archive authority
therefore requires splitting it, not flipping it:

- `profit.enabled` - gates the **entry gates** (import + search)
- `profit.repriceEnabled` - gates the **live reprice sweep**

Both default to true, so behaviour is preserved minus archiving.

## Data flow: the referrer index

`product_referrers (handle, referrer_type, referrer_id, detected_at)`, a **derived
cache**, never a hand-maintained source of truth:

- **blog** - parsed from article bodies plus the `related_products` metafield; rebuilt
  on publish, on regenerate, and nightly
- **syndication** - joined from the existing `syndication_ledger`; no scraper needed
- **collection** - curated Shop-this-guide picks

**An index miss means "unknown" and blocks the archive.** It must never mean "safe to
archive". This single rule is what prevents the cache from becoming the next thing that
silently rots - the same failure `article-health` exists to repair.

### Redirect target selection

Deterministic, no LLM, so the 112-URL backfill is cheap and verifiable:

1. the congruent live replacement chosen for the article, when one exists
2. otherwise the live product in the same collection with the most `product_events`
   in the last 30 days, ties broken by most recent `created_at` on `product_links`
3. otherwise the collection page
4. otherwise `/collections/all` - never a 404

"Same collection" means the `category` recorded on the archived product's
`product_links` row, which is the value the import pipeline already assigns.

## Error handling

| Case | Behaviour |
|---|---|
| No congruent replacement | **Refuse the archive.** Product stays live, surfaced in console |
| Index miss, or index build failed | Treat as referenced -> refuse. Fail safe, never fail open |
| Redirect creation fails | **Abort before archiving.** Never archive without a redirect in place |
| Article edit succeeds, archive then fails | Article is already honest; retry archive next run. Ordering is deliberate |
| Restore / un-archive | **Delete the redirect first.** Otherwise the restored product's own URL redirects away from itself and it is unreachable while live |

The restore row is the subtle one: the existing `restoreCulled` path
(`jobs.ts:143-166`, `index.ts:808`) would break silently without it.

## Testing

All TDD. These are the load-bearing tests:

- Archive attempt on a blog-referenced product is **refused**
- Referenced product is replaced in-article **before** archive is permitted
- No congruent replacement -> refuse, product still live
- **Guard test**: no `status: 'ARCHIVED'` mutation anywhere outside `archive-guard.ts`,
  with a positive control so it cannot be neutered - mirroring `tests/guard.test.ts`.
  The pattern must match an actual GraphQL status write, **not** the bare token
  `ARCHIVED`: comments, type unions and the `link.state === 'archived'` comparisons in
  `profit-console.ts` and `index.ts` are innocent and must not trip it. This repo has
  already lost time to exactly this failure - the original `guard.test.ts` matched
  `.exec(` broadly and flagged `RegExp.exec` as raw D1 access, and the fix was to
  narrow the test rather than "fix" the innocent source. Verify the offending lines
  before believing a guard-test failure.
- Search gate drops an unprofitable ghost card, keeps a profitable one, and makes
  **zero network calls**
- Index miss is treated as referenced
- Restore deletes the redirect before un-archiving
- Backfill: each of the 112 URLs resolves 200 or 301, never 404

## Rollout

Build and test locally -> adversarial review -> **explicit owner deploy-go** -> apply
migration `--remote` first, then `wrangler deploy` -> verify by re-crawling a sample of
the 112 and confirming the cull's next tick refuses a referenced product.

Nothing deploys without the owner's go.

## Known residual risks

- **The cull's standdown threshold is a single store-wide number.** At 136 events
  against a threshold of 100 the margin is thin, and the signal is sparse (~2.8
  events per product per month). The owner chose to leave the rule unchanged, which is
  defensible at current traffic, but it remains the sole automated takedown authority
  and is worth revisiting if traffic composition shifts.
- **Ghost-card gating uses a cheaper judgment than import.** A card can pass the fast
  read-time margin check and still be refused at import by the full judgment. This is
  intentional - the alternative is a slow search - but it means the two gates can
  disagree at the margin.
