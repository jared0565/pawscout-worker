// Answer library: its own top-level console page (2026-07-13). Previously a
// collapsed <details> crammed under the fixed-height inbox workspace, where the
// 320px-capped, 3-column, truncated grid made the vetted answers unreadable.
// This is a normal scrolling .view (not the inbox's 100vh/overflow:hidden
// layout), so the list can breathe: full question + full answer per card, plus
// a client-side search. Data + toggle wiring live in ../answers-js.ts.
export const answersView = `
  <div class="ans-head">
    <h1>Answer library</h1>
    <p class="sub">Every reply you approve is remembered as the customer's question and your vetted answer. When a similar question arrives - even reworded - the drafter is grounded with the closest approved answers so replies stay consistent; live facts always override them, and personal details are never copied across customers. Disable a pair to pull a bad or outdated answer out of recall; approving a new reply to the same question replaces and re-enables it. History imports automatically on the first sweep.</p>
  </div>
  <div class="card">
    <div class="ans-toolbar">
      <input id="ans-search" type="search" placeholder="Search remembered questions and answers" aria-label="Search the answer library" oninput="ansFilter()">
      <span id="ans-count" class="muted"></span>
      <button type="button" class="ghost" onclick="ansLoad()">Refresh</button>
    </div>
    <div id="ans-list"><p class="muted">Loading…</p></div>
    <p id="ans-msg" class="msg muted"></p>
  </div>`;

// Scoped .ansp-* / #ans-* so nothing collides with the inbox workspace CSS.
export const answersCss = `
  /* --- Answer library (own page) --- */
  #view-answers .ans-head{margin-bottom:14px}
  #view-answers .ans-head h1{font-size:22px;font-weight:680;margin:0 0 6px}
  #view-answers .ans-head .sub{max-width:760px;font-size:13px;color:var(--subdued);margin:0}
  .ans-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .ans-toolbar #ans-search{flex:1 1 320px;min-width:220px;padding:9px 12px;font-size:13.5px}
  .ans-toolbar #ans-count{font-size:12.5px;white-space:nowrap}
  #ans-list{display:flex;flex-direction:column;gap:12px}
  .ansp-card{border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--surface)}
  .ansp-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .ansp-cat{display:inline-block;font-size:10.5px;font-weight:680;letter-spacing:.03em;text-transform:uppercase;border-radius:8px;padding:2px 8px;background:rgba(88,166,255,.16);color:#58a6ff}
  .ansp-meta{font-size:11.5px;color:var(--subdued)}
  .ansp-spacer{flex:1 1 auto}
  .ansp-q{font-size:13.5px;font-weight:600;color:var(--ink);margin:0 0 6px;overflow-wrap:anywhere}
  .ansp-q .ansp-label,.ansp-a .ansp-label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--subdued);margin-bottom:2px}
  .ansp-a{font-size:13px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
  .ansp-card.off{opacity:.6}
  .ansp-card.off .ansp-q,.ansp-card.off .ansp-a{text-decoration:line-through;text-decoration-color:var(--subdued)}
  .ansp-empty{color:var(--subdued);padding:24px 4px}
`;
