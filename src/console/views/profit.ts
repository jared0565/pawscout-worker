// Profitability agent view (2026-07-09): the window into the ACTIVE adjust-or-drop
// agent that runs every 15 minutes on live Shopify numbers. Ships DORMANT - the
// Enabled switch arms it, and it starts in Preview (dry-run) so the owner sees what
// full-auto would do before it can act. Uncheck Preview to go live. Enforce
// (hardBlock) additionally hard-rejects per-unit money-losers at import. Numeric
// thresholds live in tenant_config.profit (documented here). Same *-js
// template-literal rules as the other views.
export const profitView = `  <section class="card">
    <h2>Profitability agent <button type="button" class="prt-info" onclick="openPartnerInfo(this)" data-prt-help="pf-help-agent" data-prt-help-title="How the profitability agent works" aria-label="How the profitability agent works">?</button></h2>
    <div id="pf-help-agent" hidden>
      <p>A background agent that runs every 15 minutes. For each product it reads your LIVE Shopify price and landed cost, researches the typical delivered price at UK sellers (item + postage), then acts on real numbers: it RAISES or lowers your price to sit just under the market while keeping at least the net-profit floor, and DROPS (archives, never deletes) anything that cannot clear the floor at any sensible price. Every move is logged in Recent actions.</p>
      <p><strong>Enabled</strong> - run the agent. Off = fully dormant, nothing changes.</p>
      <p><strong>Preview only</strong> - show what it WOULD do without touching prices or listings. Uncheck to go full auto.</p>
      <p><strong>Enforce at import</strong> - also hard-reject a per-unit money-loser when a NEW product is imported.</p>
      <p><strong>Competition check at import</strong> - before a NEW product enters, also research the market's delivered price and stop anything that could only compete below the net floor (one cached lookup per import; the agent reuses it later, so this costs nothing extra overall).</p>
      <p><strong>Ad share</strong> - the blended % of revenue spent on ads across ALL traffic (organic, repeat and affiliate sales carry no ad cost, so they pull this down). This is the biggest lever on what counts as profitable.</p>
    </div>
    <p class="sub" style="margin:0 0 12px">Runs every 15 minutes on your live prices, costs and the market; every move is logged below.</p>

    <div class="pf-switches">
      <label class="pf-switch"><input type="checkbox" id="pf-enabled" onchange="pfSetFlag('enabled',this.checked)"> <span><strong>Enabled</strong> - run the agent</span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-dryrun" checked onchange="pfSetFlag('dryRun',this.checked)"> <span><strong>Preview only</strong> - log, don't act</span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-hardblock" onchange="pfSetFlag('hardBlock',this.checked)"> <span><strong>Enforce at import</strong></span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-compimport" onchange="pfSetFlag('competitionCheckOnImport',this.checked)"> <span><strong>Competition check at import</strong></span></label>
    </div>
    <div class="pf-tune">
      <label for="pf-adshare"><strong>Ad share</strong> - blended % of revenue spent on ads (the biggest lever)</label>
      <div class="pf-tune-row">
        <input type="number" id="pf-adshare" min="0" max="60" step="1" onchange="pfSetAdShare(this.value)"> <span class="pf-unit">% of revenue</span>
        <span id="pf-adshare-hint" class="muted"></span>
      </div>
    </div>
    <div id="pf-banner" class="pf-banner" hidden></div>
    <p class="sub" id="pf-thresholds" style="margin:10px 0 0"></p>
    <div class="row" style="margin-top:12px">
      <button type="button" onclick="pfRunNow(this)">Run now</button>
      <span id="pf-summary" class="muted" style="align-self:center"></span>
    </div>
    <p id="pf-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Products <button type="button" class="prt-info" onclick="openPartnerInfo(this)" data-prt-help="pf-help-products" data-prt-help-title="How to read this list" aria-label="How to read this list">?</button></h2>
    <div id="pf-help-products" hidden>
      <p>Grouped worst first: <strong>Rejected</strong>, then <strong>Flagged</strong>, with <strong>Passing</strong> collapsed underneath (click a section header to open or close it). Each row shows the product (name + SKU), the agent's decision and why, and three prices you can click to review: <strong>PDP</strong> (your storefront price, opens the product page), <strong>CJ</strong> (the supplier item price, opens the product in CJ) and <strong>Competitor</strong> (the market delivered price, opens a search; hover for the confidence and sources). <strong>Dropped</strong> = archived, cannot profit; <strong>Repriced</strong> = moved to just under the market; <strong>Flagged</strong> = your call.</p>
      <p>Your calls on a row: <strong>Keep</strong> pins the product exactly as it is - the agent stops repricing, flagging or dropping it until you Release it. <strong>Wrong match</strong> says the competitor listing is not the same product: that market price is discarded for 90 days and the product is re-judged on cost-plus rules. <strong>Deep check</strong> runs the thorough LLM web read for one product (costs roughly 30p) and re-judges it immediately; the everyday sweep prices from free structured market data instead. <strong>Archive</strong> is the manual one-click fallback and asks to confirm; it never deletes.</p>
      <p><strong>Clear list &amp; re-judge</strong> - wipes every decision AND the cached market prices; the agent re-researches and re-judges the whole catalog over the next few hours. Nothing is archived or repriced by clearing; the action history below is kept.</p>
      <p><strong>Recalibrate &amp; rescue drops</strong> - after a judging-rule change: re-checks every product the agent archived against fresh market prices under the CURRENT rules and brings back whatever now clears them (repriced if needed). What still fails stays archived. Also refreshes the cached market prices for live products (your Wrong-match calls are kept). In Preview it only reports what WOULD come back.</p>
      <p><strong>Restore no-traffic culls</strong> - brings back products the 30-day inactivity cull archived while the store had almost no visitors to measure them by (the cull now stands down automatically in low-traffic windows). Products the agent dropped for economics, or that you archived yourself, are not touched. Restored products are re-judged by the agent as normal.</p>
    </div>
    <div class="row" style="margin:0 0 10px">
      <button type="button" onclick="pfClearDecisions(this)">Clear list &amp; re-judge</button>
      <button type="button" onclick="pfRecalibrate(this)">Recalibrate &amp; rescue drops</button>
      <button type="button" class="ghost" onclick="pfRestoreCulled(this)">Restore no-traffic culls</button>
    </div>
    <div class="row" style="margin:0 0 8px">
      <input type="search" id="pf-search" placeholder="Search product, SKU or handle" oninput="pfSearch(this.value)" style="max-width:320px">
    </div>
    <div id="pf-list">Turn on the agent and run it to see decisions.</div>
  </section>

  <section class="card">
    <h2>Recent actions</h2>
    <p class="sub" style="margin:0 0 10px">The agent's action log, newest first - every price move and drop, with the market that drove it. <em>Preview</em> rows are what full-auto would have done.</p>
    <div id="pf-ledger">No actions yet.</div>
  </section>`;

