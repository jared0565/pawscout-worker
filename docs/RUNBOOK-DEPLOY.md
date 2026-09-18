# Deploy runbook

How to deploy the PawScout worker, check what is live, and roll back. Written
for the shop owner and for coding agents. Read this before you deploy, not
after something goes wrong.

## Before you deploy

A production deploy needs the owner's explicit go. The deploy script does not
and cannot check this: it is a decision, not something a command can verify.
Staging deploys do not need a go.

CI must be green for the commit you are deploying to production. The deploy
script checks this for you and refuses if it is not true, unless you give it a
written reason to skip the check (see "Deploy to production" below).

## Deploy to staging

```
npm run deploy -- --env staging
```

This reads the git state, applies any pending migrations to the staging
database, deploys, and then runs the smoke test against the staging URL. The
five numbered guards under "Deploy to production" below are production
only, but staging still refuses if the git state itself cannot be read (for
example `git status` or `git rev-parse` failing). A failed `git fetch` is
only a warning on staging; the same failure refuses a production deploy. The
smoke test prints one line per check, `PASS name: detail` or
`FAIL name: detail`, for three checks: `healthz`, `public-event`, `app`.
Exit code 0 means it deployed and the smoke test passed; 1 means it failed;
2 means bad usage.

Staging has no shop connected to it, so `GET /public/event` answers 503 by
design. The staging deploy tells the smoke test to expect this, so that
answer still counts as a pass.

Staging's URL is recorded in `scripts/lib/deploy-guards.mjs`,
`TARGETS.staging.url`. Set `PAWSCOUT_STAGING_URL` to override it, for
example if the staging Worker is ever respun under a different subdomain.

## Deploy to production

```
npm run deploy -- --env production
```

Production refuses to deploy unless all five of these are true:

1. **The working tree is clean.** Two checks, both checked even on a dry
   run. First: no uncommitted changes to files git already tracks (most
   untracked files are ignored, since this repo carries long-standing
   untracked stray files that must not block a deploy); if this fails, the
   refusal names the modified tracked files: "Commit or discard these files
   before deploying to production: `<files>`." Second, one exception to
   "untracked files are ignored": an untracked file under `migrations/` or
   `src/` refuses the deploy too, because a migration or source file that
   exists in no commit must never reach production; if this fails: "Untracked
   files that a deploy would ship or apply: `<paths>`. Commit them (git add)
   or remove them: a migration or source file that is in no commit must
   never reach production." Any other untracked file is still ignored.
2. **HEAD is pushed.** Your current commit must be what `origin/master`
   points to. If this fails, run `git push` and try again.
3. **CI is green for HEAD.** If CI is failing, pending, or has no run for this
   commit, the deploy is refused. Wait for CI to finish, fix what it found, or
   use `--skip-ci` (below) if CI itself is the problem.
4. **Pending migrations have a passing rehearsal.** If the `migrations/`
   folder has files not yet applied to production, the deploy script rehearses
   them for you (see "Rehearse migrations" below) before it will proceed. A
   dry run defers this guard, since it cannot rehearse anything (see below).
   If the rehearsal fails, the deploy is refused and says which kind: exit 1
   means the migration is not safe for production's data, do not deploy; any
   other exit code means either the rehearsal could not run, or it ran and
   could not clean up its own scratch copy afterward, so either way nothing
   may be deployed on this result, fix the environment and try again.
5. **Pending migrations are already applied to staging.** The rehearsal runs
   on Node's own SQLite copy, not real D1, so the only remaining proof that
   real D1 accepts the SQL is that staging has already taken the same
   migration. Unlike the rehearsal, this is a cheap read, so it is never
   deferred, not even on a dry run. If this fails, deploy to staging first
   (`npm run deploy -- --env staging`). If staging itself cannot be read, the
   deploy fails closed and refuses rather than guessing.

Add `--dry-run` to see what the script would do without doing it:

```
npm run deploy -- --env production --dry-run
```

