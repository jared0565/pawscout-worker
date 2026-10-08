# Session handover: owner task list T1 to T7 (2026-10-08)

Written 2026-10-08 08:30Z at the owner's request before a restart. It
replaces the 04:00Z handover of the same day. Every "verified" fact below was
checked first-hand at 08:26Z to 08:30Z; re-check anything before repeating it
(a note is a lead, not a fact).

## 1. Resume here

- **Nothing is mid-flight.** No uncommitted work, no unpushed commits, no
  undeployed runtime change, no extra worktrees, no unmerged branches.
- **Production = `be1417f2f098`** (verified: `curl
  https://pawscout.activepaw.co.uk/healthz` at 08:26Z). master =
  origin/master = `be1417f`; CI run 37741331463 on that commit: success.
  Master is ahead of production only by the docs-only commit that adds this
  file, so a production deploy now would change nothing at runtime.
- Working tree: clean apart from three owner files that must be left alone:
  `GRAPHITE-HANDOVER.md`, `cart-summary.png`, `how-we-bundle.png`.
- `git stash list` holds one old entry, `stash@{0}` from 2026-07-11 ("WIP on
  master: d5d9999 docs(plan): blog distribution phase 1"). Not from this
  session; leave it unless the owner asks.
- Live fulfilment config (verified by D1 read 08:27Z): `fulfil.mode = manual`,
  `createOnly = 1`. The store has exactly 1 order, status `cancelled`. So the
  order-path work (T5) cannot run yet.
- The task list lives in memory `pawscout-backlog.md`, top bullet of the
  RESUME block ("TASK LIST FOR THIS SESSION"), with full history per task.
  There is no pending owner question.

## 2. This session's task list

The owner asked for the open items as a list and worked them one at a time.

| Task | Status | What |
|---|---|---|
| T1 | Done, live | Traffic chart's final x-axis date label no longer runs off the right edge (`text-anchor="end"` at its bar's right edge, `src/console/traffic-js.ts`). Re-measured live in the admin iframe at 90 days. |
| T2 | Done | Old branch `claude/inbox-suppress-blank-emails` archived as annotated tag `archive/inbox-suppress-blank-emails` (-> 58591e4, on origin) and deleted locally and on origin. Nothing ported: its three commits are superseded on master. Owner kept the sales@ partnership rule (memory `sales-address-partnership-lane-kept`). |
| T3 | Checked, waiting on upstream | `package.json` `overrides` (undici 7.29.1, sharp 0.35.5) are still needed: without them npm audit shows 5 high. Re-checked 08:28Z: pool-workers 0.23.0 still pins miniflare 5.20260815.0-alpha; wrangler 4.148.0 uses 5.20261006.0-alpha. Unchanged. |
| T4 | Waiting on aramid | 12 fixed findings wait for aramid to re-examine their files (section 4). None drained this session. |
| T5 | Blocked on the owner | First real PawScout create-only order (section 5). |
| T6 | Done, live | Greeting no longer says "Hi My," / "Hi The," / "Hi Am," when the display name is a sentence ("MY NAME IS SAMAD" -> "Hi Samad,"; "The Zetee Professional" -> "Hi there,"). |
| T7 | Done, live | Business display names no longer greeted as a first name ("Shopify Review", "Boostura Agency" -> "Hi there,"); a job word beside a real name is skipped ("Developer mubarak" -> "Hi Mubarak,"). |

Production deploys this session (each on the owner's explicit go, guarded
script, staging first, no migrations, prod smoke 3/3, healthz confirmed):

| Production version | Deployed (UTC) | Task |
|---|---|---|
| `ae41cb59db28` | 2026-10-08 04:57 | T1 |
| `0c8e6e03bf3d` | 2026-10-08 06:23 | T6 |
| `be1417f2f098` | 2026-10-08 07:22 | T7 |

Earlier work (security gate pass, "I paid this", pay-retry CREATED/UNPAID,
2026-10-07 to 03:38Z today) is in `git log` and the backlog memory.

## 3. Greeting rules as they stand (src/inbox/draft.ts)

`salutationName(rawName, email?)` is called only by `applySalutation`
(graphite `callers`, decision_grade). It produces "Hi <name>," or
"Hi there,". Order of checks:

1. Strip a leading self-introduction (`my name is`, `I am`, `I'm`, `call me`).
2. First token `the` or `are` -> "Hi there," (`NOT_A_NAME_LEAD`).
3. Per token: skip `TITLES` (mr, mrs, dr, lady...) and `JOB_WORDS` (shopify,
   expert, developer, investor, specialist, hub, web, logistics, logisticss,
   power); any token in `ROLE_NAMES` (role mailboxes plus words seen only in
   business names: agency, solutions, factory, review, microsoft, prime...)
   -> "Hi there,".
4. Then the existing email-prefix disambiguation and title-casing.

Safety net used for T6 and T7: every rule change was compared old vs new over
all 425 stored `inbox_contacts` names, against a change list written before
the run (T7: 44 rows changed, exactly as listed). Given names that are also
words (Favour, Blessing, Precious, Gift, Peace, Wisdom, Unique) still greet,
and so do personal brands like "Ibrahim Expert", "TEMI DIGITAL".

**Known residue, by design (a word list cannot tell):** one-word brands
(Buddify, Vortex, Easesupply, Shopifysupportpartner) and brand plus tag
(Smartify Pro, Gobo Creative, Hilluxe Tech, Desent Tech, Holar Consult,
Sjbest Consult) still get "Hi <Brand>,". Not a task; only if the owner asks.

