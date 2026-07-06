// Partners view (2026-07-04, table redesign 2026-07-06): affiliate voucher
// trials. Every voucher is one table row; everything you can do to a partner
// lives in a per-row Actions menu (a single floating position:fixed panel so
// the table's horizontal-scroll wrapper cannot clip it - see partners-js).
// The long how-it-works prose lives in hidden divs opened as an info popover
// from the "?" buttons, keeping the working surface clean at 100+ partners.
// Terms follow the owner's programme: commission is a percentage of FACE VALUE
// (the goods subtotal before the discount, excluding shipping) on paid orders;
// refunds claw commission back automatically. Consequential actions stay
// two-click armed rather than window.confirm, which the embedded admin iframe
// can silently swallow.
export const partnersView = `  <section class="card">
    <h2>Partners <button type="button" class="prt-info" onclick="openPartnerInfo(this)" data-prt-help="prt-help-list" data-prt-help-title="How the partner list works" aria-label="How the partner list works">?</button></h2>
    <div id="prt-help-list" hidden>
      <p>Each row is one voucher you issued to a collaborator. Sales figures come from real Shopify orders placed with the code, refreshed about every 15 minutes. Gross is the face value of the goods before the discount, excluding shipping; commission is calculated on that gross for paid orders only, and refunded orders drop out automatically. Open Orders from a row's Actions menu to see every order behind its numbers, the payout history with per-payout statements (Statement CSV), and the full Ledger CSV export for accounting.</p>
      <p>Revoking a voucher also deactivates the code in Shopify, so it stops working at checkout immediately; if Shopify cannot be reached the message will tell you to disable it by hand. A revoked or expired row offers Reissue: one click starts a fresh code for the same partner on the same terms, with the invite staged in the Inbox when they have a conversation there.</p>
      <p>People you add to the trial code queue from the Inbox appear in their own table as "waiting for a code" until you issue or remove them, so nobody you qualified gets forgotten. "Mark updates opt-in" adds a partner to the Campaigns audience: only flip it after they have themselves said yes to receiving partner updates, never just because they wrote to us. The same switch also sits in the Inbox on their thread's Partnership panel, so you can record the yes the moment you read it; queued partners count in the audience too.</p>
    </div>
    <div id="prt-list"></div>
    <p id="prt-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Issue or register a voucher <button type="button" class="prt-info" onclick="openPartnerInfo(this)" data-prt-help="prt-help-issue" data-prt-help-title="Issuing a voucher" aria-label="How issuing works">?</button></h2>
    <div id="prt-help-issue" hidden>
      <p><strong>Issue automatically</strong> creates the discount code in Shopify for you (percentage off, once per customer, no combining, a usage cap and an end date), registers it here, and, if this person has an inbox conversation, stages the invite email carrying the code for your approval. Leave the code field blank to auto-generate one.</p>
      <p>Timing is event-aware: if a storewide promotion is running, the code is scheduled to start right after it ends, so a partner code never competes with a bigger discount. The banner above the form shows what is currently running and how new codes will be timed.</p>
      <p><strong>Register voucher</strong> is the manual path for a code you already created in Shopify admin yourself.</p>
    </div>
    <p id="prt-promos" class="sub muted" style="margin:0 0 12px">Checking store promotions…</p>
    <div class="row">
      <div class="grow">
        <label for="prt-email">Partner email</label>
        <input id="prt-email" type="email" placeholder="name@example.com">
      </div>
      <div class="grow">
        <label for="prt-name">Name (optional)</label>
        <input id="prt-name" type="text" maxlength="80">
      </div>
      <div class="grow">
        <label for="prt-channel">Channel or site (optional)</label>
        <input id="prt-channel" type="text" maxlength="200" placeholder="https://...">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="prt-code">Discount code</label>
        <input id="prt-code" type="text" maxlength="40" placeholder="ACTIVEPAW-NAME5" style="text-transform:uppercase">
      </div>
      <div class="grow">
        <label for="prt-pct">Customer discount (%)</label>
        <input id="prt-pct" type="number" value="5" min="1" max="50" step="0.5">
      </div>
      <div class="grow">
        <label for="prt-comm">Commission (% of gross)</label>
        <input id="prt-comm" type="number" value="2" min="0" max="20" step="0.5">
      </div>
      <div class="grow">
        <label for="prt-ends">Valid through</label>
        <input id="prt-ends" type="date">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="prt-notes">Notes (optional)</label>
        <input id="prt-notes" type="text" maxlength="500" placeholder="Agreed terms, where they will share it...">
      </div>
      <button type="button" onclick="issuePartnerVoucher()">Issue automatically</button>
      <button type="button" class="ghost" onclick="registerPartner()">Register voucher</button>
    </div>
    <p id="prt-reg-msg" class="msg muted"></p>
  </section>

  <div id="prt-overlay" class="prt-overlay" hidden>
    <div class="prt-modal" role="dialog" aria-label="Voucher orders">
      <div class="prt-modal-head">
        <div>
          <div id="prt-orders-title" class="prt-who"></div>
          <div id="prt-orders-sub" class="muted" style="font-size:12px"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="ghost" type="button" onclick="exportPartnerLedger()">Ledger CSV</button>
          <button class="ghost" type="button" onclick="closePartnerOrders()">Close</button>
        </div>
      </div>
      <div id="prt-orders" class="prt-orders"></div>
    </div>
  </div>

  <div id="prt-payout-overlay" class="prt-overlay" hidden>
    <div class="prt-modal prt-modal--info" role="dialog" aria-label="Record a commission payout">
      <div class="prt-modal-head">
        <div>
          <div class="prt-who">Record a commission payout</div>
          <div id="prt-payout-sub" class="muted" style="font-size:12px"></div>
        </div>
        <button class="ghost" type="button" onclick="closePartnerPayout()">Close</button>
      </div>
      <div class="prt-info-body">
        <p style="margin:0 0 10px">Pay the partner yourself first (PayPal, bank transfer), then record it here. The amount and the exact orders covered are frozen into a payout record - the accounting document for later, exportable as a statement from the row's Orders view.</p>
        <div class="row">
          <div class="grow">
            <label for="prt-payout-method">Method</label>
            <input id="prt-payout-method" type="text" maxlength="60" placeholder="PayPal">
          </div>
          <div class="grow">
            <label for="prt-payout-ref">Reference</label>
            <input id="prt-payout-ref" type="text" maxlength="120" placeholder="Transaction id">
          </div>
        </div>
        <div class="row" style="align-items:center;margin-top:6px">
          <button type="button" id="prt-payout-btn" onclick="recordPartnerPayout(this)">Record payout</button>
        </div>
        <p id="prt-payout-msg" class="msg muted"></p>
      </div>
    </div>
  </div>

  <div id="prt-info-overlay" class="prt-overlay" hidden>
    <div class="prt-modal prt-modal--info" role="dialog" aria-label="Explanation">
      <div class="prt-modal-head">
        <div id="prt-info-title" class="prt-who"></div>
        <button class="ghost" type="button" onclick="closePartnerInfo()">Close</button>
      </div>
      <div id="prt-info-body" class="prt-info-body"></div>
    </div>
  </div>`;

