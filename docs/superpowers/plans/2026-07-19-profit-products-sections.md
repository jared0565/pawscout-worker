# Profitability Products Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the dead rows out of Profitability → Products and reorganize the list into collapsible verdict sections with a search box.

**Architecture:** One SQL-level exclusion in `listProfitVerdicts` (failed links join archived links as non-displayable), then a pure client-side rework of `pfRender`'s list block: filter by query → group by verdict → render three collapsible sections. No new routes, no migration, no data-model change.

**Tech Stack:** Cloudflare Worker TS; console browser JS lives inside TS template literals (no backticks/`${}` inside, `'+'` concatenation, `esc()` every dynamic value); vitest workerd pool.

## Global Constraints

- Browser-JS-in-template-literal rules (top of `src/console/profit-js.ts`): no backticks or `${}` inside the literal, string `+` concatenation only, `esc()` around every dynamic value, double-escape backslashes.
- After ANY edit to console template-literal files, run `npx vitest run tests/console.test.ts` (tsc cannot see JS syntax errors inside the literals).
- vitest full-suite runs wedge on this machine: run only the named test files per step, ≤8 files per invocation, ~10s between invocations.
- No em-dash anywhere in code or copy.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Store layer — exclude failed links from the console list

**Files:**
- Modify: `src/tenant-store.ts:465-483` (`listProfitVerdicts`)
- Test: `tests/profit-console.test.ts`

**Interfaces:**
- Consumes: `TenantStore.putLink({cjPid, state, shopifyProductId?, handle?})`, `TenantStore.upsertProfitVerdict({cjPid, verdict, netGbp, netPct, ourRetailGbp, competitorGbp, competitorConfidence, competitorSources, reason})` (both exist).
- Produces: `listProfitVerdicts` unchanged signature; rows for `failed`-state links no longer returned. Sole production caller is `getProfitConsole` (graphite-verified 2026-07-19).

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('recalibration store methods ...')` block in `tests/profit-console.test.ts` (it already has `beforeEach` migrations + `SHOP`):

```ts
  it('listProfitVerdicts omits verdicts for archived AND failed links (dead products are not reviewable)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const verdict = (cjPid: string) => s.upsertProfitVerdict({
      cjPid, verdict: 'reject', netGbp: -1, netPct: -10, ourRetailGbp: 9.99,
      competitorGbp: 5, competitorConfidence: 'high', competitorSources: ['ebay.co.uk (3 matches)'], reason: 'x'
    });
    await s.putLink({ cjPid: 'LIVE', shopifyProductId: 'gid://L', state: 'imported' });
    await s.putLink({ cjPid: 'DEAD', shopifyProductId: 'gid://D', state: 'failed' });
    await s.putLink({ cjPid: 'GONE', shopifyProductId: 'gid://G', state: 'archived' });
    await verdict('LIVE'); await verdict('DEAD'); await verdict('GONE');
    const pids = (await s.listProfitVerdicts(50)).map((r) => r.cj_pid);
    expect(pids).toEqual(['LIVE']);
  });
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run tests/profit-console.test.ts` → the new test fails with `['LIVE','DEAD']` (or similar) containing `DEAD`.

- [ ] **Step 3: Implement** — in `src/tenant-store.ts` `listProfitVerdicts`, change the WHERE line:

```ts
         WHERE pp.shop = ?1 AND (pl.state IS NULL OR pl.state NOT IN ('archived', 'failed'))
```

(was `(pl.state IS NULL OR pl.state <> 'archived')`; everything else in the method stays byte-identical.)

- [ ] **Step 4: Run to PASS** — `npx vitest run tests/profit-console.test.ts` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/tenant-store.ts tests/profit-console.test.ts
git commit -m "fix(profit): console list omits failed-link verdicts (52 dead rows)"
```

---

### Task 2: Console UI — sections + search

**Files:**
- Modify: `src/console/profit-js.ts` (`pfState` line 7, `pfRender` list block lines ~127-156, `pfToggleAll` line 159)
- Modify: `src/console/views/profit.ts` (search input before `<div id="pf-list">` line 49; CSS block ~line 99)
- Test: `tests/console.test.ts` (served-script containment assertions)

