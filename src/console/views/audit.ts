// Audit view v2 (2026-07-04, owner redesign): the landing list shows CONTACTS
// (email + stored name + latest-contact date), filterable by classification;
// clicking one opens the full conversation with that contact (all threads
// stitched, newest first) in a scrollable modal. Sent rows carry provenance
// chips: "sent automatically" (machine, under the reply toggles), "approved by
// you" (HITL), or "system message" (no linked draft, e.g. an invoice email).
// Read-only by design. The category dropdown is generated from INBOX_LABELS so
// it always mirrors the real classifier taxonomy.
import { INBOX_LABELS } from '../../inbox/types';

const categoryOptions = INBOX_LABELS
  .map((l) => `<option value="${l}">${l}</option>`)
  .join('\n        ');

export const auditView = `  <section class="card">
    <h2>Audit log</h2>
    <p class="sub" style="margin:0 0 10px">Everyone who has emailed the shop, most recent contact first. Click a person to read the whole conversation, newest message first. Sent messages show how they went out: <strong>sent automatically</strong> under your reply settings, <strong>approved by you</strong> before sending, or a <strong>system message</strong> such as an invoice.</p>
    <div class="row" style="margin:0 0 10px">
      <select id="aud-category" onchange="loadAudit()">
        <option value="">All categories</option>
        ${categoryOptions}
      </select>
      <button class="ghost" onclick="loadAudit()">Refresh</button>
    </div>
    <div id="aud-list"></div>
    <div class="row" style="margin-top:10px">
      <button class="ghost" id="aud-more" onclick="loadOlderAudit()" hidden>Load older</button>
    </div>
    <p id="aud-msg" class="msg muted"></p>
  </section>

  <div id="aud-overlay" class="aud-overlay" hidden>
    <div class="aud-modal" role="dialog" aria-label="Conversation">
      <div class="aud-modal-head">
        <div id="aud-convo-title" class="aud-who"></div>
        <button class="ghost" type="button" onclick="closeAuditConvo()">Close</button>
      </div>
      <div id="aud-convo" class="aud-convo"></div>
    </div>
  </div>`;

// Namespaced (.aud-*) styles, composed alongside the other view CSS in page.ts.
export const auditCss = `
  /* --- Audit view: contact list + conversation modal --- */
  .aud-row{padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer}
  .aud-row:hover{background:rgba(232,89,12,.05)}
  .aud-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .aud-who{font-weight:600;color:var(--ink)}
  .aud-mail{color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
  .aud-time{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap}
  .aud-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .aud-in{background:rgba(90,163,216,.16);color:#5aa3d8}
  .aud-out{background:rgba(232,89,12,.16);color:#f0854b}
  .aud-auto{background:rgba(63,185,80,.15);color:#3fb950}
  .aud-appr{background:rgba(139,148,158,.18);color:var(--ink)}
  .aud-sys{background:rgba(139,148,158,.12);color:var(--subdued)}
  .aud-cat{background:rgba(139,148,158,.12);color:var(--subdued)}
  .aud-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}
  .aud-overlay[hidden]{display:none}
  .aud-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(760px,100%);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.45)}
  .aud-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
  .aud-convo{overflow-y:auto;padding:6px 18px 16px}
  .aud-msg-block{padding:12px 0;border-bottom:1px solid var(--border)}
  .aud-msg-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
  .aud-subj{color:var(--subdued);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}
  .aud-body{white-space:pre-wrap;color:var(--ink);font-size:13px;word-break:break-word}
`;
