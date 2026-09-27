// Inbox view (Phase 2 workspace): full-height THREE-PANE mail layout replacing
// the Phase-1 thread-list card + modal.
//   Pane 1 (left, 292px)  - filter chips + scrollable thread rows (#inbox-threads)
//   Pane 2 (center, wide) - conversation header + message timeline + pending-draft card
//   Pane 3 (right, 296px) - context rail: customer block, labels, draft holds,
//                           partnership screening, invoice card/builder (hidden <1100px)
// The three panes are STATIC skeleton; all inbox browser JS that fills them lives
// in ../inbox-js.ts (composed into the single <script> by page.ts). Ids kept from
// Phase 1 where JS/tests depend on them: inbox-threads, inbox-status-filter,
// inboxmsg, inbox-reconnect-banner (plus the runtime-injected inbox-draft,
// inbox-approve-btn, inbox-regen-btn, inbox-status-sel, inbox-label-sel,
// inbox-save-labels and the inbox-catalog-*/inbox-invoice-* invoice-flow ids).
// The Phase-1 modal (inbox-modal / inbox-thread / inbox-modal-close /
// inbox-modal-msg) is deleted.
export const inboxView = `  <section class="ibx" data-panel="inbox">
    <header class="ibx-head">
      <h2 data-tab="inbox">Inbox</h2>
      <span id="ibx-auto-pill" class="ibx-pill" title="Reply mode - change in Settings">Manual review</span>
      <span class="ibx-spacer"></span>
      <button type="button" class="ghost" onclick="loadInboxThreads()">Refresh</button>
    </header>
    <div class="ibx-grid">
      <aside class="ibx-list-pane" aria-label="Conversations">
        <div class="ibx-filters">
          <div class="ibx-chiprow" id="ibx-filter-chips">
            <button type="button" class="ibx-chip is-on" data-filter="open" onclick="ibxSetFilter('open')">Open</button>
            <button type="button" class="ibx-chip" data-filter="needs_reply" onclick="ibxSetFilter('needs_reply')">Needs reply</button>
            <button type="button" class="ibx-chip" data-filter="" onclick="ibxSetFilter('')">All</button>
            <button type="button" class="ibx-chip" data-filter="suppliers" onclick="ibxOpenSuppliers()">Suppliers</button>
          </div>
          <select id="inbox-status-filter" aria-label="Filter by status" onchange="ibxFilterFromSelect()">
            <option value="open" selected>Open (unprocessed)</option>
            <option value="">All</option>
            <option value="new">New</option>
            <option value="needs_reply">Needs reply</option>
            <option value="awaiting_customer">Awaiting customer</option>
            <option value="converted">Converted</option>
            <option value="closed">Closed</option>
            <option value="spam">Spam</option>
          </select>
        </div>
        <div id="inbox-threads" class="ibx-list"><p class="muted" style="padding:12px">Loading…</p></div>
        <p id="inboxmsg" class="msg muted"></p>
      </aside>
      <section class="ibx-convo" aria-label="Conversation">
        <div id="inbox-reconnect-banner" class="ibx-banner" style="display:none"></div>
        <div id="ibx-convo-head" class="ibx-convo-head" style="display:none"></div>
        <div id="ibx-timeline" class="ibx-timeline">
          <div class="ibx-empty"><p>Select a conversation</p><p class="muted">Pick a thread from the list to read and reply.</p></div>
        </div>
        <p id="ibx-msg" class="msg muted"></p>
      </section>
      <aside class="ibx-context" aria-label="Thread details">
        <div id="ibx-context-body"><p class="muted" style="font-size:13px;margin:0">Thread details appear here.</p></div>
      </aside>
    </div>
  </section>`;

