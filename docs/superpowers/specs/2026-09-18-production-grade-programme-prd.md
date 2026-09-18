# Production-Grade Programme: PawScout + Active Paw (PRD)

Status: DRAFT for owner review. Phase 1 was approved to build (owner, 2026-09-18:
"proceed as per your recommendation") and is COMPLETE: all five exit criteria met
on 2026-09-18 (section 5.7). Every later phase gets its own spec and plan before
any code.

## 1. Owner direction

Two messages, 2026-09-18. The second refines the first.

1. "I will defer the jewellery shop here. I will start a new project that is a
   true multi-tenant. We will just develop ActivePaw+PawScout into a fully
   production-grade e-commerce system first. It will serve as the model for the
   next project."
2. "The goal is to make both PawScout and ActivePaw production-grade. And
   ActivePaw must work even without PawScout, and PawScout must work as an
   independent application where other shopify stores can subscribe to without
   data bleeding among the stores where it will be installed."

Process ordered by the owner: PRD, then task list, then implementation by
multiple agents. The theme repository runs the same process under its own agent.

### 1.1 How this document reads those two messages (owner: correct this if wrong)

| Deferred to the separate new project | In scope here, as part of "production-grade" |
|---|---|
| A different vertical (jewellery) | Tenant isolation: no store can read or write another store's data |
| A supplier other than CJ | Independence, both ways: theme without worker, worker without this theme |
| A from-zero multi-tenant architecture | Subscription readiness: other stores can install, pay, and leave cleanly |

PawScout stays a pet-care, CJ-sourced app in this repository. What changes is
that it stops assuming there is exactly one store and that the store is Active Paw.

## 2. What "production-grade" means here

Six properties. Each one is testable, and each phase below exists to make one
of them true.

| # | Property | The test |
|---|---|---|
| P-A | Safe to change | A bad commit, migration or deploy is stopped before the live shop, or undone in minutes, and anyone can tell which commit is live |
| P-B | Proven money loop | A real paid order reaches the supplier, ships, and the customer gets tracking, with the unhappy paths (cancel, refund, out of stock, bad address) handled |
| P-C | Cannot fail silently | Every background stage records its outcome; a stage that fails or stops running reaches the owner without anyone opening a console |
| P-D | Isolated and independent | A two-store test proves no cross-store read or write on every path; the theme renders fully with the worker absent; the worker assumes nothing about one theme or one domain |
| P-E | Complete as a shop | Refunds and returns, checkout shipping that matches the quote, order status for the customer |
| P-F | Worth copying | Modules have one purpose and a stated interface; decisions are written down with their reasons |

## 3. Current state, measured first-hand 2026-09-18

Already in place:

- 155 source files (36.6k lines), 165 test files. A local gate (aramid) runs
  the full suite, the type check, the linter and secret scanning on every
  commit and push.
- Every Shopify webhook validates its HMAC through the Shopify library
  (`shopify.webhooks.validate`, `src/index.ts`). The three mandatory privacy
  webhooks perform real erasure. Uninstall is handled.
- All 42 database tables carry a `shop` column. In 5 of them (`demand_snapshots`,
  `llm_usage`, `product_events`, `profit_actions`, `search_log`) it sits outside
  the primary key.
- `docs/STATES.md` and the console register map every switch; a test pins them
  together. Workers logs are on. Both crons ran today.

Gaps:

| Gap | Evidence |
|---|---|
| The money loop has never run | `orders` holds one row, `cancelled`, 2026-06-14. Live `fulfil.mode = manual`, `createOnly = true`. No refunds webhook. `CarrierService` appears in one source file |
| Nothing stands between a commit and production | No `.github/workflows`. The gate lives only in this machine's gitignored hooks. No staging worker, one database: all 40 migrations went straight onto live data. `compatibility_date = 2024-11-01`. Deployments carry no commit annotation, so "which commit is live" is tracked by hand |
| Failures are logged, not surfaced | A job's state is a last-run timestamp in an expiring cache row. No per-stage outcome, duration or error. `alertOwner` is called from 3 files. Nothing fires when a cron stops |
| One store is assumed | 7 routes in `src/index.ts` take `shops[0]` (lines 1857, 1883, 1909, 1931, 2060, 2076, 2104). The app is served from `pawscout.activepaw.co.uk`. Store name, vertical, supplier and currency appear as literals across the source (count inherited from an earlier session, not re-measured) |
| Hard to copy | `tenant-store.ts` 3,458 lines, `index.ts` 2,139, `jobs.ts` 1,843; 46 files sit at the `src` root without a module |

## 4. Phases

The owner approved the order of phases 1, 2, 3, 5 and 6 (safety, the money
loop, visibility, commerce completeness, structure last). Phases 4 and 7 come
from the owner's second message; where they sit in the order is this
document's proposal.

