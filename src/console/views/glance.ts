// Glance view (Phase 3): the console's landing view - a KPI strip, the
// "Needs your attention" queue, the activity feed, system health, and market
// availability, all filled from ONE aggregate call (/api/glance) by
// ../glance-js.ts. The skeleton here is static mount points only; every number
// rendered into them is a real D1 fact from the aggregate (attention rows and
// panels simply don't render when their underlying data doesn't exist).
export const glanceView = `  <section class="gl">
    <header class="gl-head">
      <h2>Shop at a Glance</h2>
      <span id="gl-date" class="muted" style="font-size:13px"></span>
      <span class="gl-spacer"></span>
      <span id="gl-auto-pill" class="ibx-pill" title="Reply mode - change in Settings">Manual review</span>
      <button type="button" class="ghost" onclick="loadGlance()">Refresh</button>
    </header>
    <div id="gl-kpis" class="gl-kpis"><p class="muted">Loading…</p></div>
    <div class="gl-cols">
      <div class="gl-col">
        <section class="gl-panel">
          <h3>Needs your attention</h3>
          <div id="gl-attn"><p class="gl-empty">Loading…</p></div>
        </section>
        <section class="gl-panel">
          <h3>Market availability, reconciled nightly</h3>
          <div id="gl-markets"><p class="gl-empty">Loading…</p></div>
        </section>
      </div>
      <div class="gl-col">
        <section class="gl-panel">
          <h3>Activity</h3>
          <div id="gl-activity"><p class="gl-empty">Loading…</p></div>
        </section>
        <section class="gl-panel">
          <h3>System health</h3>
          <div id="gl-health"><p class="gl-empty">Loading…</p></div>
        </section>
      </div>
    </div>
    <p id="gl-msg" class="msg muted"></p>
  </section>`;

// Namespaced (.gl-*) CSS, composed after inboxCss in page.ts. Same forced-dark
// palette; the KPI flag colors reuse the ok/no tokens plus an amber for "warn"
// (matches the inbox draft-ready chip color).
export const glanceCss = `
  /* --- Glance (Phase 3): landing dashboard --- */
  .gl-head{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
  .gl-head h2{font-size:18px;font-weight:650;margin:0}
  .gl-spacer{flex:1 1 auto}
  .gl-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
  .gl-kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;border-left:3px solid transparent;box-shadow:0 1px 2px var(--shadow)}
  .gl-kpi .lbl{font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--subdued)}
  .gl-kpi .num{font-size:24px;font-weight:700;margin:4px 0 2px;font-variant-numeric:tabular-nums}
  .gl-kpi .sub{font-size:12px;color:var(--subdued)}
  .gl-kpi.warn{border-left-color:#d3a133}
  .gl-kpi.crit{border-left-color:var(--no-ink)}
  .gl-kpi.ok{border-left-color:var(--ok-ink)}
  .gl-cols{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;align-items:start}
  @media(max-width:980px){.gl-cols{grid-template-columns:1fr}}
  .gl-col{display:flex;flex-direction:column;gap:16px;min-width:0}
  .gl-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 1px 2px var(--shadow)}
  .gl-panel h3{margin:0;padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--subdued);border-bottom:1px solid var(--border)}
  .gl-attn-row{display:flex;align-items:center;gap:12px;padding:11px 16px 11px 13px;border-bottom:1px solid var(--border);border-left:3px solid transparent}
  .gl-attn-row:last-child{border-bottom:0}
  .gl-attn-row.crit{border-left-color:var(--no-ink)}
  .gl-attn-row.warn{border-left-color:#d3a133}
  .gl-attn-row.info{border-left-color:#6ba3d8}
  .gl-attn-row .what{min-width:0;flex:1 1 auto}
  .gl-attn-row .t{font-weight:650;font-size:13.5px;display:block}
  .gl-attn-row .d{color:var(--subdued);font-size:12.5px}
  .gl-attn-row button{margin-left:auto;flex:0 0 auto}
  .gl-feed-row{display:flex;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:baseline}
  .gl-feed-row:last-child{border-bottom:0}
  .gl-feed-row time{flex:0 0 74px;color:var(--subdued);font-size:11px;font-variant-numeric:tabular-nums}
  .gl-feed-row .who{font-weight:600;word-break:break-all}
  .gl-kv{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;padding:6px 16px}
  .gl-kv:first-of-type{padding-top:12px}
  .gl-kv:last-of-type{padding-bottom:12px}
  .gl-kv .k{color:var(--subdued)}
  .gl-market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--border)}
  .gl-market-cell{background:var(--surface);padding:12px 14px}
  .gl-market-cell .num{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
  .gl-market-cell .sub{font-size:11.5px;color:var(--subdued)}
  .gl-empty{padding:14px 16px;color:var(--subdued);font-size:13px;margin:0}
`;