A dry run checks the clean tree (including the untracked-files-under-
`migrations/`-or-`src/` check), pushed HEAD, green CI, and staging-first
guards, so it can still refuse for any of those. It defers only the
migration-rehearsal guard, since a dry run cannot rehearse anything: if
migrations are pending it prints them and says a rehearsal would run before a
real deploy, but it does not refuse on their account. It never exports data,
applies migrations, deploys, or runs the smoke test.

Use `--skip-ci "<reason>"` only when CI itself cannot give a verdict, for
example when GitHub is down, never to get past a genuinely failing check:

```
npm run deploy -- --env production --skip-ci "GitHub is down"
```

A reason is required, and the deploy script prints it loudly
(`CI check SKIPPED: <reason>`) so it is visible in the deploy output.

Use `--allow-shrink t1,t2` when a pending migration is expected to shrink or
remove rows from named tables on purpose (for example retiring a cache
table). It is passed through to the migration rehearsal.

Exit code 0 means it deployed and the smoke test passed, or a dry run found
nothing to refuse. Exit code 1 means it was refused or failed. Exit code 2
means bad usage, for example a missing `--env`.

## When a migration step fails partway

Two different partial failures can happen around the migration step, and it
matters which one:

**The migration apply step itself fails.** With two or more pending files,
wrangler applies and records one migration file at a time, so some may
already be applied when it fails. The Worker deploy never runs. The previous
Worker version is still serving traffic. Migrations are forward-only: never
try to undo whatever did apply. See what actually landed:

```
npx wrangler d1 migrations list pawscout --remote
```

For staging the database name changes too, not only the environment:

```
npx wrangler d1 migrations list pawscout-staging --remote --env staging
```

The deploy script prints the right one for the environment it was run for. Fix
whatever made the apply fail, then run the same deploy command again: it only
tries what is still pending.

**Migrations apply cleanly, then the Worker deploy step fails.** If this
happens:

- The database is ahead of the code: the new migrations are already applied.
- The previous Worker version is still serving traffic. Nothing is down.
- Migrations are forward-only. Never try to undo them.
- Fix whatever made the deploy fail, then run the same deploy command again.
  It finds no pending migrations left and goes straight to deploying the
  Worker.

Both cases are survivable by design, not by luck: the same forward-only
migration policy that makes a rollback safe (see "Migration policy" below)
also means the previous code keeps working against the newer schema. A
half-deploy just means the code has not caught up to the database yet, and
running the script again finishes that.

## Check what is live

```
curl https://pawscout.activepaw.co.uk/healthz
```

Read the `version` field: it is the 12-character commit hash that was
deployed. On staging, it can carry a `-dirty` suffix (for example
`abc123def456-dirty`), which means that deploy ran from a tree with
uncommitted changes; staging allows this, production never does, so a
production version never has the suffix. `version: unknown` means the Worker
was deployed some other way that did not inject a commit, most likely
`npm run deploy:raw` (see "Escape hatch" below).

## Roll back

```
npx wrangler rollback -y
```

For staging:

```
npx wrangler rollback -y --env staging
```

This was drilled on staging on 2026-09-18, not just written down: the command
exited 0, and `/healthz` reported the previous version's label within 5
seconds. The label is stored with each version, so after a rollback `/healthz`
names the commit you rolled back TO. That is how you confirm a rollback landed.

Rolling back the very first guarded production deploy lands on a version
that predates the `/healthz` route entirely. A 404 there means the rollback
landed on that earlier version, not that the Worker is down; check a route
that existed before this phase (for example `/app`) to confirm the Worker
itself is responding.

A rollback reverts the Worker code only. It never touches the database.
Anything a migration has already done to the schema or the data stays done.

## Migration policy

Migrations are forward-only. A schema change that old code cannot tolerate is
split across releases: expand the schema, deploy, migrate the data, and only
contract the schema (drop a column or table) in a later release. Never drop a
column in the same release that stops using it.