| Phase | Makes true | Summary | Exit criterion |
|---|---|---|---|
| 1. Deploy safety | P-A | CI, staging, migration rehearsal, guarded deploy, health and version endpoint, runbook | See section 5.6 |
| 2. Prove the money loop | P-B | One real, supervised order end to end; then each unhappy path; the pipeline's run record is pulled forward from phase 3 | A delivered order with tracking written back to Shopify, plus a rehearsed cancel and refund, each with an evidence trail |
| 3. Operational visibility | P-C | Per-stage run ledger, quiet-cron alarm, one owner-alert path, a health view | Killing a stage in staging produces an owner alert with no human looking |
| 4. Isolation and independence | P-D | Shop resolved from the request everywhere; a two-store test suite over every store method, job and webhook; store-specific literals move into per-store configuration; the app gets its own domain; the theme contract in section 6 | The two-store suite is green and is part of the gate; a second development store installs and sees only its own data |
| 5. Commerce completeness | P-E | Refunds and returns, checkout rates that match the quote (CarrierService), customer order status. Shaped by what phase 2 finds | Each flow proven on staging, then once live |
| 6. Structure as a model | P-F | Split the three oversized files along the seams the earlier phases exposed; give root files a module | No file over an agreed size without a written reason; every module has a stated interface |
| 7. Subscription readiness | P-D | Billing, plan limits, install and uninstall lifecycle for stores that are not Active Paw, App Store review requirements | A store the owner does not operate installs, pays, uses, uninstalls, and its data is purged |

Rules that hold across all phases:

- Each phase runs brainstorm, then spec, then plan, then build. Nothing from a
  later phase is built early.
- Test first, with the failing test observed. The gate is never bypassed.
- Production deploys happen only on the owner's explicit go. Staging deploys do not need one.
- The worker is the only operational Shopify actor. No fix lives in a dev-time script.
- Every phase leaves a decision record in `docs/decisions/`, because the next
  project will read the reasons, not only the code.
- No em or en dashes in code, docs or customer text.

## 5. Phase 1: deploy safety (approved to build)

### 5.1 Goal

A bad commit, a bad migration or a bad deploy cannot silently hurt the live
shop, and anyone can tell which commit is live.

### 5.2 Components and decisions

| # | Component | Decision | Why |
|---|---|---|---|
| C1 | CI | GitHub Actions on every push and pull request: `npm ci`, typecheck, lint, `npm run test:ci`, `npm run test:scripts`. Node 24, ubuntu. In-progress runs for the same ref are cancelled | The local gate lives in gitignored, machine-local hooks; a second clone has none. CI is the gate that cannot be absent. No path filters: the deploy guard needs a verdict for every commit |
| C2 | `/healthz` | Public, unauthenticated, `no-store`. Returns `{ ok, env, version, db }`: `version` is the git commit injected at deploy, `db` is the result of `SELECT 1`. No store data | Answers "which commit is live" from outside, and gives the smoke test a real signal. 503 when the database check fails |
| C3 | Staging | `[env.staging]`: worker `pawscout-worker-staging` on workers.dev, its own D1 `pawscout-staging`, crons off, its own random secrets, `ENVIRONMENT = "staging"` | A place where a deploy can fail harmlessly. Crons off so staging never spends on CJ or LLM calls. Own secrets so nothing forged against staging works on production |
| C4 | Migration rehearsal | `npm run migrate:rehearse`: export production, load it into a throwaway LOCAL database, apply pending migrations, run integrity and foreign-key checks, compare per-table row counts, delete the export | Data-dependent migration failures (a NOT NULL over existing nulls, a unique index over duplicates) only show against real data. Production data holds customer messages and addresses, so the copy never leaves this machine and never goes to staging |
| C5 | Smoke test | `npm run smoke -- <base-url> [--expect-version <sha>]`: `/healthz` ok with the expected version, `/public/event` 200 with a boolean `active`, `/app` responds | One command that says whether a deploy is alive, used by the deploy script and by hand |
| C6 | Guarded deploy | `npm run deploy -- --env staging|production`. Production refuses unless: tree clean, HEAD pushed, CI green for HEAD, rehearsal passed when migrations are pending. Then: apply migrations, deploy with the commit injected, smoke, and on a failed smoke print the exact rollback command and exit non-zero. `deploy:raw` remains as the escape hatch | Turns the deploy procedure from memory into a mechanism. The owner's go is still required; the script is how, not whether |
| C7 | Runbook and decision record | `docs/RUNBOOK-DEPLOY.md` (deploy, rollback, migration policy, staging, what to do on a red smoke) and `docs/decisions/0001-deploy-safety.md` | The next project copies the reasons |
| C8 | Compatibility date | Raise `compatibility_date` from 2024-11-01, last, on staging first, production on the owner's go | Two years of runtime changes should arrive deliberately, not by accident later |

Migration policy (goes in the runbook): forward-only. A schema change that old
code cannot tolerate is split: expand, deploy, migrate data, contract in a later
release. This is what makes a worker rollback safe after a migration has run.

### 5.3 Non-goals for phase 1

- Connecting staging to a Shopify development store and a staging app. That
  needs an owner decision (section 8) and is needed by phase 2, not phase 1.
- Upgrading wrangler 3 to 4.
- Any change to what the worker does for customers.

### 5.4 Risks

