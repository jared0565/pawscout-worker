# Final Review Fix Report

Branch: claude/inbox-suppress-blank-emails
Date: 2026-06-24

## FIX 1 (CRITICAL) - Close money-gate hole in `src/inbox/autosend.ts`

**File:** `src/inbox/autosend.ts`

**MONEY_RE before:**
```
/[£$€]\s?\d|\b\d+(?:\.\d{2})?\s?(?:gbp|usd|eur|...)...|.../i
```
Leading `[£$€]` symbol-before-number existed but no `GBP 14.99` / `GBP 50` currency-word-before-number branch.

**MONEY_RE after:**
Added `\b(?:gbp|usd|eur)\s?\d` as second alternation immediately after the symbol branch:
```
/[£$€]\s?\d|\b(?:gbp|usd|eur)\s?\d|\b\d+(?:\.\d{2})?\s?(?:gbp|usd|eur|...)...|.../i
```

**Tests added** (`tests/inbox-autosend.test.ts`):
- `it('catches currency-word-before-number (GBP prefix)')`: asserts TRUE for `'Delivery is a flat GBP 14.99.'`, `'GBP 50'`, `'It is GBP 23.99 to your country.'`, `'free on orders over GBP 50'`
- `it('does not false-positive on plain prose without money')`: asserts FALSE for `'Yes we ship to Ireland.'`

Note: `tests/agents/autosend.test.ts` already had `'That will be 20 GBP.'` covered by the number-before-currency branch (unchanged), so no new assertions needed there.

## FIX 2 (IMPORTANT) - Wholesale wording governance

**File:** `src/inbox/agents/wholesale.ts`

**Before:** `promptFragment` ended with `"...welcome to order individual items through the website. Thank them and note we will keep their interest on file."`

**After:** Removed the final clause. Fragment now ends at `"...welcome to order individual items through the website."`

Rationale: "keep their interest on file" implies a follow-up or programme is coming, violating the "do not imply a wholesale programme or follow-up exists or is coming" governance rule.

`tests/agents/wholesale-agent.test.ts` passes without changes (it asserted `not offering` and `do not imply`, neither of which was in the deleted phrase).

## FIX 3 (MINOR) - Em-dash in `.gitignore`

**File:** `.gitignore` line 8

**Before:** `# Graphite — local code graph tooling/output`

**After:** `# Graphite - local code graph tooling/output`

Standing rule: no em/en-dash anywhere in the codebase.

## FIX 4 (MINOR) - Harden affiliate test

**File:** `tests/agents/affiliate-agent.test.ts`

Added `expect(affiliateAgent.commercial).toBe(false);` for parity with lead-agent test pattern.

## FIX 5 (MINOR) - Cover product spec-field path

**File:** `tests/agents/product-agent.test.ts`

Added test: resolved product + `getLinkByShopifyProductId -> {cj_pid:'p1'}` + `getWarehouseProduct -> { stock: 12, status: 'available', detail: JSON.stringify({ categoryName: 'Harnesses', petClass: 'dog' }) }`.

Asserts `g.facts` contains `'Category: Harnesses'` and `'For: dog'` - matching the exact format in `src/inbox/agents/product.ts` lines 34-36:
```ts
if (detail.categoryName) specParts.push(`Category: ${detail.categoryName}`);
if (detail.petClass) specParts.push(`For: ${detail.petClass}`);
```

## Test Command and Output

```
npx vitest run tests/inbox-autosend.test.ts tests/agents/autosend.test.ts tests/agents/wholesale-agent.test.ts tests/agents/affiliate-agent.test.ts tests/agents/product-agent.test.ts
```

Result:
- tests/agents/affiliate-agent.test.ts: 1 test passed
- tests/agents/wholesale-agent.test.ts: 1 test passed
- tests/agents/autosend.test.ts: 3 tests passed
- tests/agents/product-agent.test.ts: 6 tests passed
- tests/inbox-autosend.test.ts: 13 tests passed
- **Total: 5 files, 24 tests - ALL PASSED**

`npx tsc --noEmit`: clean (no output, exit 0)

## Files Changed

1. `src/inbox/autosend.ts` - widened MONEY_RE to catch currency-word-before-number
2. `src/inbox/agents/wholesale.ts` - removed "keep their interest on file" clause
3. `.gitignore` - em-dash to hyphen in Graphite comment
4. `tests/inbox-autosend.test.ts` - added GBP prefix regression tests
5. `tests/agents/affiliate-agent.test.ts` - added commercial:false assertion
6. `tests/agents/product-agent.test.ts` - added spec-field (categoryName/petClass) test
