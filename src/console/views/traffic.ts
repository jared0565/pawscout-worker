// Traffic view (2026-07-05): the acquisition strategy board. One row per
// channel with its working state, priority and the single next action, stored
// in D1 so strategy work survives sessions. First open seeds a starter
// strategy grounded in what the store already runs (campaigns, partner trials,
// the catalog); every field is editable from here.
export const trafficView = `  <section class="card" id="trf-quality-card">
    <h2>Traffic quality</h2>
    <p class="sub" style="margin:0 0 10px">Shopify's own session table, split by what the browser calls itself. <strong>Automated</strong> names itself as a bot or headless browser. <strong>Engaged</strong> is a human-looking browser that viewed more than one page. <strong>Single-page</strong> is a human-looking browser that viewed one page: a real one-page visit and a bot with a normal user agent look identical here, so it is counted, not blamed on shoppers. The "human-looking" bounce rate leaves the automated traffic out; Shopify's own figure includes it.</p>
    <div id="trf-quality">Loading…</div>
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
  .trf-q-win{padding:10px 0;border-bottom:1px solid var(--border)}
  .trf-q-win:last-child{border-bottom:0}
  .trf-q-title{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--subdued);margin-bottom:8px}
  .trf-q-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .trf-q-kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
  .trf-q-kpi .num{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .trf-q-kpi .sub{font-size:12px;color:var(--subdued)}
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