The comparison harness lived in the old session's scratchpad
(`...\Temp\claude\F--Projects-Shopify-demo-store2-pawscout-worker\441c8784-0d29-49e9-9be6-77bb22332da2\scratchpad\t6`:
`contacts.json`, `run-*.mts`, `t7-expected.json`). Temp files may be cleaned;
it is quick to rebuild (D1 `SELECT name, email FROM inbox_contacts`, extract
the function, run old and new, diff).

## 4. Security ledger: 22 open (verified 08:26Z), all accounted for

Read it with `aramid ledger filter --status open`. None needs action now.

- **10 semgrep `new Function()` entries in test files**, all suppressed by
  reviewed `.aramid-suppressions.toml` entries: 3319eabd, bf407751, 4d2c2f64,
  17644a59, c22a7640, c03de5b0, 6bf8c11c, ca50661e, 00d9bd3f, 131e8806.
- **9 LLM-review findings fixed in live code**, waiting for aramid to
  re-examine their files (they clear by "evidence gone"; `ledger resolve`
  only takes `--out-of-scope`): 114e2e7b, b4b33fbf, 53d7292e, 2f32d185,
  0029992d, 901d2392, 9cb8eddc, 82d77aaa, ab7ce5d8.
- **3 js-mutation survivors already killed by tests**, waiting for the drain
  to re-sample: e90e99d3 (product.ts:168), 17f1323 (index.ts:822), 9d40cb6e
  (ingest.ts:82).
- Overridden this session on the owner's choice: b98786e0 (raised at 06:01Z
  against the previous version of this file; same accepted risk as c1029563).
  Overridden list: `aramid ledger filter --status overridden` (8 entries).

## 5. Open items, in order

1. **T4, next session:** re-run `aramid ledger filter --status open`. The 12
   waiting ids above should drain on their own. Investigate one only if it
   stays open after aramid has demonstrably re-examined its file. Never
   override a fixed finding.
2. **T5, when the owner switches fulfilment to PawScout create-only (the
   switch is the owner's):**
   - Read the status CJ gives an order PawScout created before payment
     (CREATED or UNPAID; unconfirmed). Read-only route `/api/cj-order-diag`
     via the admin iframe recipe in memory
     `call-session-authed-routes-via-iframe`.
   - Check that the "I paid this" button appears on that order and that the
     banner drops it once pressed.
3. **T3, whenever:** re-check upstream with
   `npm view @cloudflare/vitest-pool-workers version dependencies.miniflare`,
   `npm view wrangler version dependencies.miniflare`, then
   `npm view miniflare@<each> dependencies.sharp dependencies.undici`.
   Remove an override only when BOTH miniflares declare sharp >= 0.35.5 and
   undici >= 7.29.1, then confirm `npm audit` shows 0 high.

## 6. Gotchas (this session and the last)

- **The strict graphite hook denies cross-file greps whose pattern contains a
  known symbol** (seen this session: `FAIL`, `attempt`, `email`; also `open`,
  `order`, `api`, `text`). Use `python -P -m graphite query "callers X"` /
  `search`, or grep ONE file per command.
- **Cloudflare D1 calls flap with code 7403.** Reads and the guarded deploy's
  state-gathering both hit it this session; simply re-run.
- **Post-deploy healthz lags about 15s**; the smoke retries and catches up.
- **wrangler `--json` output** has banner text before the JSON: parse from
  the first `[\n  {`.
- **The contacts table is `inbox_contacts`** (there is no `contacts`).
- **`git rev-parse --short=12 A B`** fails ("Needed a single revision"); use
  plain `git rev-parse A B`.
- **`grep -P` is unavailable** in this shell; use a node script.
- **Heredocs mangle backslashes** in inline scripts; write the script to a
  file, or build the character with `String.fromCharCode(92)`.
- **Playwright MCP blocks `file:` URLs** and saves only under the repo or
  `.playwright-mcp/` (gitignored); serve local pages with
  `python -P -m http.server` on 127.0.0.1.
- **Console JS lives in template literals** (`src/console/*-js.ts`): tsc cannot
  see errors inside; run `tests/console.test.ts` and `npm run lint`.
- **Agent worktrees inside the repo double the test suite**; remove finished
  worktrees (`git worktree remove`, then `git worktree prune`).
- **semgrep blocks every NEW `new Function()` line at push** (not
  overridable). Precedent: one compile per test plus a reviewed
  `.aramid-suppressions.toml` entry.
- **Deploy timing:** a pending migration triggers a rehearsal that exports the
  production DB; keep clear of minutes 0/15/30/45 and 04:17 UTC.

## 7. Standing rules (short)

Production deploy only on the owner's explicit "go", only via
`npm run deploy -- --env production`; a feature request is not a deploy go.
Staging needs no go. Never `--no-verify`. Auto-push after commits. aramid and
graphite are tools: use their commands, never talk to their agents. Never use
the demo-store2 Python scripts app for Shopify operations. No em or en dashes
in code or customer text. Stay inside this repository. Leave the three owner
files above alone.

## 8. Quick state checks

```
curl -s https://pawscout.activepaw.co.uk/healthz
git -C F:/Projects/Shopify/demo-store2/pawscout-worker log --oneline -3
aramid ledger filter --status open
npx wrangler d1 execute pawscout --remote --json --command "SELECT json_extract(fulfil,'$.mode') mode, json_extract(fulfil,'$.createOnly') createOnly FROM tenant_config WHERE shop='4qkudm-ez.myshopify.com'"
npm run deploy -- --env production --dry-run
```

Durable memory: `pawscout-backlog.md` (top bullets of the RESUME block) was
updated through 2026-10-08 08:30Z.
