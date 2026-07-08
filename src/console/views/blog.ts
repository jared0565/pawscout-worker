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
  </section>

  <section class="card">
    <h2>Drafted posts</h2>
    <div id="blg-list">Loading…</div>
  </section>`;
