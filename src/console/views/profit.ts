// Profitability view (2026-07-09): the window into the observe-first profit
// audit. Ships DORMANT - the two switches below arm it. Observe (enabled)
// populates this table and imports sub-floor products as review drafts;
// Enforce (hardBlock) then hard-rejects per-unit money-losers at import. The
// numeric thresholds live in tenant_config.profit (documented here); this view
// only flips the two switches, runs a batch, and archives ONE product on
// explicit owner confirm. Same *-js template-literal rules as the other views.
export const profitView = `  <section class="card">
    <h2>Profitability</h2>
    <p class="sub" style="margin:0 0 12px">Is each product actually there to make real net profit? This audit values every product at its live rule price, subtracts landed cost, ads (a share of revenue), payment fees and a refund reserve, and checks it against typical UK street prices. It runs nightly and never archives on its own - it flags, you decide.</p>

    <div class="pf-switches">
      <label class="pf-switch"><input type="checkbox" id="pf-enabled" onchange="pfSetFlag('enabled',this.checked)"> <span><strong>Observe</strong> - run the audit and flag sub-floor products as review drafts (no rejections)</span></label>
      <label class="pf-switch"><input type="checkbox" id="pf-hardblock" onchange="pfSetFlag('hardBlock',this.checked)"> <span><strong>Enforce</strong> - hard-reject a per-unit money-loser at import (turn on only after reviewing the observe results)</span></label>
    </div>
    <p class="sub" id="pf-thresholds" style="margin:10px 0 0"></p>
    <div class="row" style="margin-top:12px">
      <button type="button" onclick="pfRunAudit(this)">Run audit now</button>
      <span id="pf-summary" class="muted" style="align-self:center"></span>
    </div>
    <p id="pf-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Flagged products</h2>
    <p class="sub" style="margin:0 0 10px">Worst first. <strong>Reject</strong> = loses money per unit or clearly priced above the UK market; <strong>Review</strong> = possibly above market (soft signal). Archiving is one click and asks you to confirm - it never deletes.</p>
    <div id="pf-list">Turn on Observe and run the audit to see verdicts.</div>
  </section>`;

export const profitCss = `
  /* --- Profitability view --- */
  .pf-switches{display:flex;flex-direction:column;gap:10px;margin:6px 0 0}
  .pf-switch{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:var(--ink);cursor:pointer}
  .pf-switch input{margin-top:3px;flex:0 0 auto}
  .pf-switch span{color:var(--subdued)}
  .pf-switch strong{color:var(--ink)}
  .pf-row{padding:11px 4px;border-bottom:1px solid var(--border)}
  .pf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .pf-name{font-weight:600;color:var(--ink);word-break:break-word}
  .pf-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .pf-reject{background:rgba(248,81,73,.16);color:#f85149}
  .pf-review{background:rgba(232,89,12,.16);color:#f0854b}
  .pf-pass{background:rgba(63,185,80,.15);color:#3fb950}
  .pf-arch{background:rgba(139,148,158,.28);color:var(--subdued)}
  .pf-net{margin-left:auto;font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
  .pf-net.neg{color:#f85149}
  .pf-net.pos{color:var(--subdued)}
  .pf-meta{margin-top:5px;color:var(--subdued);font-size:13px}
  .pf-meta strong{color:var(--ink);font-weight:600}
  .pf-actions{margin-top:7px;display:flex;gap:8px;flex-wrap:wrap}
`;