**Interfaces:**
- Consumes: `pfRowTr(r)`, `esc()`, `el()` (exist, unchanged); row fields `verdict|name|sku|handle` from `getProfitConsole`.
- Produces: browser functions `pfMatch(r,q)`, `pfGroup(rows)`, `pfTableHtml(rows)`, `pfSectionHtml(key,title,rows)`, `pfToggleSection(a)`, `pfSearch(v)`. `pfToggleAll` and `pfState.showAll` are REMOVED.

- [ ] **Step 1: Update the failing containment test first** — in `tests/console.test.ts` near the existing `expect(scripts).toContain('function pfRenderLedger(');` (line ~375) add:

```ts
    expect(scripts).toContain('function pfToggleSection(');
    expect(scripts).toContain('function pfSearch(');
    expect(scripts).toContain('id="pf-search"');
    expect(scripts).not.toContain('pfToggleAll');
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run tests/console.test.ts` → the new assertions fail (functions absent, pfToggleAll still present).

- [ ] **Step 3: Implement `src/console/profit-js.ts`** —

3a. Line 7, replace state:

```js
var pfState={rows:[],config:null,recentActions:[],sections:{reject:true,review:true,pass:false},query:''};
```

3b. Insert the new helpers directly ABOVE `function pfRender(` :

```js
// --- Sectioned list (2026-07-19). Search matches name/SKU/handle substring;
// sections group by verdict with counts; Passing starts collapsed.
function pfMatch(r,q){
  if(!q) return true;
  var hay=((r.name||'')+' '+(r.sku||'')+' '+(r.handle||'')).toLowerCase();
  return hay.indexOf(q)!==-1;
}
function pfGroup(rows){
  var g={reject:[],review:[],pass:[]};
  for(var i=0;i<rows.length;i++){ var v=rows[i].verdict; (g[v]||g.pass).push(rows[i]); }
  return g;
}
function pfTableHtml(rows){
  var s='<div class="pf-tablewrap"><table class="pf-table"><thead><tr>'
    +'<th class="pf-c-prod">Product</th>'
    +'<th class="pf-c-act">Decision</th>'
    +'<th class="pf-c-price pf-num">PDP</th>'
    +'<th class="pf-c-price pf-num">CJ</th>'
    +'<th class="pf-c-comp pf-num">Competitor</th>'
    +'<th class="pf-c-price pf-num">Net</th>'
    +'<th class="pf-c-when">Processed</th>'
    +'<th class="pf-c-arch" aria-label="Actions"></th>'
    +'</tr></thead><tbody>';
  for(var i=0;i<rows.length;i++) s+=pfRowTr(rows[i]);
  return s+'</tbody></table></div>';
}
function pfSectionHtml(key,title,rows){
  var open=!!pfState.sections[key];
  var s='<div class="pf-sec"><a href="#" class="pf-sec-h" data-k="'+key+'" onclick="return pfToggleSection(this)">'
    +(open?'&#9662;':'&#9656;')+' '+title+' ('+rows.length+')</a>';
  if(open&&rows.length) s+=pfTableHtml(rows);
  return s+'</div>';
}
function pfToggleSection(a){
  var k=a.getAttribute('data-k');
  pfState.sections[k]=!pfState.sections[k];
  pfRender(); return false;
}
function pfSearch(v){ pfState.query=(v||'').trim(); pfRender(); }
```

3c. Replace the `var box=el('pf-list'); if(box){ ... }` block inside `pfRender` (currently lines ~127-156, the `all/need/rows/showAll` logic and both footer links) with:

```js
  var box=el('pf-list');
  if(box){
    var all=pfState.rows;
    if(!all.length){ box.innerHTML='<p class="muted">No decisions yet. The agent repopulates this list as it walks the catalog (or click Run now).</p>'; }
    else{
      var q=pfState.query.toLowerCase();
      var vis=[]; for(var k=0;k<all.length;k++){ if(pfMatch(all[k],q)) vis.push(all[k]); }
      var g=pfGroup(vis);
      var s=pfSectionHtml('reject','Rejected',g.reject)
        +pfSectionHtml('review','Flagged',g.review)
        +pfSectionHtml('pass','Passing',g.pass);
      if(q&&!vis.length) s+='<p class="muted" style="margin-top:8px">No products match "'+esc(pfState.query)+'".</p>';
      box.innerHTML=s;
    }
  }
```

3d. DELETE line 159 `function pfToggleAll(){ ... }` entirely.

- [ ] **Step 4: Implement `src/console/views/profit.ts`** —

4a. Directly above `<div id="pf-list">` (line 49) insert:

