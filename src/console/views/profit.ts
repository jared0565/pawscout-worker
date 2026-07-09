// Profitability agent view (2026-07-09): the window into the ACTIVE adjust-or-drop
// agent that runs every 15 minutes on live Shopify numbers. Ships DORMANT - the
// Enabled switch arms it, and it starts in Preview (dry-run) so the owner sees what
// full-auto would do before it can act. Uncheck Preview to go live. Enforce
// (hardBlock) additionally hard-rejects per-unit money-losers at import. Numeric
// thresholds live in tenant_config.profit (documented here). Same *-js
// template-literal rules as the other views.
export const profitView = `  <section class="card">
    <h2>Profitability agent</h2>
    <p class="sub" style="margin:0 0 12px">A background agent that runs every 15 minutes. For each product it reads your LIVE Shopify price and landed cost, researches the typical delivered price at UK sellers (item + postage), then acts on real numbers: it RAISES or lowers your price to sit just under the market while keeping at least the net-profit floor, and DROPS (archives, never deletes) anything that cannot clear the floor at any sensible price. Every move is logged below.</p>

    <div class="pf-switches">
      <label class="pf-switch"><input type="checkbox" id="pf-enabled" onchange="pfSetFlag('enabled',this.checked)"> <span><strong>Enabled</strong> - run the agent (off = fully dormant, nothing changes)</span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-dryrun" checked onchange="pfSetFlag('dryRun',this.checked)"> <span><strong>Preview only</strong> - show what it WOULD do without touching prices or listings. Uncheck to go full auto.</span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-hardblock" onchange="pfSetFlag('hardBlock',this.checked)"> <span><strong>Enforce at import</strong> - also hard-reject a per-unit money-loser when a NEW product is imported</span></label>
    </div>
    <div class="pf-tune">
      <label for="pf-adshare"><strong>Ad share</strong> - the blended % of revenue spent on ads across ALL traffic (organic, repeat and affiliate sales carry no ad cost, so they pull this down). This is the biggest lever on what counts as profitable.</label>
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
    <h2>Products</h2>
    <p class="sub" style="margin:0 0 10px">Worst first. Each row shows the agent's latest decision and the market it was judged against. <strong>Dropped</strong> = archived, cannot profit; <strong>Repriced</strong> = moved to just under the market; <strong>Flagged</strong> = your call (soft market signal). Archiving from here is a manual one-click fallback and asks to confirm; it never deletes.</p>
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
`;
