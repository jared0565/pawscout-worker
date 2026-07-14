// Operations view (Phase 1 relocation): Fulfilment, Maintenance run-now,
// Shipping quote (CJ), and the #gb-shipping-panel block (formerly inside the
// Inbox card) as its own "Shipping profiles" card. Markup verbatim from the
// original single-page console.
export const opsView = `  <section class="card">
    <h2>Fulfilment</h2>
    <p class="sub" style="margin:0 0 10px">Paid orders flow here. Guardrails (unmapped item, incomplete address, high fraud risk, over £100) put an order on <strong>hold</strong> for you; clean ones queue.</p>
    <p class="sub" style="margin:0 0 6px">Fulfilment mode: <strong id="modelabel">…</strong></p>
    <div class="row">
      <button class="ghost" onclick="setMode('manual')">Manual</button>
      <button class="ghost" onclick="setMode('cj')">CJ app</button>
      <button class="ghost" onclick="setMode('pawscout')">PawScout auto</button>
      <button class="ghost" id="createonlybtn" onclick="toggleCreateOnly()">Create-only: …</button>
      <button class="ghost" id="cjdiagbtn" onclick="verifyCjOrders()">Verify CJ order API</button>
      <button class="ghost" id="runbtn" onclick="runFulfilNow()">Run fulfilment now</button>
      <button class="ghost" id="ordbtn" onclick="loadOrders()">Refresh</button>
    </div>
    <div class="row" style="margin-top:6px">
      <input id="alertemail" type="email" placeholder="alerts@example.com" value="fbm2k11@gmail.com" style="flex:1;min-width:200px">
      <button class="ghost" id="savealertbtn" onclick="saveAlertEmail()">Save alert email</button>
      <button class="ghost" id="testemailbtn" onclick="sendTestEmail()">Send test email</button>
    </div>
    <p class="sub" style="margin:6px 0 0">PawScout emails this address whenever it creates an order in CJ that is awaiting your payment, so you can pay it ASAP.</p>
    <p class="sub" style="margin:0 0 8px"><strong>Manual</strong>: orders just queue - you pay in CJ by hand. <strong>CJ app</strong>: CJ's own Shopify app fulfils; PawScout stays out. <strong>PawScout auto</strong>: PawScout creates + pays + tracks automatically - only after the CJ wallet is funded AND CJ's native order-import is OFF (else duplicate orders). <strong>Create-only</strong> (PawScout mode only): PawScout creates the CJ order but does NOT pay it - it shows below as <em>awaiting-payment</em> with the CJ order id, you pay it in CJ, and tracking still flows back automatically. Use this until the wallet is funded.</p>
    <div id="awaitbanner" class="msg" style="display:none"></div>
    <div id="ordlist"></div>
    <p id="ordmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Maintenance - run now</h2>
    <p class="sub" style="margin:0 0 12px">These run automatically every night. Use them here to apply changes on demand - after a bulk import, before launch, or to backfill the catalog without waiting for the nightly job.</p>
    <div class="row">
      <button id="syncbtn" onclick="syncNow()">Sync now</button>
      <button class="ghost" id="herobtn" onclick="heroImagesNow()">Fix default images</button>
      <button class="ghost" id="reimgbtn" onclick="catalogImagesNow()">Fix Google image issues</button>
      <button class="ghost" id="descbtn" onclick="rewriteDescsNow()">Rewrite legacy descriptions</button>
      <button class="ghost" id="catbtn" onclick="fixCategoriesNow()">Re-file categories</button>
    </div>
    <div class="bar" id="syncbar"><i></i></div>
    <p id="syncmsg" class="msg muted"></p>
    <p id="heromsg" class="msg muted"></p>
    <p id="reimgmsg" class="msg muted"></p>
    <p id="descmsg" class="msg muted"></p>
    <p id="catmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Shipping quote (CJ)</h2>
    <p class="sub" style="margin:0 0 12px">What CJ actually charges to ship a given <strong>quantity</strong> to a destination, cheapest line first - the real freight behind a flat checkout rate. Read-only; creates nothing.</p>
    <div class="row">
      <div class="grow"><label for="fqpid">CJ product id</label><input id="fqpid" type="text" placeholder="from the product's cj-pid-… tag" spellcheck="false"></div>
      <div class="grow" style="flex:0 1 220px"><label for="fqcountry">Country</label>
        <div class="combo">
          <input id="fqcountry" type="text" autocomplete="off" spellcheck="false" placeholder="Type to search…" data-code="ES" value="Spain" oninput="fqCountryFilter()" onfocus="fqCountryOpen()" onblur="fqCountryBlur()" onkeydown="fqCountryKey(event)">
          <div id="fqcountrymenu" class="combo-menu" onmousedown="fqCountryMenuClick(event)"></div>
        </div>
      </div>
      <div><label for="fqqty">Qty</label><input id="fqqty" type="number" min="1" max="100" value="1" style="width:78px"></div>
      <button id="fqbtn" onclick="freightQuote()">Quote</button>
    </div>
    <div id="fqout" class="msg muted"></div>
  </section>

  <section class="card">
    <h2>Shipping profiles</h2>
    <div id="gb-shipping-panel" class="agents-panel">
      <div class="agents-panel__head">Shipping profiles <span class="sub">(free UK delivery on GB-warehoused items)</span></div>
      <p id="gb-profile-status" class="sub" style="margin:6px 0">Loading&hellip;</p>
      <div class="toggle-wrap" style="margin-top:8px">
        <input type="checkbox" id="gb-free-uk-chk" data-gb-free-uk onchange="saveGbFreeUk()">
        <label for="gb-free-uk-chk" style="display:inline;font-weight:550">State &ldquo;free UK delivery&rdquo; in replies. Flip this ON only after a live GB-item-to-UK checkout shows GBP 0.</label>
      </div>
      <p class="sub" style="margin:8px 0 0">Tradeoff: free UK shipping on a GB item gives up about GBP 4.99 per GB UK order; the item margin absorbs it as a conversion lever.</p>
      <div style="margin-top:10px">
        <button type="button" id="gb-sync-btn" onclick="syncGbLocal()">Sync shipping profiles now</button>
        <span id="gb-sync-msg" class="sub"></span>
      </div>
      <pre id="gb-sync-result" class="sub" style="white-space:pre-wrap;margin:6px 0 0"></pre>
    </div>
  </section>

  <section class="card">
    <h2>Catalog</h2>
    <div class="agents-panel">
      <div class="agents-panel__head">De-brand titles <span class="sub">(strip manufacturer brands like PawHut)</span></div>
      <p class="sub" style="margin:6px 0">Removes supplier brand names from product titles and published blog posts, so the store never advertises a competitor and shoppers can&rsquo;t find the same item cheaper elsewhere by its brand. Runs automatically every night; use this to apply it right now. Product handles and links are never changed.</p>
      <div style="margin-top:10px">
        <button type="button" id="debrand-btn" onclick="runDebrand()">De-brand catalog now</button>
        <span id="debrand-msg" class="sub"></span>
      </div>
      <pre id="debrand-result" class="sub" style="white-space:pre-wrap;margin:6px 0 0"></pre>
    </div>
  </section>`;
