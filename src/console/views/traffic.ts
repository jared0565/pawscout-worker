// Traffic view (2026-07-05): the acquisition strategy board. One row per
// channel with its working state, priority and the single next action, stored
// in D1 so strategy work survives sessions. First open seeds a starter
// strategy grounded in what the store already runs (campaigns, partner trials,
// the catalog); every field is editable from here.
export const trafficView = `  <section class="card" id="trf-activity-card">
    <div class="trf-a-head">
      <h2>Traffic activity</h2>
      <div class="trf-range" role="group" aria-label="Date range">
        <button type="button" class="trf-range-btn" data-trf-days="7">7 days</button>
        <button type="button" class="trf-range-btn active" data-trf-days="30">30 days</button>
        <button type="button" class="trf-range-btn" data-trf-days="90">90 days</button>
      </div>
    </div>
    <div id="trf-activity"><p class="muted">Loading the charts…</p></div>
    <details class="trf-how">
      <summary>How visits are counted</summary>
      <p class="sub">From Shopify's own session table, day by day in the shop's time zone. A visit is <strong>automated</strong> when Shopify labels it a bot or the browser names itself as automation (a headless browser, a crawler, a script): each signal misses some that the other catches (measured 7 Oct 2026: over the previous 90 days Shopify called 96 headless browser visits "human" and 101 ordinary Chrome visits "bot"). Every other visit is counted as a <strong>person</strong>: <strong>engaged</strong> when it viewed more than one page, <strong>single-page</strong> when it viewed one. A person here means "not provably automated": a bot with a normal browser looks the same, and the store's own visits in an ordinary browser count too. Cart and checkout counts are people only, named as Shopify names them.</p>
    </details>
  </section>

  <section class="card">
    <h2>Traffic</h2>
    <p class="sub" style="margin:0 0 10px">The acquisition strategy board: every channel you could win visitors from, its state, and the one next action that moves it. Statuses: <strong>idea</strong> (not started), <strong>testing</strong> (running small), <strong>active</strong> (working, keep feeding), <strong>paused</strong> (deliberately parked). Priority 1 means work on it now, 5 means someday. Click a channel to edit it.</p>
    <div id="trf-list">Loading the board…</div>
    <p id="trf-msg" class="msg muted"></p>
  </section>

  <section class="card" id="trf-editor-card" hidden>
    <h2 id="trf-editor-title">Edit channel</h2>
    <input type="hidden" id="trf-id">
    <div class="row">
      <div class="grow">
        <label for="trf-name">Channel</label>
        <input id="trf-name" type="text" maxlength="120" placeholder="e.g. Google free product listings">
      </div>
      <div>
        <label for="trf-status">Status</label>
        <select id="trf-status">
          <option value="idea">Idea</option>
          <option value="testing">Testing</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </select>
      </div>
      <div>
        <label for="trf-priority">Priority</label>
        <select id="trf-priority">
          <option value="1">1 (now)</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5 (someday)</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="trf-rationale">Why this channel</label>
        <textarea id="trf-rationale" rows="2" maxlength="600"></textarea>
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="trf-next">Next action (one step)</label>
        <input id="trf-next" type="text" maxlength="400">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="trf-notes">Notes / results</label>
        <textarea id="trf-notes" rows="3" maxlength="1000" placeholder="What happened when you tried it: numbers, dates, verdicts."></textarea>
      </div>
    </div>
    <div class="row">
      <button type="button" onclick="trfSave()">Save channel</button>
      <button type="button" class="ghost" onclick="trfCloseEditor()">Close</button>
      <button type="button" class="ghost" id="trf-delete-btn" onclick="trfDelete(this)">Delete</button>
    </div>
    <p id="trf-editor-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Add a channel</h2>
    <p class="sub" style="margin:0 0 10px">Anything that could bring visitors: a platform, a partnership type, a content play. Add it as an idea with the first step you would take, then promote it to testing when you start.</p>
    <div class="row">
      <button type="button" onclick="trfNew()">New channel</button>
    </div>
  </section>`;

// Namespaced (.trf-*) styles, composed alongside the other view CSS in page.ts.
export const trafficCss = `
  /* --- Traffic view: strategy board rows + status chips --- */
  .trf-row{padding:12px 4px;border-bottom:1px solid var(--border);cursor:pointer}
  .trf-row:hover{background:rgba(232,89,12,.06)}
  .trf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .trf-name{font-weight:600;color:var(--ink)}
  .trf-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  /* --- Traffic activity: range control, KPI strip, daily SVG charts, rankings --- */
  .trf-a-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  .trf-a-head h2{margin:0}
  .trf-range{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .trf-range-btn{background:transparent;color:var(--subdued);border:0;border-radius:0;padding:6px 12px;font-size:13px;font-weight:600}
  .trf-range-btn+.trf-range-btn{border-left:1px solid var(--border)}
  .trf-range-btn.active{background:var(--ink);color:var(--bg)}
  .trf-caption{font-size:12px;color:var(--subdued);margin:0 0 12px}
  .trf-q-title{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--subdued);margin:18px 0 6px}
  .trf-q-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .trf-q-kpi{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
  .trf-q-kpi .num{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .trf-q-kpi .sub{font-size:12px;color:var(--subdued)}
  .trf-chart svg{display:block;width:100%;height:auto}
  .trf-chart text{fill:var(--subdued);font-size:11px;font-family:inherit}
  .trf-chart .trf-grid{stroke:var(--border);stroke-width:1}
  .trf-chart .trf-col:hover rect.trf-hit{fill:rgba(227,227,227,.07)}
  .trf-chart .trf-today rect.trf-seg{opacity:.5}
  .trf-chart .trf-mark{fill:#f0c674}
  .trf-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--subdued);margin-top:4px}
  .trf-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .trf-legend i.dot{border-radius:50%}
  .trf-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
  .trf-rank-row{display:grid;grid-template-columns:minmax(0,1fr) 40px;gap:8px;align-items:center;padding:4px 0;font-size:13px}
  .trf-rank-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
  .trf-rank-bar{grid-column:1 / -1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden;margin-top:-2px}
  .trf-rank-bar b{display:block;height:100%;background:#8fe0a6;border-radius:3px}
  .trf-rank-n{text-align:right;font-variant-numeric:tabular-nums;color:var(--subdued)}
  .trf-how{margin-top:16px}
  .trf-how summary{cursor:pointer;color:var(--subdued);font-size:13px}
  .trf-how p{margin-top:8px}
  .trf-idea{background:rgba(139,148,158,.18);color:var(--subdued)}
  .trf-testing{background:rgba(232,89,12,.16);color:#f0854b}
  .trf-active{background:rgba(63,185,80,.15);color:#3fb950}
  .trf-paused{background:rgba(139,148,158,.28);color:var(--subdued)}
  .trf-prio{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .trf-next{margin-top:6px;color:var(--subdued);font-size:13px}
  .trf-next strong{color:var(--ink);font-weight:600}
  #view-traffic select{padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:14px;font-family:inherit}
  #view-traffic textarea{width:100%;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:14px;font-family:inherit;resize:vertical}
  #view-traffic textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
`;