// Namespaced (.ibx-*) workspace CSS. Composed AFTER shellCss in page.ts. The
// console palette is FORCED DARK (merchant light-sensitivity), so the spec's
// "soft blue tint" for outbound cards is a dark-friendly blue wash, and the
// accent is the Phase-1 shell orange (#e8590c / #f0854b text).
export const inboxCss = `
  /* --- Inbox workspace (Phase 2): 3-pane mail layout --- */
  #view-inbox.active{display:flex;flex-direction:column;height:100vh;padding:0;overflow:hidden}
  .ibx{display:flex;flex-direction:column;flex:1 1 auto;min-height:min(300px,60vh)}
  .ibx-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--border);flex:0 0 auto}
  .ibx-head h2{font-size:16px;font-weight:650;margin:0}
  .ibx-spacer{flex:1 1 auto}
  .ibx-pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--field-border);color:var(--subdued);white-space:nowrap}
  .ibx-pill.is-auto{border-color:rgba(232,89,12,.5);background:rgba(232,89,12,.12);color:#f0854b}
  .ibx-grid{display:grid;grid-template-columns:292px minmax(0,1fr) 296px;flex:1 1 auto;min-height:0}
  .ibx-list-pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border)}
  .ibx-filters{padding:10px 12px;border-bottom:1px solid var(--border);flex:0 0 auto}
  .ibx-chiprow{display:flex;gap:6px;margin-bottom:8px}
  .ibx-chip{padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:transparent;border:1px solid var(--field-border);color:var(--subdued)}
  .ibx-chip:hover{filter:none;background:var(--code-bg);color:var(--ink)}
  .ibx-chip.is-on{background:rgba(232,89,12,.18);border-color:#e8590c;color:#f0854b}
  .ibx-filters select{font-size:12.5px;padding:6px 8px}
  .ibx-list{flex:1 1 auto;min-height:0;overflow-y:auto}
  /* id selectors, NOT classes: setMsg() rewrites className to "msg <kind>",
     which would strip any extra layout class off these two elements. */
  #inboxmsg{flex:0 0 auto;padding:0 12px 8px;margin:0}
  .ibx-row{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:0;padding:10px 12px;color:var(--ink);font-weight:400;cursor:pointer}
  .ibx-row:hover{background:var(--code-bg);filter:none}
  .ibx-row.is-sel{background:rgba(232,89,12,.10);box-shadow:inset 2px 0 0 #e8590c}
  .ibx-row__top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .ibx-row__who{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ibx-row__age{font-size:11px;color:var(--subdued);flex:0 0 auto}
  .ibx-row__subj{display:block;font-size:12.5px;color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
  .ibx-row__chips{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}
  .ibx-tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--code-bg);color:var(--subdued);border:1px solid var(--border);white-space:nowrap}
  .ibx-tag.cat{color:#f0854b;border-color:rgba(232,89,12,.4);background:rgba(232,89,12,.10)}
  .ibx-tag.draft{color:#d3a133;border-color:rgba(211,161,51,.4);background:rgba(211,161,51,.10)}
  .ibx-tag.ok{background:var(--ok-bg);color:var(--ok-ink);border-color:transparent}
  .ibx-tag.no{background:var(--no-bg);color:var(--no-ink);border-color:transparent}
  .ibx-convo{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
  .ibx-banner{margin:10px 18px 0;padding:8px 12px;background:var(--no-bg);color:var(--no-ink);border-radius:8px;font-size:13px;flex:0 0 auto}
  .ibx-convo-head{padding:12px 18px;border-bottom:1px solid var(--border);flex:0 0 auto}
  .ibx-convo-head__row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ibx-convo-head h3{margin:0;font-size:15px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
  .ibx-status-sel{width:auto;font-size:12.5px;padding:5px 8px}
  .ibx-timeline{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
  #ibx-msg{flex:0 0 auto;padding:0 18px 10px;margin:0}
  .ibx-bubble{max-width:78%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface)}
  .ibx-bubble.in{align-self:flex-start}
  .ibx-bubble.out{align-self:flex-end;background:rgba(96,150,214,.12);border-color:rgba(96,150,214,.28)}
  .ibx-bubble__hdr{font-size:11.5px;color:var(--subdued);margin-bottom:4px}
  .ibx-bubble.out .ibx-bubble__hdr{color:#9ec3ea}
  .ibx-bubble__body{font-size:13px;white-space:pre-wrap;word-break:break-word}
  .ibx-draft{align-self:stretch;max-width:none;border:1.5px dashed #e8590c;border-radius:10px;padding:12px;background:rgba(232,89,12,.05)}
  .ibx-draft__hdr{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .ibx-draft__title{font-size:12px;font-weight:700;letter-spacing:.04em;color:#f0854b;margin-right:2px}
  .ibx-draft-body{min-height:90px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;white-space:pre-wrap;word-break:break-word}
  .ibx-draft-body:focus{outline:2px solid #e8590c;outline-offset:1px}
  .ibx-draft__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
  .ibx-tpl-sel{width:auto;font-size:12.5px;padding:5px 8px;margin-left:auto}
  .ibx-note{font-size:12px;color:var(--subdued);text-align:center;padding:8px 0;flex:0 0 auto}
  .ibx-note .ibx-tpl-sel{margin-left:10px}
  .ibx-day{display:flex;align-items:center;gap:12px;color:var(--subdued);font-size:11px;font-weight:600;letter-spacing:.03em}
  .ibx-day::before,.ibx-day::after{content:"";flex:1;height:1px;background:var(--border)}
  .ibx-empty{margin:auto;text-align:center;padding:40px 20px}
  .ibx-empty p{margin:0 0 4px;font-weight:600}
  .ibx-empty p.muted{font-weight:400;font-size:13px}
  .ibx-context{min-height:0;overflow-y:auto;border-left:1px solid var(--border);padding:14px;font-size:13px}
  .ibx-ctx-block{padding:12px 0;border-top:1px solid var(--border)}
  .ibx-ctx-block:first-child{border-top:0;padding-top:0}
  .ibx-ctx-block h4{margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--subdued);display:flex;align-items:center;gap:8px}
  /* Email engagement rows (delivered / opened / clicked / bounced per send) */
  .ibx-ev{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:3px 0;font-size:12.5px}
  .ibx-ev-what{font-weight:600;color:var(--ink)}
  .ibx-ev.bad .ibx-ev-what{color:var(--no-ink)}
  .ibx-ev-when{color:var(--subdued);font-size:11.5px}
  .ibx-ev-link{flex-basis:100%;color:var(--subdued);font-size:11.5px;overflow-wrap:anywhere}
  @media(max-width:1100px){.ibx-grid{grid-template-columns:292px minmax(0,1fr)}.ibx-context{display:none}}
`;