```html
    <div class="row" style="margin:0 0 8px">
      <input type="search" id="pf-search" placeholder="Search product, SKU or handle" oninput="pfSearch(this.value)" style="max-width:320px">
    </div>
```

(The input lives OUTSIDE `#pf-list` so re-renders never steal focus or wipe the query.)

4b. In the CSS block (after the `.pf-tablewrap` rule ~line 99) add:

```css
  .pf-sec{margin-top:10px}
  .pf-sec-h{display:block;font-weight:650;font-size:13px;color:inherit;text-decoration:none;padding:6px 0;border-bottom:1px solid var(--border)}
  .pf-sec-h:hover,.pf-sec-h:focus{text-decoration:underline}
```

- [ ] **Step 5: Node smoke of the browser JS** — write `scratchpad/pf-sections-smoke.mjs` (session scratchpad, NOT the repo):

```js
import { readFileSync } from 'node:fs';
const src = readFileSync('src/console/profit-js.ts', 'utf8');
const lit = src.slice(src.indexOf('`') + 1, src.lastIndexOf('`')).replace(/\\\\/g, '\\');
const dom = {};
global.el = (id) => dom[id] ?? (dom[id] = { innerHTML: '', textContent: '', value: '' });
global.esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
global.api = async () => ({ ok: true });
global.setMsg = () => {};
global.prtArm = () => {};
// Indirect eval: ESM is strict mode, so a direct eval would keep the literal's
// function declarations trapped in eval scope. (0, eval) runs them globally.
(0, eval)(lit);
const rows = [
  { cjPid: 'A', verdict: 'reject', name: 'Cat Tower <XL>', sku: 'CT1', handle: 'cat-tower' },
  { cjPid: 'B', verdict: 'review', name: 'Dog Bottle', sku: 'DB1', handle: 'dog-bottle' },
  { cjPid: 'C', verdict: 'pass', name: 'Dog Bed', sku: 'DBED', handle: 'dog-bed' },
];
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
const g = pfGroup(rows);
assert(g.reject.length === 1 && g.review.length === 1 && g.pass.length === 1, 'three-way grouping');
assert(pfMatch(rows[1], 'db1') && !pfMatch(rows[1], 'zzz'), 'search matches sku, rejects miss');
pfState.rows = rows; pfState.query = ''; pfState.sections = { reject: true, review: true, pass: false };
pfRender();
const html = dom['pf-list'].innerHTML;
assert(html.includes('Rejected (1)') && html.includes('Flagged (1)') && html.includes('Passing (1)'), 'headers + counts');
assert(html.includes('Cat Tower &lt;XL&gt;'), 'row rendered escaped in open section');
assert(!html.includes('Dog Bed'), 'collapsed Passing renders no rows');
pfState.query = 'dog bottle'; pfRender();
const h2 = dom['pf-list'].innerHTML;
assert(h2.includes('Rejected (0)') && h2.includes('Flagged (1)'), 'search narrows counts');
pfState.query = 'nomatch"><img>'; pfRender();
assert(dom['pf-list'].innerHTML.includes('&quot;&gt;&lt;img&gt;'), 'hostile query escaped in empty-state');
console.log('pf sections smoke: all green');
```

Run: `node <scratchpad>/pf-sections-smoke.mjs` from the repo root. Expected: `pf sections smoke: all green`. (This eval is also the syntax check for the edited literal.)

- [ ] **Step 6: Run the console tests to PASS** — `npx vitest run tests/console.test.ts` → all green including Step 1's assertions.

- [ ] **Step 7: tsc** — `npx tsc --noEmit` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/console/profit-js.ts src/console/views/profit.ts tests/console.test.ts
git commit -m "feat(console): Products list sections (Rejected/Flagged/Passing) + search"
```

---

### Task 3: Verification sweep + deploy readiness

**Files:** none new.

- [ ] **Step 1: Affected-file batch** — `npx vitest run tests/profit-console.test.ts tests/console.test.ts tests/tenant-store.test.ts tests/profit-agent.test.ts` → all green.
- [ ] **Step 2: Bundle dry-run** — `npx wrangler deploy --dry-run` → bundles clean.
- [ ] **Step 3: Push** — `git push` (auto-push policy).
- [ ] **Step 4: Deploy on owner go** — `npx wrangler deploy`, then verify the served `/app` bundle contains `pfToggleSection` and `pf-search` and NOT `pfToggleAll` (fetch worker code, grep), and probe `/app` = 200.