This is what makes a Worker rollback safe after a migration has already run:
because the schema only ever grows first and shrinks later, the previous
version of the code is still able to run against the migrated schema.

A migration file is never edited once any environment, staging or
production, has applied it. If a mistake needs fixing, write a new
migration; do not change the old one. The guard that checks pending
migrations are already on staging compares file NAMES, not their contents,
and staging accepts a dirty tree, so an edited file can look identical to
what staging already proved. When staging is about to apply a pending
migration that is untracked or modified in the working tree, the deploy
script prints a `deploy: WARNING` line naming the files: that is your signal
that the SQL staging is about to prove may not be the SQL you think it is.

## Rehearse migrations

```
npm run migrate:rehearse
```

This exports the production database, then loads that export into a
throwaway SQLite copy held in memory (Node's built-in `node:sqlite`), never
in the local Workers runtime. It applies the pending migration files to the
copy in order, each one as a single all-or-nothing step, checks integrity
(`quick_check` and a foreign key check), and compares per-table row counts
before and after.

This is a second, different check from staging, and neither replaces the
other: applying migrations to the real staging D1 database (part of every
staging deploy) proves that D1 accepts the SQL; this rehearsal proves that
production's actual data survives it, for example a `NOT NULL` column added
over existing null values, a unique index added over duplicate values, or a
table rebuild that quietly drops rows.

Production data touches disk only as the export file, under the gitignored
`.wrangler/rehearsal-<digits>/`, and that file is deleted the moment it is
loaded into memory. With `--keep`, the export and a `copy.sqlite` file are
kept on purpose so you can inspect them; delete that directory yourself
afterward. The copy never goes to staging and never leaves this machine,
because production holds customer messages and addresses.

Every run starts by sweeping away any `rehearsal-<digits>` directories left
by an earlier run. If a leftover cannot be deleted, the run stops immediately
(exit 2) and names the directory: clear it before rerunning. If the loaded
copy looks empty, for example no tables or no rows, the run also stops as an
environment error (exit 2), never as a pass, because an empty copy proves
nothing.

An interrupted run (Ctrl-C, a crash, a closed terminal) can leave an export
sitting in `.wrangler/rehearsal-<digits>/` with nothing around to report it
at that moment. The next run sweeps it automatically, so after an
interruption either run `npm run migrate:rehearse` again or delete the
directory yourself.

If an integrity problem already exists in the copy before the migrations
run, the rehearsal stops immediately as an environment error (exit 2) rather
than trying to guess: across a table rebuild SQLite can renumber rows, so an
old problem and a genuinely new one can look identical, and there is no
reliable way to tell them apart after the fact. Fix those rows in production
first, then rehearse again. Production has none today. A problem that shows
up only after the migrations run is a real rehearsal failure (exit 1).

**The deploy script checks its cheap guards before touching production.**
Every guard that needs no rehearsal, clean tree, pushed HEAD, green CI, and
migrations already on staging, is checked first; only if all of those pass
does a production deploy run this rehearsal. A deploy that was always going
to be refused for one of those reasons never exports anything.

**The export briefly pauses production.** Cloudflare's own documentation
says a running export blocks other database requests. Measured against the
current production database (15.5 MB): about 7 seconds end to end. Run a
rehearsal at a quiet moment, and never across a cron mark: the Worker's jobs
run at minutes 0, 15, 30 and 45 of every hour, and at 04:17 UTC. The guarded
production deploy runs this rehearsal by itself whenever migrations are
pending, so the same timing advice applies to a production deploy that
carries a migration.

The export endpoint has been seen to answer `Authentication error [code:
10000]` once and then succeed on retry about 50 seconds later, while every
other authenticated call kept working. If you see this, run it again; if it
keeps happening, check `npx wrangler whoami`.

Requires Node 22.13 or newer, declared in `package.json`'s `engines` field.
This machine and CI run Node 24.

Flags, as full commands:

```
npm run migrate:rehearse -- --force
```

Runs the rehearsal even when nothing is pending.

```
npm run migrate:rehearse -- --allow-shrink t1,t2
```

Allows the named tables to lose rows or disappear without failing the
rehearsal.

```
npm run migrate:rehearse -- --keep
```

Keeps the export and the SQLite copy on disk instead of deleting them, for
debugging. Both hold full copies of customer messages and addresses. A
passing rehearsal run with `--keep` still exits 0: keeping the data on
purpose does not change the verdict. The next run of this script sweeps that
directory away at startup, since it matches `rehearsal-<digits>` like any
other leftover, so copy out anything you need and delete it yourself before
running the script again.

Exit code 0 means the rehearsal passed, or there was nothing pending; on a
pass it prints the exact migration files it applied to the copy, not just
how many. Exit code 1 means the rehearsal failed: do not deploy, and read
the message, which names the migration file that failed. Exit code 2 means
usage or environment error, for example an old Node version or a leftover
directory that would not delete: nothing was proven either way, so fix the
environment and run it again. Cleanup is judged by whether the scratch
directory still exists at the end, not by whether every step along the way
went cleanly: if an early step could not delete something but the directory
is fully gone by the time the run finishes, that earlier warning no longer
applies and a pass stays a 0; if the directory still exists, a pass is
escalated to a 2, and a genuine failure (exit 1) is never masked either way.

## When the smoke test is red

Read which check failed: `healthz`, `public-event`, or `app`.

- If `healthz` fails because the version does not match, the previous
  version is usually still being served: a request right after a deploy can
  keep hitting the old version for about 15 seconds. The label to compare
  against is in the deploy's own `deploy: deploying <label> to <env>` line,
  printed before the smoke test runs, and in the failing check's own detail
  line; `deployed <label> to <env>` only prints on success, so it is not
  there to read on a red smoke. Wait, then re-run with `--expect-version`
  set to that label, so the re-run actually checks the version again
  instead of passing without checking it:

  ```
  npm run smoke -- <base-url> --expect-version <label>
  ```

  On staging, also pass `--allow-unavailable`, or the `public-event` check
  fails on the 503 that staging answers by design.

- If `healthz` reports the database check as false, roll back now. See
  "Roll back" above.

- If `public-event` fails, check Shopify's status before rolling back.
  `/public/event` answers 503 `unavailable` when its 10 minute cache is cold
  and the live Shopify Admin probe fails, so a Shopify hiccup that outlasts
  the smoke test's roughly 60 second retry window reads as a red smoke on an
  otherwise healthy deploy. Re-run the smoke once Shopify recovers before
  treating this failure alone as a reason to roll back.

- If `app` fails, the deployed Worker is not serving its own console page at
  all. Unlike `public-event`, this is not expected on a healthy deploy, so
  treat it at least as seriously as a `healthz` failure rather than assuming
  a re-run will clear it.

## Escape hatch

`npm run deploy:raw` and `npm run migrate:remote:raw` skip every guard.
Both act on PRODUCTION directly (no `--env` flag means the top-level,
production config), and both need the owner's explicit go, exactly like any
other production deploy.

`npm run deploy:raw` alone does NOT apply migrations: it is a plain
`wrangler deploy` with no clean tree check, no CI check, no migration
rehearsal, and no smoke test. If a migration is pending, running `deploy:raw`
by itself ships new code onto the OLD schema.

The decision record's strict integrity rule (see "Rehearse migrations"
above) can block a migration deploy outright even when the migration itself
is fine, if production already has an unrelated integrity problem. If a
migration genuinely needs to ship before that is cleaned up, the real
emergency path is two commands, in order, both on the owner's go, both
unguarded:

```
npm run migrate:remote:raw
npm run deploy:raw
```

`deploy:raw` leaves `/healthz` reporting `version: unknown`, because it does
not inject the commit. Use either command only with a written reason
recorded in the commit message or the backlog, so there is a record of why
the guarded path was bypassed.
