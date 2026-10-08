# Session handover: security gate pass (2026-10-07 to 2026-10-08)

Written 2026-10-08 04:00Z at the owner's request before a restart. Every
"verified" fact below was checked first-hand at that time; re-check anything
before repeating it (a note is a lead, not a fact).

## 1. Resume here

- **Nothing is mid-flight.** No uncommitted work, no unpushed commits, no
  undeployed commits, no open worktrees.
- **Production = `3445b78ff204`** (verified: `curl
  https://pawscout.activepaw.co.uk/healthz` reported that version; staging was
  deployed with the same commit). Master is ahead of it only by the docs-only
  commit that added this file, so a production deploy now would change nothing
  at runtime.
- Working tree: clean apart from three owner files that must be left alone:
  `GRAPHITE-HANDOVER.md`, `cart-summary.png`, `how-we-bundle.png`.
- Live fulfilment config (verified by D1 read): `fulfil.mode = manual`,
  `createOnly = 1`. The store has exactly 1 order (cancelled, no supplier
  order). So none of the order-path changes below can run yet.
- The owner's original ask was "deal with the security gate". That pass is
  **done and live**. There is no pending owner question.

## 2. What shipped (all live in production)

| Production version | Deployed (UTC) | What |
|---|---|---|
| `40fab613d9c2` | 2026-10-07 08:52 | Part 1: dev toolchain overrides (undici 7.29.1, sharp 0.35.5), receiver-first Authentication-Results (`src/inbox/mime.ts`), SKU path pet rule (`src/sourcing/offers.ts`) |
| `fee3018e2d5a` | 2026-10-07 14:04 | Part 2: deep research reserves its cost before it runs (c1029563); sender blocking waits for the sweep, lifts for paying/DMARC-passing customers, blocked-senders list in the Inbox (114e2e7b, b4b33fbf); stale held sourcing offer refused at send + migration 0045 `inbox_drafts.meta_json` (53d7292e); template stage written on send (785e4f91); order fixes: alert-marker run counting (64aa5a81), pay-retry reads the CJ order first (87a8dc74 part), released freight hold capped near the approved figure (741095d3) |
| `bae8c7484711` | 2026-10-07 15:48 | Spoofed block (2f32d185): every copy counted toward a block must have passed DMARC; migration 0046 `inbox_messages.dmarc` (NULL for form posts and all pre-0046 rows, deliberately not back-filled) |
| `2fb45df2e26a` | 2026-10-07 17:48 | "I paid this" (87a8dc74): console button (two clicks) on an awaiting-payment order with a supplier order, "Not paid after all" undo; migration 0047 `orders.owner_paid_at`. Row STAYS `awaiting-payment` on purpose (the 15 minute cancellation re-check and the tracking poll select by that status); banner + overview count skip it; pipeline never pays a marked order; cancel alert says "you marked it paid on <date>" |
| `3445b78ff204` | 2026-10-08 03:38 | Pay-retry pays when CJ reports `CREATED` or `UNPAID` (owner decision); everything else (TRASH, CANCELLED, UNSHIPPED, lowercase, empty) holds. Plus a headers round-trip test killing mutant 9d40cb6e |

Also on master (no runtime effect): vitest + eslint exclude `.claude/**`
(commit `6c3a511`); one new reviewed entry in `.aramid-suppressions.toml`
(`131e8806`, a `new Function()` in `tests/console.test.ts`, same standard as
the earlier entries).

Accepted risks overridden in the ledger (owner choices, 2026-10-07):
8e168ffb (paid orders not re-checked), 6d668489 (shopper picks country),
c1029563 (any staff can run research; its cost part is fixed).

## 3. Security ledger: 22 open (verified 04:00Z), all accounted for

Read it with `aramid ledger filter --status open`. None needs action now.

- **10 semgrep `new Function()` entries in test files**, all suppressed or
  owner-ruled "leave": 3319eabd, bf407751, 4d2c2f64, 17644a59, c22a7640,
  c03de5b0, 6bf8c11c, ca50661e, 00d9bd3f, 131e8806.
- **9 LLM-review findings fixed in live code**, waiting for aramid to
  re-examine their files (they clear by "evidence gone"; `ledger resolve`
  only takes `--out-of-scope`, so they cannot be closed by hand):
  114e2e7b, b4b33fbf, 53d7292e, 2f32d185, 0029992d, 901d2392, 9cb8eddc,
  82d77aaa, ab7ce5d8.
