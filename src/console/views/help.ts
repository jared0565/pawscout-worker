// Help view (Phase 1 stub + Phase 4 shortcuts): the knowledge base itself is
// written in a later phase - this lists the planned topics as plain text so the
// nav slot exists, plus the keyboard shortcuts added in Phase 4.
export const helpView = `  <section class="card">
    <h2>Keyboard shortcuts</h2>
    <ul class="cols">
      <li><code>1</code> - <code>6</code> <span class="muted">switch view (Glance, Inbox, Catalog, Operations, Settings, Help)</span></li>
      <li><code>j</code> / <code>k</code> <span class="muted">next / previous conversation in the Inbox list</span></li>
    </ul>
    <p class="sub muted" style="margin:10px 0 0">Shortcuts are ignored while you are typing, and none of them can send anything - approving a reply is always a click.</p>
  </section>

  <section class="card">
    <h2>Help</h2>
    <p class="sub" style="margin:0 0 12px">The PawScout knowledge base is being written. Planned topics:</p>
    <ul class="cols">
      <li>Quality gates</li>
      <li>Pricing</li>
      <li>Reply automation</li>
      <li>Shipping profiles</li>
      <li>Market availability</li>
      <li>Stock safety</li>
    </ul>
  </section>`;
