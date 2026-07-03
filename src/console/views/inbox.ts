// Inbox view (Phase 1 relocation): the thread list card - status filter row,
// #inbox-threads mount, #inboxmsg, and the #inbox-modal thread modal.
// The reply-mode block + #agents-panel moved to the Settings view; the
// #gb-shipping-panel moved to the Operations view. All markup is otherwise
// verbatim from the original single-page console. The modal gets replaced in
// Phase 2 - kept working as-is for now.
export const inboxView = `  <section class="card" data-panel="inbox">
    <h2 data-tab="inbox">Inbox</h2>
    <p class="sub" style="margin:0 0 12px">Customer emails routed through PawScout. Change status or labels below each thread.</p>
    <div class="row" style="margin-bottom:12px">
      <div class="grow">
        <label for="inbox-status-filter">Filter by status</label>
        <select id="inbox-status-filter" onchange="loadInboxThreads()">
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
      <button class="ghost" onclick="loadInboxThreads()">Refresh</button>
    </div>
    <div id="inbox-threads"><p class="muted">Loading…</p></div>
    <p id="inboxmsg" class="msg muted"></p>
    <div id="inbox-modal" class="inbox-modal-overlay" hidden>
      <div class="inbox-modal__panel" role="dialog" aria-modal="true" aria-label="Email thread">
        <button type="button" id="inbox-modal-close" class="inbox-modal__close" aria-label="Close">✕</button>
        <div id="inbox-thread"></div>
        <p id="inbox-modal-msg" class="msg muted"></p>
      </div>
    </div>
  </section>`;