- **3 js-mutation survivors already killed by tests**, waiting for the drain to
  re-sample (2 mutants per item): e90e99d3 (product.ts:168), 17f1323
  (index.ts:822), 9d40cb6e (ingest.ts:82).
- Cleared this pass: the 3 npm findings, 94b9b378, 785e4f91, 64aa5a81,
  741095d3, 87a8dc74.

## 4. Open items, in order

1. **First real create-only order (when the owner switches fulfilment to
   PawScout create-only; that switch is the owner's):**
   - Confirm what status CJ gives an order PawScout created before it is
     paid. Read-only route: `/api/cj-order-diag` (getOrderList, via the admin
     iframe recipe in memory `call-session-authed-routes-via-iframe`). CJ docs
     list CREATED ("wait confirm") and UNPAID ("confirm order"); which one an
     API order (createOrderV2 payType 2) sits in is UNCONFIRMED. On
     2026-10-07 the account held only 2 orders, both `TRASH`.
   - Check the "I paid this" button appears on that order and the banner
     drops it once pressed.
2. Watch the ledger next session: the 12 "waiting" items above should drain
   on their own. If one stays open long after its file was re-examined,
   investigate, do not override a fixed finding.
3. Remove the `package.json` `overrides` (undici 7.29.1, sharp 0.35.5) once
   miniflare ships sharp >= 0.35.5 and the vitest pool pins undici >= 7.29.1.
4. Cosmetic, offered and not applied: the traffic chart's last x-axis label
   overruns by 2px (fix: `text-anchor: end` on the final label).
5. Pre-existing, untouched: branch `claude/inbox-suppress-blank-emails`
   (2026-06-24, "Suppress quote-only inbox drafts") is not merged into master.
   Not from this session; ask the owner before doing anything with it.

## 5. Gotchas learned this session

- **Agent worktrees inside the repo double the test suite.** An Agent run
  with `isolation: worktree` puts a full checkout under `.claude/worktrees/`;
  vitest collected it and the pre-push gate timed out at 600s. Fixed with an
  exclude, but remove finished worktrees anyway (`git worktree remove`, then
  `git worktree prune`). Full suite is about 250 to 375s now.
- **Cloudflare D1 reads flap with code 7403.** The guarded deploy refuses at
  state-gathering (nothing written); simply re-run it. Happened 2x on
  2026-10-07.
- **The strict graphite hook denies cross-file greps whose pattern contains a
  known symbol** (even words like `FAIL`, `open`, `order`, `api`, `text`).
  Use `python -P -m graphite query "callers X"` / `search`, or grep ONE file
  per command.
- **Python heredoc edits:** a `'\\n'` inside the Python string can land in a
  TypeScript test as a literal line break. After a scripted edit, grep the
  result; use the Edit tool for lines containing escapes.
- **semgrep blocks every NEW `new Function()` line at push** (BLOCK tier, not
  overridable). Precedent: one compile per test, plus a reviewed
  `.aramid-suppressions.toml` entry with a verified-at-source reason.
- **Deploy timing:** a pending migration triggers a rehearsal that exports
  the production DB; keep clear of minutes 0/15/30/45 and 04:17 UTC.
- **GitHub push can 500** after the gate passes; re-push (the gate re-runs).

## 6. Standing rules (short)

Production deploy only on the owner's explicit "go", only via
`npm run deploy -- --env production`; a feature request is not a deploy go.
Staging needs no go. Never `--no-verify`. Auto-push after commits. aramid and
graphite are tools: use their commands, never talk to their agents. Never use
the demo-store2 Python scripts app for Shopify operations. No em or en dashes
in code or customer text. Leave the three owner files above alone.

## 7. Quick state checks

```
curl -s https://pawscout.activepaw.co.uk/healthz
git -C F:/Projects/Shopify/demo-store2/pawscout-worker log --oneline -3
aramid ledger filter --status open
npx wrangler d1 execute pawscout --remote --json --command "SELECT json_extract(fulfil,'$.mode') mode, json_extract(fulfil,'$.createOnly') createOnly FROM tenant_config WHERE shop='4qkudm-ez.myshopify.com'"
npm run deploy -- --env production --dry-run
```

Durable memory: `pawscout-backlog.md` (newest bullet at the top of the RESUME
block) and `hand-payment-invisible.md` were updated through 2026-10-08 03:40Z.
