// Content view (2026-07-07): the blog channel's console surface. The owner
// triggers the blog agents (research -> ground -> draft) to author ONE post,
// which the system stages as a Shopify DRAFT for review. Never auto-publishes.
export const blogCss = `
  .blg-gen-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}
  .blg-gen-row input{flex:1 1 260px;min-width:0;padding:9px 12px;border:1px solid var(--field-border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--field-bg,transparent);color:var(--ink)}
  .blg-item{border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:8px 0}
  .blg-item-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .blg-item-title{font-weight:650}
  .blg-flags{color:var(--no-ink);font-size:13px;margin-top:6px}
  .blg-meta{color:var(--subdued);font-size:12px;margin-top:4px}
  .blg-actions{margin-top:8px}
  .blg-actions button{padding:6px 12px;font-size:13px;font-family:inherit;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--ink);cursor:pointer}
  .blg-actions button:hover{border-color:var(--ink)}
  .blg-suggest-sel{flex:1 1 320px;min-width:0;padding:9px 12px;border:1px solid var(--field-border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--field-bg,transparent);color:var(--ink)}
  .blg-demand{margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px}
  .blg-demand-list{margin:6px 0 0;padding-left:20px;font-size:13px}
  .blg-demand-list li{margin-bottom:7px}
  .blg-demand-list a{color:var(--subdued)}
  .syd-ch{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:8px 0 2px}
  .syd-ch-box{border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
  .syd-ch-box strong{text-transform:capitalize}
  .syd-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .syd-q{background:rgba(139,148,158,.22);color:var(--subdued)}
  .syd-sent{background:rgba(88,166,255,.16);color:#58a6ff}
  .syd-pub{background:rgba(63,185,80,.15);color:#3fb950}
  .syd-fail{background:rgba(248,81,73,.16);color:#f85149}
  .syd-cap{color:var(--subdued);font-size:12.5px;margin-top:5px;white-space:normal;overflow-wrap:anywhere}
  .syd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
`;

export const blogView = `  <section class="card">
    <h2>Content</h2>
    <p class="sub" style="margin:0 0 10px">The blog agents research an angle, write a grounded guide from your real products, and stage it as a <strong>draft</strong> for you to review and publish in Shopify. Nothing is published automatically. Click <strong>Suggest topics</strong> for researched ideas that are each already backed by in-stock products, or just type your own.</p>
    <div class="blg-gen-row">
      <button type="button" id="blg-suggest-btn" onclick="blogSuggest()">Suggest topics</button>
      <select id="blg-suggest" class="blg-suggest-sel" onchange="blogPickSuggested()" style="display:none" aria-label="Suggested topics"></select>
    </div>
    <div class="blg-gen-row">
      <input id="blg-topic" type="text" maxlength="300" placeholder="Pick a suggestion above, or type your own topic" oninput="blgTopicEdited()">
      <button type="button" id="blg-gen-btn" onclick="blogGenerate()">Draft a new post</button>
    </div>
    <p id="blg-msg" class="msg muted"></p>
    <div id="blg-demand" class="blg-demand" style="display:none"></div>
  </section>

  <section class="card">
    <h2>Drafted posts</h2>
    <div id="blg-list">Loading…</div>
  </section>

  <section class="card">
    <h2>Distribution</h2>
    <p class="sub" style="margin:0 0 10px">When you publish a guide, the worker writes channel copy and queues it here. Every channel starts <strong>manual</strong>: you review and click Send per channel, and flip a channel to <strong>Auto</strong> once you trust it (the same ramp as the profitability agent). Links carry per-channel UTM tags so Shopify analytics shows what each channel brings. No prices ever appear in the copy - pins live for months while prices move every 15 minutes.</p>
    <div id="syd-channels" class="syd-ch">Loading channels…</div>
    <div class="row" style="margin:6px 0 10px">
      <button type="button" onclick="sydAccounts(this)">Load connected accounts</button>
      <span class="muted" style="align-self:center;font-size:12px">Reads your Blotato connections so you can pick the Pinterest board and Facebook page instead of copying ids.</span>
    </div>
    <p id="syd-msg" class="msg muted"></p>
    <div id="syd-list">No published guides yet. Publish one and it appears here within 15 minutes.</div>
  </section>`;