export const profitCss = `
  /* --- Profitability agent view --- */
  .pf-switches{display:flex;flex-direction:column;gap:10px;margin:6px 0 0}
  .pf-switch{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:var(--ink);cursor:pointer}
  .pf-switch input{margin-top:3px;flex:0 0 auto}
  .pf-switch span{color:var(--subdued)}
  .pf-switch strong{color:var(--ink)}
  .pf-tune{margin:14px 0 0;font-size:14px;color:var(--subdued)}
  .pf-tune label{display:block;margin-bottom:6px}
  .pf-tune label strong{color:var(--ink)}
  .pf-tune-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pf-tune-row input{width:72px;padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--ink);font-variant-numeric:tabular-nums}
  .pf-unit{color:var(--subdued)}
  .pf-banner{margin:12px 0 0;padding:10px 12px;border-radius:9px;font-size:13px;font-weight:600;border:1px solid var(--border)}
  .pf-banner.preview{background:rgba(232,137,12,.12);color:#f0854b;border-color:rgba(232,137,12,.35)}
  .pf-banner.live{background:rgba(63,185,80,.13);color:#3fb950;border-color:rgba(63,185,80,.35)}
  .pf-row{padding:11px 4px;border-bottom:1px solid var(--border)}
  .pf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .pf-name{font-weight:600;color:var(--ink);word-break:break-word}
  .pf-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .pf-reject{background:rgba(248,81,73,.16);color:#f85149}
  .pf-review{background:rgba(232,89,12,.16);color:#f0854b}
  .pf-pass{background:rgba(63,185,80,.15);color:#3fb950}
  .pf-arch{background:rgba(139,148,158,.28);color:var(--subdued)}
  .pf-act{background:rgba(88,166,255,.16);color:#58a6ff}
  .pf-act.dry{background:rgba(139,148,158,.22);color:var(--subdued)}
  .pf-net{margin-left:auto;font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
  .pf-net.neg{color:#f85149}
  .pf-net.pos{color:var(--subdued)}
  .pf-meta{margin-top:5px;color:var(--subdued);font-size:13px}
  .pf-meta strong{color:var(--ink);font-weight:600}
  .pf-actions{margin-top:7px;display:flex;gap:8px;flex-wrap:wrap}
  .pf-led{padding:8px 4px;border-bottom:1px solid var(--border);font-size:13px;color:var(--subdued);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .pf-led .pf-when{color:var(--subdued);font-variant-numeric:tabular-nums;white-space:nowrap}
  .pf-led .pf-what{color:var(--ink);font-weight:600}
  /* --- Products review table: FIXED layout so a long name can never collide
         with the next column (auto-layout ignores cell max-width). The column
         budget is tuned to FIT the console pane (2026-07-12: the old 972px of
         columns pushed the actions off the right edge, with the only scrollbar
         at the very bottom of a tall table); .pf-tablewrap keeps overflow-x as
         the safety net for genuinely narrow panes. --- */
  .pf-tablewrap{overflow-x:auto;margin-top:4px}
  .pf-sec{margin-top:10px}
  .pf-sec-h{display:block;font-weight:650;font-size:13px;color:inherit;text-decoration:none;padding:6px 0;border-bottom:1px solid var(--border)}
  .pf-sec-h:hover,.pf-sec-h:focus{text-decoration:underline}
  .pf-table{table-layout:fixed;width:100%;min-width:872px;border-collapse:collapse;font-size:13px}
  .pf-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--subdued);font-weight:650;padding:8px 8px 6px;border-bottom:1px solid var(--border);white-space:nowrap}
  .pf-table td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top;white-space:nowrap}
  .pf-table tbody tr:last-child td{border-bottom:none}
  .pf-table th.pf-num,.pf-table td.pf-num{text-align:right;font-variant-numeric:tabular-nums}
  /* Fixed column widths (read from the header row); they sum to the min-width. */
  .pf-c-prod{width:200px}
  .pf-c-act{width:112px}
  .pf-c-price{width:86px}
  .pf-c-comp{width:110px}
  .pf-c-when{width:96px}
  .pf-c-arch{width:96px}
  /* Cells that hold long text WRAP and break space-less tokens so nothing spills. */
  td.pf-prod,td.pf-act-cell{white-space:normal;overflow-wrap:anywhere;word-break:break-word}
  /* Row actions: one Actions trigger per row; the items live in the fixed-
     position dropdown below (owner ask 2026-07-12 - cleaner than stacked buttons). */
  td.pf-actions-c{white-space:normal}
  .pf-actions-c .ghost{display:block;width:100%;text-align:center}
  /* position:fixed + viewport clamping in pfOpenMenu keep the menu clear of the
     .pf-tablewrap overflow clip; no console ancestor creates a transform/filter
     containing block, so fixed = viewport here. */
  .pf-menu{position:fixed;z-index:60;min-width:150px;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:6px;box-shadow:0 10px 28px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:4px}
  .pf-menu .ghost{display:block;width:100%;text-align:left}
  .pf-kept{background:rgba(88,166,255,.16);color:#58a6ff}
  .pf-pname{display:block;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
  .pf-sku{display:block;margin-top:2px;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--subdued);overflow-wrap:anywhere}
  .pf-why{margin-top:4px;color:var(--subdued);font-size:12px;line-height:1.35;white-space:normal;overflow-wrap:anywhere}
  .pf-when-c{color:var(--subdued);font-size:12px;white-space:normal}
  .pf-plink{color:#58a6ff;text-decoration:none;font-weight:600}
  .pf-plink:hover{text-decoration:underline}
  .pf-ext{font-size:10px;opacity:.7}
  .pf-conf{display:block;margin-top:1px;color:var(--subdued);font-size:11px;font-weight:400}
  .pf-move{display:block;margin-top:1px;color:var(--subdued);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:normal}
  .pf-nneg{color:#f85149;font-weight:600}
  .pf-npos{color:var(--ink);font-weight:600}
  .pf-none{color:var(--subdued)}
`;
