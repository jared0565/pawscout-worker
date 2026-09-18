# 0001: Deploy safety

## Status

Accepted, 2026-09-18.

## Context

Measured first-hand on 2026-09-18 (PRD section 3, "Nothing stands between a
commit and production"): there was no `.github/workflows`. The only gate was
this machine's gitignored hooks, so a second clone had none. There was no
staging worker and one database, so all 40 migrations up to that point went
straight onto live data. `compatibility_date` was still `2024-11-01`.
Deployments carried no commit annotation, so which commit was live was
tracked by hand.

## Decision

Build eight components, together called phase 1, deploy safety:

- **C1, CI:** GitHub Actions runs `npm ci`, typecheck, lint,
  `npm run test:ci`, `npm run test:scripts`, on Node 24, ubuntu, triggered on
  every push and on manual dispatch. There is no `pull_request` trigger: with
  one owner pushing every branch directly, `push` already covers every
  commit, a `pull_request` trigger would run the same suite twice on the
  same commit, and the repository is private, where Actions minutes are a
  budget. In-progress runs for the same ref are cancelled and there are no
  path filters, so every pushed commit gets a verdict.
- **C2, `/healthz`:** a public, unauthenticated, `no-store` endpoint that
  answers `{ ok, env, version, db }`, where `version` is the commit injected
  at deploy and `db` is a real `SELECT 1` check, so the current commit is
  knowable from outside.
- **C3, staging:** a separate `[env.staging]` worker with its own D1
  database, crons off, its own random secrets, and `ENVIRONMENT = "staging"`,
  so a deploy can fail somewhere harmless.
- **C4, migration rehearsal:** `npm run migrate:rehearse` exports production,
  loads the copy into a throwaway in-memory SQLite database (see the
  addendum below for why), applies pending migrations, checks integrity and
  foreign keys, compares row counts, and deletes the export, because
  data-dependent migration failures only show against real data.
- **C5, smoke test:** `npm run smoke` checks `/healthz`, `/public/event`, and
  `/app` against a base URL, giving one command that says whether a deploy is
  alive.
- **C6, guarded deploy:** `npm run deploy` refuses a production deploy unless
  the tree is clean, HEAD is pushed, CI is green for HEAD, any pending
  migration has a passing rehearsal, and any pending migration has already
  reached staging, then applies migrations, deploys with the commit
  injected, runs the smoke test, and prints the rollback command on a failed
  smoke. `npm run deploy:raw` remains as an escape hatch.
- **C7, runbook and decision record:** `docs/RUNBOOK-DEPLOY.md` and this
  file, so the next project copies the reasons and not only the code.
- **C8, compatibility date:** raise `compatibility_date` from `2024-11-01`,
  staging first, production only on the owner's go.

## Alternatives considered and why not

- **Rehearsing against the staging database instead of a local copy.**
  Rejected: the export holds real customer data, and copying it onto a
  remote staging database would take that data off this machine, which is
  exactly what the rehearsal is designed to avoid.
- **Path filters in CI, so unrelated changes skip the pipeline.** Rejected:
  the guarded deploy needs a CI verdict for every commit it might be asked to
  deploy, and a path-filtered run leaves some commits with no verdict at all.
- **Automatic rollback on a red smoke test.** Deferred: rolling back
  automatically is only safe once the smoke test has a track record, because
  a false alarm would roll back a good deploy. Phase 1 prints the rollback
  command and leaves the decision to a person.
- **A Shopify-connected staging environment.** Deferred: this needs an owner
  decision (see PRD section 8, O2) and belongs to phase 2, prove the money
  loop, not to phase 1.

## Addendum, 2026-09-18: migration rehearsal runs on node:sqlite

**Decision:** the rehearsal loads the production export into a throwaway
SQLite copy using Node's built-in `node:sqlite`, not the local Workers
runtime that `wrangler d1 execute --local` provides.

**Evidence, first-hand, 2026-09-18:** the first design loaded the export with
`wrangler d1 execute --local --file`. Against the real 15.5 MB production
export, the local runtime bundled with wrangler 3.114 printed 190
`HashIndex detected hash table inconsistency` errors and died with a `Body
Timeout Error` after 300 seconds. `node:sqlite` loaded the same export in 182
milliseconds: 43 tables, 16,806 rows, `quick_check` ok, no foreign key
violations, foreign keys enforced by default, SQLite 3.53.0.

**Rejected:** splitting the dump into chunks so the local runtime could
ingest it (slow, and it works around a runtime bug instead of removing the
dependency on it); loading the copy into the staging D1 database (production
holds customer messages and addresses, and that would put them on a shared
remote database).

**Cost:** the rehearsal copy runs on Node's own SQLite build, not on D1's
engine, so it cannot catch a D1-specific rejection. That gap is covered by a
dedicated production guard, "pending migrations are already applied to
staging": production refuses outright if a pending migration has not
already reached the real staging D1, so the SQL itself being accepted is
proven before this rehearsal ever runs to prove production's data survives
it. This used to depend on staging being deployed first as an operator
habit; it is now enforced by that guard.

## Addendum, 2026-09-18: the rehearsal's integrity check is strict, not old-vs-new

**Decision:** an integrity problem (`quick_check` or a foreign key check)
found in the copy before the migrations run stops the rehearsal outright as
an environment error (exit 2); one found only after the migrations run is a
rehearsal failure (exit 1). There is no comparison that tries to tell an old
problem from a new one.

**Evidence:** the first version of the rehearsal recorded integrity problems
before and after applying the migrations and only failed on the ones that
were new, on the theory that a pre-existing problem is not this migration's
fault. Independent review reproduced a real false pass: SQLite's integrity
checks identify a problem by table, rowid and parent, and a table rebuild
can renumber rowids, so a migration that dropped the row holding an old
violation while orphaning a different row could produce the identical
identity string. The before/after comparison then saw nothing new and
passed a migration that had, in fact, broken a foreign key.

**Rejected:** keeping the before/after comparison and making the identity
string more specific (rowid is not a stable identity across a rebuild, so no
string built from it can be made reliable); counting problems before and
after instead of comparing their identities (the reproduced case counted one
problem before and one after, so a count would have passed it too).

**Cost:** a production database that already has one integrity problem now
blocks every migration deploy that touches it, until that row is fixed, even
for a migration unrelated to it. This is a real defect worth fixing once at
the source, not a permanent inconvenience, and production has none today. If
a migration is genuinely needed before that cleanup happens, the unguarded
pair `npm run migrate:remote:raw` then `npm run deploy:raw` remains the
emergency hatch (see `docs/RUNBOOK-DEPLOY.md`, "Escape hatch").

## Addendum, 2026-09-18: every D1 read in the deploy scripts fails closed

**Decision:** a D1 read in the guarded deploy that fails for any reason other
than an expected empty result (a fresh database's missing `d1_migrations`
table, and only on staging, never on production) refuses cleanly with the
reason and a note that the Cloudflare API has been seen to refuse a read
transiently, so try again and check `npx wrangler whoami` if it keeps
happening. The rehearsal fails closed in the same way (its own read of
`d1_migrations` prints the reason and exits 2, and its export failure carries
the retry note); its `d1_migrations` read does not print the retry note yet.

**Evidence:** two separate transient Cloudflare API failures, both on
2026-09-18. The migration rehearsal's export endpoint returned
`Authentication error [code: 10000]` once and succeeded on retry about 50
seconds later. Separately, a staging deploy died when a D1 read returned
"The given account is not valid or is not authorized to access this
service"; the same read succeeded about 60 seconds later. In both cases
every other authenticated call kept working throughout.

**Rejected:** leaving the failure as an uncaught exception, which is what a
production `d1_migrations` read failure used to do: the operator got a raw
Node stack trace instead of a reason and a next step.

**Cost:** one more error path to keep consistent across every D1 read in
these scripts, in exchange for a clear "try again" instead of a stack trace
on a failure that is usually gone within a minute.

## Consequences

Deploys take longer: a production deploy now runs guards, and often a
migration rehearsal, before anything reaches the live Worker. A second gate
can disagree with the first, for example CI is green but the guarded deploy
still refuses on a dirty tree, and that disagreement is the point: the two
checks are not redundant. `npm run deploy:raw` remains available and bypasses
every guard, but it is visible after the fact because it leaves `/healthz`
reporting `version: unknown`.
