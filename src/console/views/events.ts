// Events view (2026-07-06): the promotion calendar. Yearly cards come from the
// worker's event catalogue (dates computed, wording pre-written); enabling one
// schedules its Shopify discount immediately and the nightly rotation keeps it
// scheduled every year. The one-off form moved here from Campaigns (one home
// for events); announcement drafts still land in the Campaigns composer.
export const eventsView = `  <section class="card">
    <h2>Events</h2>
    <p class="sub" style="margin:0 0 8px">Storewide promotions, run entirely from here. The cards below show what is live or scheduled right now, straight from Shopify. Yearly events are enable-once: the discount schedules itself (the code only works during its window), the storefront pop-up wakes up with the event's own wording and tears itself down at the end, the announcement email is drafted for you about two weeks before each occurrence, and after it ends the card re-dates itself to next year. Partner voucher codes automatically schedule themselves around every event, and no two events can ever run at the same time.</p>
    <div id="ev-promos" class="sub muted" style="margin:0">Checking events…</div>
  </section>

  <section class="card">
    <h2>Yearly events</h2>
    <p class="sub" style="margin:0 0 10px">Each card is pre-built: design, wording and dates (bank holidays are calculated, so the dates are always next occurrence's real dates). Set the discount if the default is not right, then Enable - that is the whole job. Disable retires the scheduled discount but keeps the card ready. The pop-up headline shows the live percentage automatically.</p>
    <div id="ev-recurring"><p class="muted">Loading…</p></div>
    <p id="ev-rec-msg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>One-off event</h2>
    <p class="sub" style="margin:0 0 8px">For a promotion outside the yearly calendar. Same machinery: the schedule lives inside the discount, the pop-up follows it, and an announcement draft is staged. Bank-holiday windows are reserved for their own cards above and cannot be allocated here.</p>
    <div class="row">
      <div class="grow">
        <label for="ev-code">Event code</label>
        <input id="ev-code" type="text" maxlength="30" placeholder="PAWDAY10" style="text-transform:uppercase">
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
  </section>`;

export const eventsCss = `
  /* --- Events view: yearly cards + one-off form --- */
  .evr-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .evr-card{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:0;background:var(--surface)}
  .evr-card.is-on{border-color:rgba(63,185,80,.5)}
  .evr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .evr-head strong{color:var(--ink)}
  .evr-when{margin:4px 0 8px;font-size:12.5px;color:var(--subdued)}
  .evr-preview{border-left:3px solid rgba(232,89,12,.5);padding:6px 10px;margin:0 0 10px;font-size:13px;color:var(--ink)}
  .evr-sub{display:block;font-size:12px;color:var(--subdued);margin-top:2px}
  .evr-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .evr-chip{font-size:11px;border:1px solid var(--border);border-radius:9px;padding:2px 8px;color:var(--subdued)}
  .evr-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:auto}
  .evr-actions label{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--subdued);margin:0}
  .evr-actions input[type="number"]{width:80px}
  @media(max-width:1100px){.evr-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:720px){.evr-grid{grid-template-columns:1fr}}
`;