// Namespaced (.prt-*) styles, composed alongside the other view CSS in page.ts.
export const partnersCss = `
  /* --- Partners view: tables + per-row Actions menu + info popover --- */
  .prt-info{width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--subdued);font-size:12px;font-weight:700;line-height:1;cursor:pointer;vertical-align:2px;margin-left:6px;padding:0}
  .prt-info:hover{color:var(--ink);border-color:var(--ink)}
  .prt-modal--info{width:min(560px,92%)}
  .prt-info-body{padding:8px 18px 16px;overflow-y:auto;font-size:13px}
  .prt-info-body p{margin:0 0 10px;color:var(--subdued)}
  .prt-info-body strong{color:var(--ink)}
  .prt-queue{margin:0 0 14px;padding:10px 12px;border:1px dashed var(--border);border-radius:10px}
  .prt-queue h3{margin:0 0 4px;font-size:13.5px;color:var(--ink)}
  .prt-tablewrap{overflow-x:auto}
  .prt-table{width:100%;border-collapse:collapse;font-size:13px}
  .prt-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--subdued);font-weight:650;padding:8px 10px 6px;border-bottom:1px solid var(--border);white-space:nowrap}
  .prt-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap}
  .prt-table tbody tr:last-child td{border-bottom:none}
  .prt-table th.prt-num,.prt-table td.prt-num{text-align:right;font-variant-numeric:tabular-nums}
  .prt-cell-who .prt-who{display:block}
  .prt-cell-who .prt-mail{display:block;max-width:240px}
  .prt-actions-cell{text-align:right}
  .prt-menu{position:fixed;z-index:70;min-width:230px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.4);padding:6px}
  .prt-menu[hidden]{display:none}
  .prt-menu button{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;padding:7px 9px;font-size:13px;color:var(--ink);cursor:pointer;font-family:inherit}
  .prt-menu button:hover{background:var(--field)}
  .prt-who{font-weight:600;color:var(--ink)}
  .prt-mail{color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
  .prt-code{font-family:ui-monospace,monospace;font-size:12px;font-weight:650;border:1px solid var(--border);border-radius:6px;padding:2px 7px;color:var(--ink)}
  .prt-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .prt-live{background:rgba(63,185,80,.15);color:#3fb950}
  .prt-expired{background:rgba(139,148,158,.18);color:var(--subdued)}
  .prt-revoked{background:rgba(248,81,73,.15);color:#f85149}
  .prt-time{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap}
  .prt-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}
  .prt-overlay[hidden]{display:none}
  .prt-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(720px,100%);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.45)}
  .prt-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
  .prt-orders{overflow-y:auto;padding:6px 18px 16px}
  .prt-order-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
  .prt-order-row .muted{font-size:12px}
`;
