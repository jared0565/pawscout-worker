// Partners view (2026-07-04): affiliate voucher trials. The owner creates a
// percentage discount code in Shopify admin, registers it here against the
// collaborator, and PawScout's 15-minute order poll keeps the ledger current:
// uses, face-value gross, discount cost and commission owed/paid per code.
// Terms follow the owner's programme: commission is a percentage of FACE VALUE
// (the goods subtotal before the discount, excluding shipping) on paid orders;
// refunds claw commission back automatically. Actions (revoke, mark paid) are
// two-click armed buttons rather than window.confirm, which the embedded admin
// iframe can silently swallow.
export const partnersView = `  <section class="card">
    <h2>Partners</h2>
    <p class="sub" style="margin:0 0 10px">Each row is one voucher you issued to a collaborator. Sales figures come from real Shopify orders placed with the code, refreshed about every 15 minutes. Gross is the face value of the goods before the discount, excluding shipping; commission is calculated on that gross for paid orders only, and refunded orders drop out automatically. Revoking here stops the trial on record: remember to also disable the code itself under Discounts in Shopify admin. "Mark updates opt-in" adds a partner to the Campaigns audience: only flip it after they have themselves said yes to receiving partner updates, never just because they wrote to us.</p>
    <div id="prt-list"></div>
    <p id="prt-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Issue or register a voucher</h2>
    <p class="sub" style="margin:0 0 8px"><strong>Issue automatically</strong> creates the discount code in Shopify for you (percentage off, once per customer, no combining, a usage cap and an end date), registers it here, and, if this person has an inbox conversation, stages the invite email carrying the code for your approval. Timing is event-aware: if a storewide promotion is running, the code is scheduled to start right after it ends. Leave the code field blank to auto-generate one. <strong>Register voucher</strong> is the manual path for a code you already created in Shopify admin yourself.</p>
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
        <div id="prt-orders-title" class="prt-who"></div>
        <button class="ghost" type="button" onclick="closePartnerOrders()">Close</button>
      </div>
      <div id="prt-orders" class="prt-orders"></div>
    </div>
  </div>`;

// Namespaced (.prt-*) styles, composed alongside the other view CSS in page.ts.
export const partnersCss = `
  /* --- Partners view: voucher list + orders modal --- */
  .prt-row{padding:12px 4px;border-bottom:1px solid var(--border)}
  .prt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .prt-who{font-weight:600;color:var(--ink)}
  .prt-mail{color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
  .prt-code{font-family:ui-monospace,monospace;font-size:12px;font-weight:650;border:1px solid var(--border);border-radius:6px;padding:2px 7px;color:var(--ink)}
  .prt-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .prt-live{background:rgba(63,185,80,.15);color:#3fb950}
  .prt-expired{background:rgba(139,148,158,.18);color:var(--subdued)}
  .prt-revoked{background:rgba(248,81,73,.15);color:#f85149}
  .prt-time{margin-left:auto;color:var(--subdued);font-size:12px;white-space:nowrap}
  .prt-stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;color:var(--subdued);font-size:13px}
  .prt-stats strong{color:var(--ink);font-variant-numeric:tabular-nums}
  .prt-actions{display:flex;gap:8px;margin-top:8px}
  .prt-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}
  .prt-overlay[hidden]{display:none}
  .prt-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(720px,100%);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.45)}
  .prt-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
  .prt-orders{overflow-y:auto;padding:6px 18px 16px}
  .prt-order-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
  .prt-order-row .muted{font-size:12px}
`;
