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

  <section class="card" id="cmp-compose-card">
    <h2 id="cmp-compose-title">New campaign</h2>
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
      <button type="button" id="cmp-save-btn" onclick="cmpCreate()">Save campaign</button>
      <button type="button" class="ghost" onclick="cmpTogglePreview()">Preview</button>
      <button type="button" class="ghost" id="cmp-edit-cancel" onclick="cmpEditCancel()" hidden>Cancel edit</button>
    </div>
    <div id="cmp-preview" class="cmp-preview" hidden></div>
    <p id="cmp-new-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Storewide event</h2>
    <p class="sub" style="margin:0 0 8px">Run a store-off event (for example a bank-holiday weekend) without touching Shopify admin. Create sets up the discount code in Shopify with the schedule inside it: the code simply does not work at checkout before the start day or after the end day, so nothing needs switching off by hand. The storefront welcome modal follows the running event live and tears itself down when it ends. Creating an event also stages an announcement campaign draft with the real dates baked in (review, test and send it from the composer above). Events cannot overlap another promotion, and partner voucher codes automatically schedule themselves around events.</p>
    <p id="ev-promos" class="sub muted" style="margin:0 0 10px">Checking events…</p>
    <div class="row">
      <div class="grow">
        <label for="ev-code">Event code</label>
        <input id="ev-code" type="text" maxlength="30" placeholder="BANKHOL15" style="text-transform:uppercase">
      </div>
      <div class="grow">
        <label for="ev-pct">Discount (%)</label>
        <input id="ev-pct" type="number" value="10" min="1" max="90" step="0.5">
      </div>
      <div class="grow">
        <label for="ev-start">Starts</label>
        <input id="ev-start" type="date">
      </div>
      <div class="grow">
        <label for="ev-end">Ends (inclusive)</label>
        <input id="ev-end" type="date">
      </div>
    </div>
    <div class="row" style="align-items:center">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:0"><input id="ev-stage-chk" type="checkbox" checked> Stage the announcement campaign draft</label>
      <button type="button" id="ev-create-btn" onclick="evCreate(this)">Create event</button>
    </div>
    <p id="ev-msg" class="msg muted"></p>
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
  </section>

  <section class="card">
    <h2>Privacy policy wording</h2>
    <p class="sub" style="margin:0 0 10px">Because the store sends marketing email and measures opens and clicks, the privacy policy should say so. This checks your live policy against the recommended wording (marketing is opt-in only, one-click unsubscribe, engagement measurement, and the correct business address) and can apply the missing pieces in one click. Nothing else in the policy is touched.</p>
    <div id="lgl-status" class="muted">Checking the live policy…</div>
    <div class="row" id="lgl-actions" hidden style="margin-top:10px">
      <button type="button" id="lgl-apply-btn" onclick="lglApply(this)">Apply recommended update</button>
    </div>
    <p id="lgl-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Email analytics</h2>
    <p class="sub" style="margin:0 0 10px">When tracking is on, every email reports back what happened to it: delivered, opened, clicked, bounced or marked as spam. Campaign rows above show the numbers per campaign. Addresses that hard-bounce or complain are suppressed automatically so they are never mailed again. Opens are approximate (some mail apps block or pre-load them); clicks are the reliable signal.</p>
    <div id="cmp-tracking" class="muted">Checking tracking status…</div>
    <div class="row" id="cmp-tracking-actions" hidden style="margin-top:10px">
      <button type="button" onclick="cmpEnableTracking()">Turn on tracking</button>
    </div>
    <p id="cmp-tracking-msg" class="msg muted"></p>
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
  .cmp-paused{background:rgba(88,166,255,.15);color:#58a6ff}
  .cmp-cancelled{background:rgba(248,81,73,.15);color:#f85149}
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
