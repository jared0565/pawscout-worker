// Campaigns view (2026-07-05): owner-composed marketing broadcasts to the two
// consented audiences - buyers (Shopify "news and offers" opt-in, read live at
// send time) and partners (active collaborators who explicitly opted in via
// the Partners view). Every send is an owner click (HITL); the engine enforces
// consent, the shared unsubscribe/suppression list, and the postal-address
// footer, so compliance is code, not memory.
export const campaignsView = `  <section class="card">
    <h2>Campaigns</h2>
    <p class="sub" style="margin:0 0 10px">Announcements, events and discounts, sent only to people who opted in. Buyers means customers who ticked "email me with news and offers" at checkout, checked live at the moment you send; partners means collaborators you have marked as opted in on the Partners page. Every email carries your business address and a one-click unsubscribe.</p>
    <div id="cmp-audiences" class="cmp-audiences muted">Loading audience sizes…</div>
    <div id="cmp-list"></div>
    <p id="cmp-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>New campaign</h2>
    <div class="row">
      <div>
        <label for="cmp-audience">Audience</label>
        <select id="cmp-audience">
          <option value="buyers">Buyers (marketing opt-in)</option>
          <option value="partners">Partners (opted in)</option>
        </select>
      </div>
      <div class="grow">
        <label for="cmp-subject">Subject</label>
        <input id="cmp-subject" type="text" maxlength="150" placeholder="Summer sale: 15% off cooling gear this week">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="cmp-body">Message (plain text; blank line = new paragraph)</label>
        <textarea id="cmp-body" rows="8" placeholder="Write the announcement the way you would say it. The sign-off, your business address and the unsubscribe link are added automatically."></textarea>
      </div>
    </div>
    <div class="row">
      <button type="button" onclick="cmpCreate()">Save campaign</button>
      <button type="button" class="ghost" onclick="cmpTogglePreview()">Preview</button>
    </div>
    <div id="cmp-preview" class="cmp-preview" hidden></div>
    <p id="cmp-new-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Sender details</h2>
    <p class="sub" style="margin:0 0 10px">Marketing email legally needs to say who it is from and where you are based (this is a hard requirement for US recipients). Campaigns will not send until a business postal address is saved here. It appears in the small print of every campaign email.</p>
    <div class="row">
      <div class="grow">
        <label for="cmp-postal">Business postal address (one line)</label>
        <input id="cmp-postal" type="text" maxlength="240" placeholder="Active Paw, 123 Example Street, London, AB1 2CD, United Kingdom">
      </div>
      <button type="button" onclick="cmpSavePostal()">Save address</button>
    </div>
    <p id="cmp-postal-msg" class="msg muted"></p>
  </section>`;

// Namespaced (.cmp-*) styles, composed alongside the other view CSS in page.ts.
export const campaignsCss = `
  /* --- Campaigns view: audience chips + campaign list + preview --- */
  .cmp-audiences{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 12px;font-size:13px}
  .cmp-audiences strong{color:var(--ink);font-variant-numeric:tabular-nums}
  .cmp-row{padding:12px 4px;border-bottom:1px solid var(--border)}
  .cmp-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .cmp-subj{font-weight:600;color:var(--ink)}
  .cmp-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .cmp-draft{background:rgba(139,148,158,.18);color:var(--subdued)}
  .cmp-sending{background:rgba(232,89,12,.16);color:#f0854b}
  .cmp-sent{background:rgba(63,185,80,.15);color:#3fb950}
  .cmp-time{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap}
  .cmp-stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;color:var(--subdued);font-size:13px}
  .cmp-stats strong{color:var(--ink);font-variant-numeric:tabular-nums}
  .cmp-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .cmp-preview{margin-top:12px;padding:14px 16px;border:1px dashed var(--border);border-radius:10px;font-size:14px}
  .cmp-preview p{margin:0 0 10px}
  .cmp-preview .cmp-small{font-size:12px;color:var(--subdued)}
  #view-campaigns select{padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:14px;font-family:inherit}
  #view-campaigns textarea{width:100%;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:14px;font-family:inherit;resize:vertical}
  #view-campaigns textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
`;