| Risk | Handling |
|---|---|
| Private repository: Actions minutes are a budget (about 7 minutes a run) | Cancel superseded runs; cache npm; measure the first week and revisit |
| The suite was built around a Windows loopback problem (`scripts/test-ci.mjs`) | Run the same batched script in CI; if Linux needs different batching, the script takes it as an option, not a fork |
| Exporting production D1 may briefly block queries | Rehearse only when migrations are pending; the database is small; stated in the runbook |
| A staging worker is a public URL | Own random secrets, crons off, an empty schema-only database, no production keys ever |
| An `[env.staging]` mistake deploys to production | Agents never run `wrangler deploy`; only the deploy script does, and it names the environment in every command |

### 5.5 Tests

- Worker code (`/healthz`): vitest in the existing suite, written first.
- Node scripts (rehearsal, smoke, deploy guards): decision logic lives in pure
  functions under `scripts/lib/`, tested with `node --test` via
  `npm run test:scripts`; the thin command wrappers are exercised by the
  acceptance checks below.

### 5.6 Exit criteria (each is a check that can fail)

1. A deliberately failing test on a throwaway branch produces a RED CI run; master is GREEN.
2. The staging URL answers `/healthz` with `env: "staging"`, `db: true` and the deployed commit; staging has no cron triggers.
3. `npm run migrate:rehearse` passes against a real production export and leaves no export behind.
4. `npm run deploy -- --env production --dry-run` refuses on a dirty tree and on a commit without green CI, and says why.
5. After the owner's go, production is deployed through the script and `/healthz` on production reports the commit.

### 5.7 Outcome (2026-09-18)

All five exit criteria were met, each by a check that was run and could have failed:

1. A planted failing test on a throwaway branch produced a red CI run; master is green.
2. Staging answers `/healthz` with `env: "staging"`, `db: true` and its commit label, and has no cron triggers.
3. The rehearsal passed against a real production export (42 tables) and left nothing on disk. Two deliberately destructive probe migrations were refused.
4. The production dry run refused on a dirty tree, on CI still running, on untracked files under `migrations/` and `src/`, and on a migration missing from staging. It passed on a clean green commit.
5. On the owner's go, `npm run deploy -- --env production` deployed commit `8fcd948` (0 migrations) and the script's smoke test passed. Checked again outside the script: `/healthz` on production reports `env: "production"`, `db: true` and the label `8fcd948d16f3`; `/public/event` is unchanged; the applied migrations are unchanged.

What acceptance against the real system caught, after every per-task review had come back clean: the first rehearsal could not load the real production dump at all, and the first integrity rule could pass a broken foreign key. Both were rebuilt (decision record `docs/decisions/0001-deploy-safety.md`). The final whole-branch review then found six holes at the seams between tasks; all six were fixed.

Still open from phase 1: the runtime compatibility date (2024-11-01 to 2026-07-22) waits on branch `compat-date-2026-07-22` for its own owner go, because a runtime behaviour change is its own production deploy.

## 6. Cross-repository contract: theme and worker

Live worker endpoints a storefront may call:

- `GET /public/event`
- Through the Shopify app proxy: `GET /proxy/search`, `GET /proxy/product`,
  `GET /proxy/import-status`, `GET /proxy/addons`, `POST /proxy/event`,
  `GET|POST /proxy/affiliate/apply`, `GET /proxy/affiliate/terms`

Data the worker writes INTO Shopify, which the theme then reads natively:
products and collections, `supplier.*` metafields, blog articles, discounts,
URL redirects, markets and delivery settings.

The rule both sides build to:

1. **Every live call is optional.** The theme server-renders a complete default,
   caps the call at 3 seconds, and on failure or absence keeps the default with
   no layout shift, no console error and no customer-visible fault.
2. **Shopify-held data carries its own freshness.** Where the theme shows
   something the worker keeps current (`supplier.last_checked_at`,
   `supplier.status = unknown_stale`), the theme must stay honest once the
   worker stops writing: fall back to the conservative display, never a stale promise.
3. **The worker assumes no particular theme.** Nothing in the worker may depend
   on Active Paw markup, handles, collections or domain. What a store needs from
   a theme is published as a documented, versioned contract.
4. **No shared secrets, no shared code.** The two repositories meet only at the
   endpoints above and at Shopify data.

Theme-side work is never done from this repository. It goes to the theme agent
over the agent channel, and that agent decides and acts.

## 7. How the work is run

Multiple agents build each phase from its plan: one fresh agent per task, each
confined to named files, no agent commits or deploys; every task is reviewed
against the spec and then for quality before it is committed through the gate.
Shared files (`package.json`, `wrangler.toml`, `src/index.ts`) are touched by
one task at a time.

## 8. Open owner decisions

| # | Decision | Needed by |
|---|---|---|
| O1 | Is section 1.1 the right reading of the two messages? | Before phase 4 is specified |
| O2 | A Shopify development store plus a staging copy of the app, so staging can exercise real Shopify flows | Phase 2 |
| O3 | Willingness to place a real, paid, low-value order and let the worker buy it from CJ | Phase 2 |
| O4 | The app's own domain, independent of activepaw.co.uk | Phase 4 |
| O5 | Pricing model for other stores | Phase 7 |
