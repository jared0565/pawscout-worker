// Audit view (2026-07-04, owner ask): a read-only reviewable trail of every
// email received and sent. Sent rows carry provenance chips so the owner can
// audit the automation at a glance: "sent automatically" (machine, under the
// reply toggles), "approved by you" (HITL), or "system message" (no linked
// draft, e.g. an invoice email). Click a row to read the full message text.
export const auditView = `  <section class="card">
    <h2>Audit log</h2>
    <p class="sub" style="margin:0 0 10px">Every email PawScout has received or sent on your behalf, newest first. Sent rows show how they went out: <strong>sent automatically</strong> under your reply settings, <strong>approved by you</strong> before sending, or a <strong>system message</strong> such as an invoice. Click any row to read the full message.</p>
    <div class="row" style="margin:0 0 10px">
      <select id="aud-direction" onchange="loadAudit()">
        <option value="">All messages</option>
        <option value="inbound">Received</option>
        <option value="outbound">Sent</option>
      </select>
      <button class="ghost" onclick="loadAudit()">Refresh</button>
    </div>
    <div id="aud-list"></div>
    <div class="row" style="margin-top:10px">
      <button class="ghost" id="aud-more" onclick="loadOlderAudit()" hidden>Load older</button>
    </div>
    <p id="aud-msg" class="msg muted"></p>
  </section>`;

// Namespaced (.aud-*) styles, composed alongside the other view CSS in page.ts.
export const auditCss = `
  /* --- Audit view --- */
  .aud-row{padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer}
  .aud-row:hover{background:rgba(232,89,12,.05)}
  .aud-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .aud-who{font-weight:600;color:var(--ink)}
  .aud-subj{color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
  .aud-time{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap}
  .aud-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .aud-in{background:rgba(90,163,216,.16);color:#5aa3d8}
  .aud-out{background:rgba(232,89,12,.16);color:#f0854b}
  .aud-auto{background:rgba(63,185,80,.15);color:#3fb950}
  .aud-appr{background:rgba(139,148,158,.18);color:var(--ink)}
  .aud-sys{background:rgba(139,148,158,.12);color:var(--subdued)}
  .aud-cat{background:rgba(139,148,158,.12);color:var(--subdued)}
  .aud-full{white-space:pre-wrap;margin:8px 0 2px;color:var(--ink);font-size:13px;border-left:2px solid var(--border);padding-left:10px;word-break:break-word}
`;
