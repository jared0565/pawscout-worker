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
`;

export const blogView = `  <section class="card">
    <h2>Content</h2>
    <p class="sub" style="margin:0 0 10px">The blog agents research an angle, write a grounded guide from your real products, and stage it as a <strong>draft</strong> for you to review and publish in Shopify. Nothing is published automatically. Leave the topic blank to let the research agent choose, or nudge it with one.</p>
    <div class="blg-gen-row">
      <input id="blg-topic" type="text" maxlength="300" placeholder="Optional topic, e.g. winter paw care for dogs">
      <button type="button" id="blg-gen-btn" onclick="blogGenerate()">Draft a new post</button>
    </div>
    <p id="blg-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Drafted posts</h2>
    <div id="blg-list">Loading…</div>
  </section>`;
