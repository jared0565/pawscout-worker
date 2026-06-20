// Subresource Integrity note:
// app-bridge.js is loaded WITHOUT SRI deliberately — it is EVERGREEN and Shopify
// ships updates continuously; an `integrity` hash would break it on the next update
// (Shopify's own guidance). App Bridge v4 exposes a global `shopify` and reads the
// API key from the <meta name="shopify-api-key"> tag, which MUST appear before the
// script. `host` is read from the URL by App Bridge itself — no createApp needed.
//
// Theme note: this renders inside Shopify admin's iframe, which is usually DARK (admin
// dark mode follows the OS color-scheme). The console must feel native, not alien — so
// it defaults to a DARK palette congruent with Polaris dark, and flips to LIGHT only
// when the environment prefers light (`@media (prefers-color-scheme: light)`). Colors
// are explicit in BOTH modes — never inherit, or text washes out. Keep both palettes in
// sync: every --token defined in :root must have a light counterpart in the media query.
//
// Feedback note: this app renders inside Shopify admin's cross-origin iframe, where
// window.alert()/confirm() are silently blocked. ALL user feedback must be inline
// (writing into DOM elements) — never alert(). Do not reintroduce alert() here.

export function consolePage(apiKey: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${apiKey}">
<meta name="color-scheme" content="dark light">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
  /* DARK is the default — it matches Shopify admin dark mode (the usual environment). */
  :root{
    color-scheme:dark light;
    --bg:#1a1a1a; --surface:#2a2a2b; --ink:#e3e3e3; --subdued:#a8abb0;
    --border:#444748; --accent:#e3e3e3; --accent-ink:#1a1a1a;
    --ok-bg:#11331f; --ok-ink:#8fe0a6; --no-bg:#3a1714; --no-ink:#f4a39c;
    --field:#1a1a1a; --field-border:#6a6e73; --code-bg:#1a1a1a; --shadow:rgba(0,0,0,.3);
  }
  /* LIGHT — only when the environment prefers it. Keep tokens in sync with the dark set. */
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f1f2f4; --surface:#ffffff; --ink:#1a1a1a; --subdued:#5c5f62;
      --border:#d2d5d8; --accent:#008060; --accent-ink:#ffffff;
      --ok-bg:#e3f1df; --ok-ink:#0c5132; --no-bg:#fff0f0; --no-ink:#8e1f0b;
      --field:#ffffff; --field-border:#8a8d91; --code-bg:#f1f2f4; --shadow:rgba(0,0,0,.04);
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:680px;margin:0 auto}
  header{margin-bottom:20px}
  h1{font-size:22px;margin:0 0 4px;color:var(--ink);font-weight:650}
  .sub{color:var(--subdued);margin:0;font-size:13px}
  .card{
    background:var(--surface); border:1px solid var(--border); border-radius:12px;
    padding:20px; margin-bottom:16px; box-shadow:0 1px 2px var(--shadow);
  }
  .card h2{font-size:15px;margin:0 0 14px;color:var(--ink);font-weight:600;display:flex;align-items:center;gap:8px}
  .step{
    display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
    border-radius:50%;background:var(--accent);color:var(--accent-ink);font-size:12px;font-weight:600;flex:0 0 auto;
  }
  label{display:block;font-weight:550;color:var(--ink);margin:0 0 6px}
  input[type=text],input[type=number],select{
    width:100%; padding:9px 11px; border:1px solid var(--field-border); border-radius:8px;
    background:var(--field); color:var(--ink); font-size:14px; font-family:inherit;
  }
  input::placeholder{color:#8a8d91}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .combo{position:relative}
  .combo-menu{
    position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:30;
    max-height:240px; overflow-y:auto; display:none;
    background:var(--field); border:1px solid var(--field-border); border-radius:8px;
    box-shadow:0 8px 24px rgba(0,0,0,.18);
  }
  .combo-menu.on{display:block}
  .combo-grp{padding:7px 11px 2px;font-size:11px;font-weight:600;color:var(--subdued);text-transform:uppercase;letter-spacing:.04em}
  .combo-opt{display:flex;justify-content:space-between;gap:10px;padding:7px 11px;font-size:14px;color:var(--ink);cursor:pointer}
  .combo-opt:hover,.combo-opt.active{background:var(--code-bg)}
  .combo-opt .cc{color:var(--subdued);font-size:12px}
  .combo-empty{padding:9px 11px;font-size:13px;color:var(--subdued)}
  .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  .row .grow{flex:1 1 160px}
  .row+.row{margin-top:10px}
  button{
    padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-ink);
    font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap;
  }
  button:hover{filter:brightness(.94)}
  button:disabled{opacity:.55;cursor:default}
  button.ghost{background:transparent;color:var(--ink);border:1px solid var(--field-border)}
  button.ghost:hover{filter:none;background:var(--code-bg)}
  .msg{margin:10px 0 0;font-size:13px;min-height:18px}
  .bar{height:6px;background:var(--code-bg);border:1px solid var(--border);border-radius:999px;overflow:hidden;margin-top:10px;display:none}
  .bar.on{display:block}
  .bar i{display:block;height:100%;width:0;background:var(--ok-ink);border-radius:999px;transition:width .4s ease}
  .bar.pulse i{width:100%;animation:barpulse 1.2s ease-in-out infinite}
  @keyframes barpulse{0%,100%{opacity:.35}50%{opacity:1}}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:var(--ok-bg);color:var(--ok-ink)}
  .badge.no{background:var(--no-bg);color:var(--no-ink)}
  .msg.ok{color:var(--ok-ink)} .msg.no{color:var(--no-ink)} .msg.muted{color:var(--subdued)}
  .kv{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;margin:0}
  .kv dt{color:var(--subdued)} .kv dd{margin:0;color:var(--ink);font-weight:550}
  ul.cols{list-style:none;padding:0;margin:8px 0 0}
  ul.cols li{padding:6px 0;border-top:1px solid var(--border)}
  ul.cols li:first-child{border-top:0}
  .muted{color:var(--subdued)}
  code{background:var(--code-bg);padding:1px 6px;border-radius:5px;font-size:12px;color:var(--ink)}
  hr{border:0;border-top:1px solid var(--border);margin:16px 0}
  .inbox-row{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:0;padding:10px 0;color:var(--ink);font-weight:400;cursor:pointer}
  .inbox-row:last-child{border-bottom:0}
  .inbox-row:hover{background:var(--code-bg);filter:none}
  .inbox-row__who{font-weight:600;font-size:13px}
  .inbox-row__subj{font-size:13px}
  .inbox-row__meta{font-size:12px;color:var(--subdued)}
  #inbox-thread{margin-top:14px}
  .inbox-msg{padding:10px 0;border-top:1px solid var(--border)}
  .inbox-msg:first-child{border-top:0}
  .inbox-msg__hdr{font-size:12px;color:var(--subdued);margin-bottom:4px}
  .inbox-msg__body{font-size:13px;white-space:pre-wrap;word-break:break-word}
  .inbox-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:12px}
  .inbox-controls .grow{flex:1 1 160px}
  .inbox-msg.outbound{background:var(--code-bg);border-radius:8px;padding:10px;border-top:0;margin-top:8px}
  .inbox-msg.outbound .inbox-msg__hdr{color:var(--ok-ink)}
  .inbox-draft-section{margin-top:14px;border-top:1px solid var(--border);padding-top:14px}
  .inbox-draft-section textarea{width:100%;min-height:120px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;font-family:inherit;resize:vertical}
  .inbox-draft-section textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .inbox-hold{font-size:12px;color:var(--no-ink);margin:4px 0 8px}
  .inbox-settings textarea{width:100%;min-height:80px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;font-family:inherit;resize:vertical}
  .inbox-settings textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .toggle-wrap{display:flex;align-items:center;gap:8px;padding:8px 0}
  .toggle-wrap input[type=checkbox]{width:auto;cursor:pointer}
  .reply-mode{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 14px;margin:0 0 14px;border:1px solid var(--border);border-radius:10px;background:var(--code-bg)}
  .reply-mode.is-auto{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .reply-mode__text{flex:1 1 240px;min-width:0}
  .reply-mode__state{font-weight:650}
  .reply-mode.is-auto .reply-mode__state{color:var(--accent)}
  .reply-mode__sw{display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;white-space:nowrap}
  .reply-mode__sw input[type=checkbox]{width:auto;cursor:pointer}
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>PawScout</h1>
    <p class="sub">Supplier intelligence &amp; inventory population for your store.</p>
  </header>

  <section class="card">
    <h2><span class="step">1</span> Connect CJ</h2>
    <div class="row">
      <div class="grow">
        <label for="cj">CJ API key</label>
        <input id="cj" type="text" placeholder="CJ&lt;email&gt;@api@&lt;token&gt;" autocomplete="off" spellcheck="false">
      </div>
      <button id="cjbtn" onclick="connectCj()">Connect</button>
    </div>
    <p id="cjstatus" class="msg muted">Checking…</p>
  </section>

  <section class="card">
    <h2><span class="step">2</span> Quality gates</h2>
    <div class="row">
      <div class="grow">
        <label for="pf">Popularity floor</label>
        <input id="pf" type="number" value="1" min="0">
      </div>
      <div class="grow">
        <label for="pmin">Price min ($)</label>
        <input id="pmin" type="number" value="5" min="0" step="0.01">
      </div>
      <div class="grow">
        <label for="pmax">Price max ($)</label>
        <input id="pmax" type="number" value="80" min="0" step="0.01">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="rel">Relevance</label>
        <select id="rel">
          <option value="loose">Loose — any keyword match</option>
          <option value="title" selected>Title — keyword in title</option>
          <option value="strict">Strict — all keywords in title</option>
        </select>
      </div>
      <div class="grow">
        <label for="tgt">Target per collection</label>
        <input id="tgt" type="number" value="12" min="1" max="200" step="1">
      </div>
      <button onclick="saveGates()">Save gates</button>
    </div>
    <p id="gatesmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2><span class="step">3</span> Collection map</h2>
    <p class="sub" style="margin:0 0 12px">Map each storefront collection handle to the supplier tag that fills it. Lowercase letters, digits and hyphens only.</p>
    <div id="maprows"></div>
    <div class="row">
      <button class="ghost" type="button" onclick="addMapRow('','')">Add mapping</button>
      <button type="button" onclick="saveCollections()">Save collections</button>
    </div>
    <p id="mapmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2><span class="step">4</span> Pricing rule</h2>
    <p class="sub" style="margin:0 0 12px">Landed USD supplier cost → GBP retail. Default 2.5× targets ~17% net after ads, fees and refunds.</p>
    <div class="row">
      <div class="grow">
        <label for="pmult">Multiplier</label>
        <input id="pmult" type="number" value="2.5" min="1" max="10" step="0.1">
      </div>
      <div class="grow">
        <label for="pfloor">Floor</label>
        <input id="pfloor" type="number" value="2.2" min="1" max="10" step="0.1">
      </div>
      <div class="grow">
        <label for="pmm">Min margin (£)</label>
        <input id="pmm" type="number" value="6" min="0" max="100" step="0.5">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="pfx">USD→GBP rate</label>
        <input id="pfx" type="number" value="0.78" min="0.1" max="10" step="0.01">
      </div>
      <div class="grow">
        <label for="pfxb">FX buffer (%)</label>
        <input id="pfxb" type="number" value="2" min="0" max="20" step="0.5">
      </div>
      <button onclick="savePricing()">Save pricing</button>
    </div>
    <p id="pricingmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2><span class="step">5</span> AI curation</h2>
    <p class="sub" style="margin:0 0 12px">Scores supplier candidates and rewrites titles/descriptions at warehouse admission (via OpenRouter). Off = mechanical gates only.</p>
    <div class="row">
      <div class="grow"><label for="mdl-image">Image (vision) model</label><select id="mdl-image"></select></div>
      <div class="grow"><label for="mdl-text">Text model</label><select id="mdl-text"></select></div>
      <div class="grow"><label for="mdl-fallback">Fallback model</label><select id="mdl-fallback"></select></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="grow" style="flex:0 1 140px"><label for="llmthresh">Min score</label><input id="llmthresh" type="number" value="60" min="0" max="100" step="5"></div>
      <div class="grow" style="flex:0 1 120px"><label for="llmon">Enabled</label><select id="llmon"><option value="true" selected>On</option><option value="false">Off</option></select></div>
      <button onclick="saveLlm()">Save AI</button>
    </div>
    <p class="sub muted" style="margin:8px 0 0">Last resort: GPT-5.4 mini · OpenAI direct (system-managed, used only if OpenRouter fails).</p>
    <p id="llmmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2><span class="step">6</span> Add-on / filler products</h2>
    <p class="sub" style="margin:0 0 12px">A hidden pool of cheap, curated items that never appear in browsing or search — they surface only as "Complete the kit" picks on product pages and in the cart's free-delivery nudge. Set the supplier cost band below your main price range.</p>
    <div class="row">
      <div class="grow" style="flex:0 1 120px">
        <label for="addmin">Cost min ($)</label>
        <input id="addmin" type="number" value="0.5" min="0" step="0.1">
      </div>
      <div class="grow" style="flex:0 1 120px">
        <label for="addmax">Cost max ($)</label>
        <input id="addmax" type="number" value="5" min="0" max="50" step="0.1">
      </div>
      <div class="grow" style="flex:0 1 110px">
        <label for="addpool">Pool size</label>
        <input id="addpool" type="number" value="12" min="1" max="50" step="1">
      </div>
      <div class="grow" style="flex:0 1 110px">
        <label for="addon">Enabled</label>
        <select id="addon"><option value="true" selected>On</option><option value="false">Off</option></select>
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="addvis">Visibility in storefront</label>
        <select id="addvis">
          <option value="true" selected>Hidden — add-on slots only (default)</option>
          <option value="false">Visible — also in browsing &amp; search</option>
        </select>
      </div>
      <button onclick="saveAddons()">Save add-ons</button>
    </div>
    <p id="addmsg" class="msg muted"></p>
  </section>

  <section class="card">
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
    <p class="sub" style="margin:0 0 8px"><strong>Manual</strong>: orders just queue — you pay in CJ by hand. <strong>CJ app</strong>: CJ's own Shopify app fulfils; PawScout stays out. <strong>PawScout auto</strong>: PawScout creates + pays + tracks automatically — only after the CJ wallet is funded AND CJ's native order-import is OFF (else duplicate orders). <strong>Create-only</strong> (PawScout mode only): PawScout creates the CJ order but does NOT pay it — it shows below as <em>awaiting-payment</em> with the CJ order id, you pay it in CJ, and tracking still flows back automatically. Use this until the wallet is funded.</p>
    <div id="awaitbanner" class="msg" style="display:none"></div>
    <div id="ordlist"></div>
    <p id="ordmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Maintenance — run now</h2>
    <p class="sub" style="margin:0 0 12px">These run automatically every night. Use them here to apply changes on demand — after a bulk import, before launch, or to backfill the catalog without waiting for the nightly job.</p>
    <div class="row">
      <button id="syncbtn" onclick="syncNow()">Sync now</button>
      <button class="ghost" id="herobtn" onclick="heroImagesNow()">Fix default images</button>
      <button class="ghost" id="descbtn" onclick="rewriteDescsNow()">Rewrite legacy descriptions</button>
      <button class="ghost" id="catbtn" onclick="fixCategoriesNow()">Re-file categories</button>
    </div>
    <div class="bar" id="syncbar"><i></i></div>
    <p id="syncmsg" class="msg muted"></p>
    <p id="heromsg" class="msg muted"></p>
    <p id="descmsg" class="msg muted"></p>
    <p id="catmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Search source diagnostic</h2>
    <p class="sub" style="margin:0 0 12px">Compares what our CJ <code>listV2</code> search returns vs CJ's own website (via Firecrawl) for a query — to verify relevance.</p>
    <div class="row">
      <div class="grow"><label for="diagq">Query</label><input id="diagq" type="text" value="dog toy" spellcheck="false"></div>
      <button id="diagbtn" onclick="runDiag()">Compare</button>
    </div>
    <div id="diagout" class="msg muted"></div>
  </section>

  <section class="card">
    <h2>Shipping quote (CJ)</h2>
    <p class="sub" style="margin:0 0 12px">What CJ actually charges to ship a given <strong>quantity</strong> to a destination, cheapest line first — the real freight behind a flat checkout rate. Read-only; creates nothing.</p>
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
    <h2>Search demand — last 30 days</h2>
    <div id="insights"><p class="muted">Loading…</p></div>
  </section>

  <section class="card">
    <h2>Current configuration</h2>
    <div id="status"><p class="muted">Loading…</p></div>
  </section>

  <section class="card" data-panel="inbox">
    <h2 data-tab="inbox">Inbox</h2>
    <p class="sub" style="margin:0 0 12px">Customer emails routed through PawScout. Change status or labels below each thread.</p>
    <div id="reply-mode" class="reply-mode">
      <div class="reply-mode__text">
        <div>Reply mode: <span class="reply-mode__state" id="reply-mode-state">Manual review</span></div>
        <p class="sub" id="reply-mode-desc" style="margin:4px 0 0">Drafts wait here for you to approve and send — nothing is emailed to customers automatically.</p>
      </div>
      <label class="reply-mode__sw">
        <input type="checkbox" id="inbox-autosend-chk" data-inbox-autosend onchange="onReplyModeToggle()">
        <span style="font-weight:600">Reply automatically</span>
      </label>
    </div>
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
    <div id="inbox-thread"></div>
    <p id="inboxmsg" class="msg muted"></p>
  </section>

  <section class="card inbox-settings">
    <h2>Inbox settings</h2>
    <p class="sub" style="margin:0 0 12px">Controls how PawScout handles incoming emails and drafts replies. The <strong>Reply mode</strong> switch (manual vs. automatic) is at the top of the Inbox panel above.</p>
    <div class="row" style="margin-top:8px">
      <div class="grow">
        <label for="inbox-auto-thresh">Auto-confidence threshold (0–100)</label>
        <input id="inbox-auto-thresh" type="number" min="0" max="100" step="1" value="80">
      </div>
      <div class="grow">
        <label for="inbox-intent-thresh">Intent threshold (0–100)</label>
        <input id="inbox-intent-thresh" type="number" min="0" max="100" step="1" value="70">
      </div>
    </div>
    <div style="margin-top:10px">
      <label for="inbox-alert-email">Alert email</label>
      <input id="inbox-alert-email" type="text" spellcheck="false" autocomplete="off" placeholder="alerts@example.com">
    </div>
    <div style="margin-top:10px">
      <label for="inbox-guidance-ta">Reply guidance (voice &amp; standing instructions for every draft)</label>
      <textarea id="inbox-guidance-ta" data-inbox-guidance placeholder="e.g. Always be warm and concise. Sign off as the PawScout team."></textarea>
    </div>
    <hr style="margin:14px 0">
    <p class="sub" style="margin:0 0 10px;font-weight:600;color:var(--ink)">Invoice settings</p>
    <div class="toggle-wrap">
      <input type="checkbox" id="inbox-autoinvoice-chk" data-inbox-autoinvoice>
      <label for="inbox-autoinvoice-chk" style="display:inline;font-weight:550">Auto-invoice — create and send invoices automatically when confidence &ge; threshold (HITL off)</label>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="grow">
        <label for="inbox-invoice-conf-thresh">Invoice confidence threshold (0–100)</label>
        <input id="inbox-invoice-conf-thresh" type="number" min="0" max="100" step="1" value="95">
      </div>
      <div class="grow">
        <label for="inbox-invoice-value-ceiling">Value ceiling (GBP)</label>
        <input id="inbox-invoice-value-ceiling" type="number" min="0" step="1" value="250">
      </div>
      <div class="grow">
        <label for="inbox-invoice-rate-limit">Rate limit (invoices / 24h per contact)</label>
        <input id="inbox-invoice-rate-limit" type="number" min="1" step="1" value="2">
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button id="inbox-settings-save">Save inbox settings</button>
    </div>
    <p id="inboxcfgmsg" class="msg muted"></p>
  </section>
</div>

<script>
function el(id){ return document.getElementById(id); }
function setMsg(id,t,kind){ var n=el(id); if(!n) return; n.textContent=t; n.className='msg '+(kind||'muted'); }
function errText(e){ return e&&e.message?e.message:String(e); }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
async function token(){ return await shopify.idToken(); }
async function api(path,body,method){
  var t=await token();
  var m=method||'POST';
  var opts={method:m,headers:{'Authorization':'Bearer '+t}};
  if(m!=='GET'){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body||{}); }
  var r=await fetch('/api'+path,opts);
  return r.json();
}
// Model dropdowns: fetch the curated catalog (with live pricing + vision flags)
// once, cache the option HTML, and populate selects. The vision (image) select
// is built only from vision-capable models — a text-only model can never be
// chosen for image QA.
var modelOptionsPromise=null;
function ensureModelOptions(){
  if(!modelOptionsPromise){
    modelOptionsPromise=api('/models',null,'GET').then(function(r){
      var models=(r&&r.models)||[];
      function opt(m){
        var price=(m.promptPriceM==null)?'price n/a':('$'+m.promptPriceM+'/M in · $'+m.completionPriceM+'/M out');
        return '<option value="'+esc(m.slug)+'">'+esc(m.name)+' — '+price+(m.vision?' · 👁':'')+'</option>';
      }
      return { all:models.map(opt).join(''), vision:models.filter(function(m){return m.vision;}).map(opt).join('') };
    }).catch(function(){ return {all:'',vision:''}; });
  }
  return modelOptionsPromise;
}
// Preserve a saved slug not in the curated list as a selected option, so
// converting free-text → dropdown never silently changes a tenant's config.
function setSelectValue(id,slug){
  if(!slug) return;
  var s=el(id); if(!s) return;
  var has=false; for(var i=0;i<s.options.length;i++){ if(s.options[i].value===slug){ has=true; break; } }
  if(!has){ var o=document.createElement('option'); o.value=slug; o.textContent=slug+' (current)'; s.insertBefore(o,s.options[0]||null); }
  s.value=slug;
}
async function setModelSelect(id,slug,opts){
  opts=opts||{};
  var o=await ensureModelOptions();
  var e=el(id); if(!e) return;
  var html=opts.vision?o.vision:o.all;
  if(opts.blank) html='<option value="">'+opts.blank+'</option>'+html;
  e.innerHTML=html;
  setSelectValue(id,slug);
}
function renderStatus(s){
  var g=s.gates||{}; var p=s.pricing||{};
  var rows=''
    +'<dt>CJ supplier</dt><dd><span class="badge '+(s.cjConnected?'ok':'no')+'">'+(s.cjConnected?'Connected':'Not connected')+'</span></dd>'
    +'<dt>Popularity floor</dt><dd>'+esc(g.popularityFloor)+'</dd>'
    +'<dt>Price range</dt><dd>$'+esc(g.priceMin)+' – $'+esc(g.priceMax)+'</dd>'
    +'<dt>Relevance</dt><dd>'+esc(g.relevance)+'</dd>'
    +'<dt>Target count</dt><dd>'+esc(s.target)+'</dd>'
    +'<dt>Pricing</dt><dd>'+esc(p.multiplier)+'× (floor '+esc(p.floor)+'×, min £'+esc(p.minMarginGbp)+')</dd>'
    +(function(){ var a=s.addons||{}; return '<dt>Add-on lane</dt><dd>'+(a.enabled?('$'+esc(a.priceMinUsd)+' – $'+esc(a.priceMaxUsd)+' · pool '+esc(a.poolSize)+' · '+(a.suppressFromBrowse?'hidden':'visible')):'Off')+'</dd>'; })();
  var cm=s.collectionMap||{}; var keys=Object.keys(cm);
  var cols = keys.length
    ? keys.map(function(k){ var v=cm[k]||{}; return '<li><strong>'+esc(v.handle||k)+'</strong> <span class="muted">← tag</span> <code>'+esc(v.tag)+'</code></li>'; }).join('')
    : '<li class="muted">No collections mapped</li>';
  el('status').innerHTML='<dl class="kv">'+rows+'</dl><hr><div class="muted" style="font-weight:550;color:var(--ink)">Collection map</div><ul class="cols">'+cols+'</ul>';
}
// Forms are populated from the server exactly once — refresh() after a save
// must not clobber fields the merchant is still editing.
var formsPopulated=false;
function populateForms(s){
  if(formsPopulated) return; formsPopulated=true;
  var g=s.gates||{};
  if(g.popularityFloor!=null) el('pf').value=g.popularityFloor;
  if(g.priceMin!=null) el('pmin').value=g.priceMin;
  if(g.priceMax!=null) el('pmax').value=g.priceMax;
  if(g.relevance) el('rel').value=g.relevance;
  if(s.target!=null) el('tgt').value=s.target;
  var p=s.pricing||{};
  if(p.multiplier!=null) el('pmult').value=p.multiplier;
  if(p.floor!=null) el('pfloor').value=p.floor;
  if(p.minMarginGbp!=null) el('pmm').value=p.minMarginGbp;
  if(p.fxUsdToGbp!=null) el('pfx').value=p.fxUsdToGbp;
  if(p.fxBufferPct!=null) el('pfxb').value=p.fxBufferPct;
  var l=s.llm||{};
  var mm=(l.models||{});
  setModelSelect('mdl-image', mm.image, {vision:true, blank:'— top model'});
  setModelSelect('mdl-text', mm.text, {blank:'— top model'});
  setModelSelect('mdl-fallback', mm.fallback, {vision:true, blank:'— none'});
  if(l.scoreThreshold!=null) el('llmthresh').value=l.scoreThreshold;
  if(l.enabled!=null) el('llmon').value=String(l.enabled);
  var a=s.addons||{};
  if(a.priceMinUsd!=null) el('addmin').value=a.priceMinUsd;
  if(a.priceMaxUsd!=null) el('addmax').value=a.priceMaxUsd;
  if(a.poolSize!=null) el('addpool').value=a.poolSize;
  if(a.enabled!=null) el('addon').value=String(a.enabled);
  if(a.suppressFromBrowse!=null) el('addvis').value=String(a.suppressFromBrowse);
  var cm=s.collectionMap||{};
  el('maprows').textContent='';
  Object.keys(cm).forEach(function(k){ var v=cm[k]||{}; addMapRow(v.handle||k, v.tag||''); });
}
function addMapRow(handle,tag){
  var row=document.createElement('div'); row.className='row maprow';
  function field(ph,val){
    var d=document.createElement('div'); d.className='grow';
    var i=document.createElement('input'); i.type='text'; i.placeholder=ph; i.value=val;
    i.spellcheck=false; i.autocomplete='off';
    d.appendChild(i); row.appendChild(d); return i;
  }
  field('collection handle (e.g. pet-toys)',handle);
  field('supplier tag (e.g. cj-pet-toys)',tag);
  var rm=document.createElement('button'); rm.className='ghost'; rm.type='button'; rm.textContent='Remove';
  rm.onclick=function(){ row.remove(); };
  row.appendChild(rm);
  el('maprows').appendChild(row);
}
async function refresh(){
  try{
    var s=await api('/status');
    renderStatus(s);
    populateForms(s);
    setMsg('cjstatus', s.cjConnected?'Connected ✓':'Not connected — enter your CJ API key above.', s.cjConnected?'ok':'muted');
  }catch(e){
    el('status').innerHTML='<p class="msg no">Could not load configuration: '+esc(errText(e))+'</p>';
    setMsg('cjstatus','Could not reach PawScout. Reload the page.','no');
  }
}
async function loadInsights(){
  try{
    var r=await api('/insights');
    var html='';
    var cats=(r&&r.categories)||[];
    if(cats.length){
      html+='<div class="muted" style="font-weight:550;color:var(--ink)">Category fill (store / warehouse)</div><ul class="cols">'
        +cats.map(function(c){
          var low=Number(c.imported)<Number(c.floor);
          return '<li><strong>'+esc(c.key)+'</strong> <span class="badge '+(low?'no':'ok')+'">'+esc(c.imported)+' / '+esc(c.target)+' listed</span> <span class="muted">· floor '+esc(c.floor)+' · warehouse '+esc(c.warehouse)+'</span></li>';
        }).join('')+'</ul><hr>';
    }
    var ks=(r&&r.keywords)||[];
    if(ks.length){
      html+='<div class="muted" style="font-weight:550;color:var(--ink)">Top searches — 30 days</div><ul class="cols">'
        +ks.map(function(k){
          var fill=(Number(k.avg_store_hits)+Number(k.avg_ghost_hits)).toFixed(1);
          return '<li><strong>'+esc(k.keyword_norm)+'</strong> <span class="muted">· '+esc(k.searches)+' searches · avg fill</span> <code>'+esc(fill)+'</code></li>';
        }).join('')+'</ul>';
    }
    if(r&&r.llmSpend&&r.llmSpend.calls>0){
      html+='<p class="muted" style="margin-top:10px">AI curation: '+esc(r.llmSpend.calls)+' calls · $'+esc(Number(r.llmSpend.costUsd).toFixed(4))+' (30 days)</p>';
    }
    el('insights').innerHTML=html||'<p class="muted">No storefront searches hit the backfill yet.</p>';
  }catch(e){
    el('insights').innerHTML='<p class="muted">Insights unavailable.</p>';
  }
}
async function connectCj(){
  var btn=el('cjbtn'); btn.disabled=true; setMsg('cjstatus','Connecting…','muted');
  try{
    var key=el('cj').value.trim();
    if(!key){ setMsg('cjstatus','Enter your CJ API key first.','no'); return; }
    var r=await api('/connect-cj',{apiKey:key});
    if(r.ok){ el('cj').value=''; setMsg('cjstatus','Connected ✓','ok'); refresh(); }
    else { setMsg('cjstatus','Failed: '+(r.error||'unknown error'),'no'); }
  }catch(e){ setMsg('cjstatus','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function saveGates(){
  setMsg('gatesmsg','Saving…','muted');
  try{
    var r=await api('/gates',{
      popularityFloor:Number(el('pf').value),
      priceMin:Number(el('pmin').value),
      priceMax:Number(el('pmax').value),
      relevance:el('rel').value,
      target:Number(el('tgt').value)
    });
    if(r.ok){ setMsg('gatesmsg','Saved ✓','ok'); refresh(); }
    else setMsg('gatesmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('gatesmsg','Failed: '+errText(e),'no'); }
}
async function savePricing(){
  setMsg('pricingmsg','Saving…','muted');
  try{
    var r=await api('/pricing',{
      multiplier:Number(el('pmult').value),
      floor:Number(el('pfloor').value),
      minMarginGbp:Number(el('pmm').value),
      fxUsdToGbp:Number(el('pfx').value),
      fxBufferPct:Number(el('pfxb').value)
    });
    if(r.ok){ setMsg('pricingmsg','Saved ✓','ok'); refresh(); }
    else setMsg('pricingmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('pricingmsg','Failed: '+errText(e),'no'); }
}
async function saveLlm(){
  setMsg('llmmsg','Saving…','muted');
  try{
    var r=await api('/llm',{
      enabled:el('llmon').value==='true',
      scoreThreshold:Number(el('llmthresh').value),
      models:{ image:(el('mdl-image')&&el('mdl-image').value)||'', text:(el('mdl-text')&&el('mdl-text').value)||'', fallback:(el('mdl-fallback')&&el('mdl-fallback').value)||'' }
    });
    if(r.ok){ setMsg('llmmsg','Saved ✓','ok'); refresh(); }
    else setMsg('llmmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('llmmsg','Failed: '+errText(e),'no'); }
}
function syncBar(mode,frac){
  var b=el('syncbar'); if(!b) return;
  b.className='bar'+(mode==='off'?'':' on')+(mode==='pulse'?' pulse':'');
  if(mode==='frac') b.querySelector('i').style.width=Math.round((frac||0)*100)+'%';
}
async function heroImagesNow(){
  var btn=el('herobtn'); btn.disabled=true;
  try{
    setMsg('heromsg','Reviewing product images…','muted');
    syncBar('frac',0);
    var offset=0, fixed=0, scanned=0, total=0;
    for(;;){
      var r=await api('/hero-images',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('heromsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      fixed+=r.fixed; scanned+=r.scanned; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('heromsg','Reviewed '+Math.min(offset+r.scanned,total)+' of '+total+'… '+fixed+' default image'+(fixed===1?'':'s')+' fixed','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('heromsg','Done ✓ '+fixed+' default image'+(fixed===1?'':'s')+' fixed across '+total+' product'+(total===1?'':'s')+'.','ok');
  }catch(e){ syncBar('off'); setMsg('heromsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function rewriteDescsNow(){
  var btn=el('descbtn'); btn.disabled=true;
  try{
    setMsg('descmsg','Checking descriptions for raw supplier copy…','muted');
    syncBar('frac',0);
    var offset=0, rewritten=0, total=0;
    for(;;){
      var r=await api('/descriptions',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('descmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      rewritten+=r.rewritten; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('descmsg','Scanned '+Math.min(offset+r.scanned,total)+' of '+total+'… '+rewritten+' rewritten','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('descmsg','Done ✓ '+rewritten+' description'+(rewritten===1?'':'s')+' rewritten of '+total+' scanned.','ok');
  }catch(e){ syncBar('off'); setMsg('descmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
var currentMode='manual';
var currentCreateOnly=false;
var armPawscout=false;
function renderMode(){
  var l=el('modelabel'); if(!l) return;
  var base=({manual:'Manual (queue only)',cj:'CJ app (PawScout not managing)',pawscout:'PawScout auto (create + pay + track)'}[currentMode]||currentMode);
  l.textContent=base+((currentMode==='pawscout'&&currentCreateOnly)?' — create-only (you pay in CJ)':'');
  var cb=el('createonlybtn');
  if(cb){ cb.textContent='Create-only: '+(currentCreateOnly?'ON':'OFF'); cb.disabled=(currentMode!=='pawscout'); }
}
async function applyMode(mode){
  try{
    var r=await api('/fulfil',{mode:mode});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode; currentCreateOnly=!!r.createOnly; renderMode();
    setMsg('ordmsg','Fulfilment mode set to '+r.mode+'.',r.mode==='pawscout'?'ok':'muted');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function toggleCreateOnly(){
  if(currentMode!=='pawscout'){ setMsg('ordmsg','Create-only only applies in PawScout auto mode.','muted'); return; }
  try{
    var next=!currentCreateOnly;
    var r=await api('/fulfil',{mode:'pawscout',createOnly:next});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode; currentCreateOnly=!!r.createOnly; renderMode();
    setMsg('ordmsg',currentCreateOnly?'Create-only ON — PawScout will create CJ orders and leave them for you to pay in CJ.':'Create-only OFF — PawScout will pay CJ orders from the wallet balance.',currentCreateOnly?'muted':'ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function setMode(mode){
  if(mode!=='pawscout'){ armPawscout=false; await applyMode(mode); return; }
  // PawScout mode spends money: inline two-click confirm (confirm() is blocked in the admin iframe)
  if(!armPawscout){
    armPawscout=true;
    setMsg('ordmsg','⚠ PawScout mode auto-CREATES and PAYS CJ orders from your wallet. First fund the CJ wallet AND turn OFF CJ native order-import (else duplicate orders). Click PawScout auto again within 8s to confirm.','no');
    setTimeout(function(){ if(armPawscout){ armPawscout=false; setMsg('ordmsg','Cancelled.','muted'); } },8000);
    return;
  }
  armPawscout=false; await applyMode('pawscout');
}
function alertEmailVal(){ return (el('alertemail')&&el('alertemail').value||'').trim(); }
async function sendTestEmail(){
  var b=el('testemailbtn'); var to=alertEmailVal();
  if(!to||to.indexOf('@')<0){ setMsg('ordmsg','Enter a valid email.','no'); return; }
  b.disabled=true; setMsg('ordmsg','Sending test email to '+to+'…','muted');
  try{
    var r=await api('/test-email',{to:to});
    if(!r.ok){ setMsg('ordmsg','Test email failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','Test email sent ✓ (Resend id '+(r.id||'?')+'). Check '+to+' (and spam).','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function saveAlertEmail(){
  var b=el('savealertbtn'); var to=alertEmailVal();
  if(to&&to.indexOf('@')<0){ setMsg('ordmsg','Enter a valid email (or clear it to disable alerts).','no'); return; }
  b.disabled=true;
  try{
    var r=await api('/fulfil',{mode:currentMode,alertEmail:to});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg',to?('Alert email saved — PawScout will notify '+to+' on each CJ order awaiting payment.'):'Alert email cleared — no awaiting-payment emails will be sent.','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function runFulfilNow(){
  var b=el('runbtn'); b.disabled=true;
  setMsg('ordmsg','Running fulfilment (create due CJ orders + poll tracking)…','muted');
  try{
    var r=await api('/fulfil-run',{});
    if(!r.ok){ setMsg('ordmsg','Fulfilment run failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','Fulfilment run ✓ — created/awaiting '+(r.awaiting||0)+', submitted '+(r.submitted||0)+', errored '+(r.errored||0)+', tracking checked '+(r.checked||0)+', fulfilled '+(r.fulfilled||0)+'.',(r.errored?'no':'ok'));
    loadOrders();
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function verifyCjOrders(){
  var b=el('cjdiagbtn'); b.disabled=true;
  setMsg('ordmsg','Checking CJ order API (read-only)…','muted');
  try{
    var r=await api('/cj-order-diag',{});
    if(!r.ok){ setMsg('ordmsg','CJ order API check failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','CJ order API reachable ✓ (read-only list returned).','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function loadOrders(){
  var btn=el('ordbtn'); btn.disabled=true;
  try{
    var r=await api('/orders',{});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode||'manual'; currentCreateOnly=!!r.createOnly; renderMode();
    if(r.alertEmail&&el('alertemail')) el('alertemail').value=r.alertEmail;
    var list=el('ordlist');
    var awaiting=(r.orders||[]).filter(function(o){return o.status==='awaiting-payment';});
    var banner=el('awaitbanner');
    if(banner){
      if(awaiting.length){
        var ids=awaiting.map(function(o){return esc(o.cj||o.name||o.id);}).join(', ');
        banner.className='msg no'; banner.style.display='';
        banner.textContent='⚠ '+awaiting.length+' order(s) created in CJ awaiting your payment. Pay these CJ order(s) in app.cjdropshipping.com: '+ids+'. Tracking will sync back automatically once paid.';
      } else { banner.style.display='none'; banner.textContent=''; }
    }
    if(!r.orders.length){ list.innerHTML=''; setMsg('ordmsg','No orders yet.','muted'); return; }
    setMsg('ordmsg','','muted');
    var rows=r.orders.map(function(o){
      var holds=(o.holds&&o.holds.length)?(' · '+o.holds.join(', ')):'';
      var act='';
      if(o.status==='held') act='<button class="ghost" data-act="release" data-id="'+esc(o.id)+'">Release</button> <button class="ghost" data-act="cancel" data-id="'+esc(o.id)+'">Cancel</button>';
      else if(o.status==='queued') act='<button class="ghost" data-act="cancel" data-id="'+esc(o.id)+'">Cancel</button>';
      var tn=o.tracking?(' · '+esc(o.tracking)):'';
      var cjid=((o.status==='awaiting-payment'||o.status==='submitted')&&o.cj)?(' · CJ '+esc(o.cj)):'';
      return '<tr><td>'+esc(o.name||o.id)+'</td><td>'+esc((o.currency||'')+' '+(o.total!=null?o.total:''))+'</td><td><strong>'+esc(o.status)+'</strong>'+esc(holds)+cjid+tn+'</td><td>'+act+'</td></tr>';
    }).join('');
    list.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left">Order</th><th style="text-align:left">Total</th><th style="text-align:left">Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
    var bts=list.querySelectorAll('button[data-act]');
    for(var i=0;i<bts.length;i++){ bts[i].onclick=function(){ orderAction(this.getAttribute('data-id'), this.getAttribute('data-act')); }; }
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function orderAction(id,action){
  try{
    var r=await api('/order-action',{id:id,action:action});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    loadOrders();
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function fixCategoriesNow(){
  var btn=el('catbtn'); btn.disabled=true;
  try{
    setMsg('catmsg','Re-checking collection assignments…','muted');
    syncBar('frac',0);
    var offset=0, moved=0, total=0;
    for(;;){
      var r=await api('/categories',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('catmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      moved+=r.moved; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('catmsg','Checked '+Math.min(offset+r.scanned,total)+' of '+total+'… '+moved+' re-filed','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('catmsg','Done ✓ '+moved+' product'+(moved===1?'':'s')+' re-filed to a clearer collection ('+total+' checked).','ok');
  }catch(e){ syncBar('off'); setMsg('catmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function runDiag(){
  var btn=el('diagbtn'); btn.disabled=true;
  var out=el('diagout');
  out.className='msg muted'; out.textContent='Running CJ listV2 + Firecrawl (can take ~30s)…';
  try{
    var r=await api('/search-diag',{q:el('diagq').value});
    if(!r.ok){ out.className='msg no'; out.textContent='Failed: '+(r.error||'unknown'); return; }
    function fmt(list){ return (list||[]).map(function(x){ return '• '+esc(x.title)+(x.price!=null?(' — '+esc(x.price)):''); }).join('<br>'); }
    out.className='msg';
    out.innerHTML='<strong>Our listV2 ('+r.oursCount+')</strong><br>'+fmt(r.ours)+'<hr><strong>CJ website / Firecrawl ('+r.webCount+')</strong><br>'+fmt(r.web);
  }catch(e){ out.className='msg no'; out.textContent='Failed: '+errText(e); }
  finally{ btn.disabled=false; }
}
// --- Country combobox (searchable; single source of truth for the quote card) ---
var FQ_COUNTRIES=[
  {g:'UK & Ireland',c:'GB',n:'United Kingdom'},{g:'UK & Ireland',c:'IE',n:'Ireland'},
  {g:'Western Europe',c:'ES',n:'Spain'},{g:'Western Europe',c:'FR',n:'France'},{g:'Western Europe',c:'DE',n:'Germany'},
  {g:'Western Europe',c:'IT',n:'Italy'},{g:'Western Europe',c:'NL',n:'Netherlands'},{g:'Western Europe',c:'BE',n:'Belgium'},
  {g:'Western Europe',c:'PT',n:'Portugal'},{g:'Western Europe',c:'AT',n:'Austria'},{g:'Western Europe',c:'LU',n:'Luxembourg'},
  {g:'Western Europe',c:'CH',n:'Switzerland'},
  {g:'Nordics',c:'SE',n:'Sweden'},{g:'Nordics',c:'DK',n:'Denmark'},{g:'Nordics',c:'FI',n:'Finland'},{g:'Nordics',c:'NO',n:'Norway'},
  {g:'Central & Eastern Europe',c:'PL',n:'Poland'},{g:'Central & Eastern Europe',c:'CZ',n:'Czechia'},
  {g:'Central & Eastern Europe',c:'SK',n:'Slovakia'},{g:'Central & Eastern Europe',c:'HU',n:'Hungary'},
  {g:'Central & Eastern Europe',c:'RO',n:'Romania'},{g:'Central & Eastern Europe',c:'BG',n:'Bulgaria'},
  {g:'Central & Eastern Europe',c:'GR',n:'Greece'},{g:'Central & Eastern Europe',c:'HR',n:'Croatia'},
  {g:'Central & Eastern Europe',c:'SI',n:'Slovenia'},{g:'Central & Eastern Europe',c:'EE',n:'Estonia'},
  {g:'Central & Eastern Europe',c:'LV',n:'Latvia'},{g:'Central & Eastern Europe',c:'LT',n:'Lithuania'},
  {g:'North America',c:'US',n:'United States'},{g:'North America',c:'CA',n:'Canada'},
  {g:'Oceania',c:'AU',n:'Australia'},{g:'Oceania',c:'NZ',n:'New Zealand'},
  {g:'Asia & Middle East',c:'SG',n:'Singapore'},{g:'Asia & Middle East',c:'HK',n:'Hong Kong'},
  {g:'Asia & Middle East',c:'JP',n:'Japan'},{g:'Asia & Middle East',c:'KR',n:'South Korea'},
  {g:'Asia & Middle East',c:'MY',n:'Malaysia'},{g:'Asia & Middle East',c:'AE',n:'United Arab Emirates'},
  {g:'Asia & Middle East',c:'SA',n:'Saudi Arabia'}
];
var fqShown=[], fqActive=-1;
function fqFind(code){ for(var i=0;i<FQ_COUNTRIES.length;i++){ if(FQ_COUNTRIES[i].c===code) return FQ_COUNTRIES[i]; } return null; }
function fqCountryRender(filter){
  var f=(filter||'').trim().toLowerCase(), html='', lastG='';
  fqShown=[];
  for(var i=0;i<FQ_COUNTRIES.length;i++){
    var x=FQ_COUNTRIES[i];
    if(f && x.n.toLowerCase().indexOf(f)<0 && x.c.toLowerCase().indexOf(f)<0) continue;
    if(x.g!==lastG){ html+='<div class="combo-grp">'+esc(x.g)+'</div>'; lastG=x.g; }
    html+='<div class="combo-opt" data-code="'+x.c+'"><span>'+esc(x.n)+'</span><span class="cc">'+x.c+'</span></div>';
    fqShown.push(x.c);
  }
  el('fqcountrymenu').innerHTML=html||'<div class="combo-empty">No match</div>';
  fqActive=-1;
}
function fqCountryMenuClick(e){
  var opt=e.target.closest?e.target.closest('.combo-opt'):null;
  if(!opt) return;
  e.preventDefault(); // keep focus on the input so onblur doesn't pre-empt the pick
  fqCountryPick(opt.getAttribute('data-code'));
}
function fqHighlight(){
  var opts=el('fqcountrymenu').querySelectorAll('.combo-opt');
  for(var i=0;i<opts.length;i++){ if(i===fqActive){ opts[i].classList.add('active'); opts[i].scrollIntoView({block:'nearest'}); } else opts[i].classList.remove('active'); }
}
function fqCountryOpen(){ el('fqcountry').select(); fqCountryRender(''); el('fqcountrymenu').classList.add('on'); }
function fqCountryFilter(){ fqCountryRender(el('fqcountry').value); el('fqcountrymenu').classList.add('on'); }
function fqCountryClose(){ el('fqcountrymenu').classList.remove('on'); }
function fqCountryPick(code){ var x=fqFind(code); if(!x) return; var inp=el('fqcountry'); inp.value=x.n; inp.dataset.code=x.c; fqCountryClose(); }
function fqCountryBlur(){ setTimeout(function(){ fqCountryClose(); var inp=el('fqcountry'), x=fqFind(inp.dataset.code); if(x) inp.value=x.n; },150); }
function fqCountryKey(e){
  var open=el('fqcountrymenu').classList.contains('on');
  if(e.key==='ArrowDown'){ if(!open){ fqCountryFilter(); } fqActive=Math.min(fqActive+1,fqShown.length-1); fqHighlight(); e.preventDefault(); }
  else if(e.key==='ArrowUp'){ fqActive=Math.max(fqActive-1,0); fqHighlight(); e.preventDefault(); }
  else if(e.key==='Enter'){ if(open&&fqShown.length){ fqCountryPick(fqShown[fqActive<0?0:fqActive]); e.preventDefault(); } }
  else if(e.key==='Escape'){ fqCountryClose(); }
}
async function freightQuote(){
  var b=el('fqbtn'); b.disabled=true;
  var out=el('fqout');
  var pid=(el('fqpid').value||'').trim();
  var country=((el('fqcountry').dataset.code||'GB').trim().toUpperCase());
  var qty=Math.max(1,Math.min(100,parseInt(el('fqqty').value,10)||1));
  out.className='msg muted'; out.textContent='Asking CJ for live freight on '+qty+'× to '+esc(country)+'…';
  try{
    var r=await api('/freight-quote',{pid:pid,country:country,qty:qty});
    if(!r.ok){ out.className='msg no'; out.textContent='Failed: '+(r.error||'unknown'); return; }
    if(!r.options.length){ out.className='msg no'; out.textContent='CJ returned no shipping lines to '+esc(r.country)+' for this product.'; return; }
    var rows=r.options.map(function(o){ return '<tr><td>'+esc(o.name)+'</td><td>$'+esc(o.usd.toFixed(2))+'</td><td>£'+esc(o.gbp.toFixed(2))+'</td><td class="muted">'+esc(o.days||'')+' days</td></tr>'; }).join('');
    out.className='msg';
    out.innerHTML='<strong>'+esc(r.product)+'</strong><br><span class="muted">'+esc(String(r.qty||qty))+'× · ships from '+esc(r.origin)+' → '+esc(r.country)+'</span>'
      +'<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px"><thead><tr><th style="text-align:left">Line</th><th style="text-align:left">USD</th><th style="text-align:left">GBP</th><th style="text-align:left">Aging</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){ out.className='msg no'; out.textContent='Failed: '+errText(e); }
  finally{ b.disabled=false; }
}
async function syncNow(){
  var btn=el('syncbtn'); btn.disabled=true;
  var failures=[];
  try{
    setMsg('syncmsg','Syncing prices & stock with CJ…','muted');
    syncBar('frac',0);
    var offset=0, done=0, attempted=0, total=0;
    for(;;){
      var r=await api('/sync',{phase:'inventory',offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('syncmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      done+=r.synced; total=r.total;
      if(r.errors&&r.errors.length) failures=failures.concat(r.errors);
      attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('syncmsg','Synced '+done+' of '+total+' products… ('+attempted+' checked)','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    setMsg('syncmsg','Topping up collections from the warehouse…','muted');
    syncBar('pulse');
    var promoted=0;
    for(;;){
      var p=await api('/sync',{phase:'refill'});
      if(!p.ok){ syncBar('off'); setMsg('syncmsg','Sync done ('+done+' products) — refill failed: '+(p.error||'unknown error'),'no'); return; }
      promoted+=p.imported;
      if(p.next==null) break;
    }
    syncBar('off');
    if(failures.length&&done<total){
      setMsg('syncmsg','Synced '+done+' of '+total+' — '+(total-done)+' failed. First error: '+failures[0],'no');
    } else {
      setMsg('syncmsg','Done ✓ '+done+' products synced'+(promoted?', '+promoted+' promoted from warehouse':'')+'.','ok');
    }
    loadInsights();
  }catch(e){ syncBar('off'); setMsg('syncmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function saveAddons(){
  setMsg('addmsg','Saving…','muted');
  try{
    var r=await api('/addons',{
      enabled:el('addon').value==='true',
      priceMinUsd:Number(el('addmin').value),
      priceMaxUsd:Number(el('addmax').value),
      poolSize:Number(el('addpool').value),
      suppressFromBrowse:el('addvis').value==='true'
    });
    if(r.ok){ setMsg('addmsg','Saved ✓','ok'); refresh(); }
    else setMsg('addmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('addmsg','Failed: '+errText(e),'no'); }
}
async function saveCollections(){
  setMsg('mapmsg','Saving…','muted');
  try{
    var map={};
    var rows=el('maprows').querySelectorAll('.maprow');
    for(var i=0;i<rows.length;i++){
      var ins=rows[i].querySelectorAll('input');
      var h=ins[0].value.trim(), t=ins[1].value.trim();
      if(!h&&!t) continue;
      if(!h||!t){ setMsg('mapmsg','Each mapping needs both a handle and a tag.','no'); return; }
      map[h]={handle:h,tag:t};
    }
    var r=await api('/collections',map);
    if(r.ok){ setMsg('mapmsg','Saved ✓','ok'); refresh(); }
    else setMsg('mapmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('mapmsg','Failed: '+errText(e),'no'); }
}
async function loadInboxThreads(){
  var status=(el('inbox-status-filter')&&el('inbox-status-filter').value)||'';
  var list=el('inbox-threads');
  if(list) list.innerHTML='<p class="muted">Loading…</p>';
  el('inbox-thread').innerHTML='';
  setMsg('inboxmsg','','muted');
  try{
    var body=status?{status:status}:{};
    var r=await api('/inbox/threads',body);
    if(!r.ok){ if(list) list.innerHTML='<p class="msg no">'+esc(r.error||'Failed to load threads')+'</p>'; return; }
    renderInboxThreads(r.threads||[]);
  }catch(e){ if(list) list.innerHTML='<p class="msg no">'+esc(errText(e))+'</p>'; }
}
function renderInboxThreads(threads){
  var list=el('inbox-threads');
  if(!list) return;
  if(!threads.length){ list.innerHTML='<p class="muted">No messages yet.</p>'; return; }
  list.innerHTML='';
  for(var i=0;i<threads.length;i++){
    var t=threads[i];
    var row=document.createElement('button');
    row.className='inbox-row';
    row.setAttribute('data-id',t.id);
    var meta=esc(t.status||'')+(t.intentScore!=null?' · intent '+esc(t.intentScore):'')+(t.category?' · '+esc(t.category):'')+(t.lastMessageAt?' · '+esc(t.lastMessageAt.slice(0,16).replace('T',' ')):'');
    row.innerHTML='<span class="inbox-row__who">'+esc(t.contactEmail||'(unknown)')+'</span>'
      +'<span class="inbox-row__subj">'+esc(t.subject||'(no subject)')+'</span>'
      +'<span class="inbox-row__meta">'+meta+'</span>';
    (function(id){ row.onclick=function(){ openInboxThread(id); }; })(t.id);
    list.appendChild(row);
  }
}
async function openInboxThread(id){
  var detail=el('inbox-thread');
  if(detail) detail.innerHTML='<p class="muted">Loading thread…</p>';
  setMsg('inboxmsg','','muted');
  try{
    var r=await api('/inbox/thread',{id:id});
    if(!r.ok){ if(detail) detail.innerHTML='<p class="msg no">'+esc(r.error||'Failed to load thread')+'</p>'; return; }
    renderInboxThread(r.thread,r.messages||[],r.labels||[],r.draft||null,r.invoice||null);
  }catch(e){ if(detail) detail.innerHTML='<p class="msg no">'+esc(errText(e))+'</p>'; }
}
function renderInboxThread(thread,messages,labels,draft,invoice){
  var detail=el('inbox-thread');
  if(!detail) return;
  inboxInvoiceItems=[];
  var msgHtml='<hr>';
  for(var i=0;i<messages.length;i++){
    var m=messages[i];
    var isOut=m.direction==='outbound';
    var dir=isOut?'You → '+esc(m.to_addr||''):'From: '+esc(m.from_addr||'');
    var ts=m.received_at?esc(m.received_at.slice(0,16).replace('T',' ')):'';
    msgHtml+='<div class="inbox-msg'+(isOut?' outbound':'')+'">'
      +'<div class="inbox-msg__hdr">'+dir+(ts?' · '+ts:'')+'</div>'
      +'<div class="inbox-msg__body">'+esc(m.body_text||'(no body)')+'</div>'
      +'</div>';
  }
  var draftHtml='';
  if(draft&&draft.id){
    var holdNote='';
    if(draft.hold_reasons){
      try{
        var reasons=JSON.parse(draft.hold_reasons);
        if(reasons&&reasons.length) holdNote='<p class="inbox-hold">Hold: '+esc(reasons.join(', '))+'</p>';
      }catch(e2){}
    }
    draftHtml='<div class="inbox-draft-section">'
      +'<label style="font-weight:600;margin-bottom:6px">Draft reply</label>'
      +holdNote
      +'<textarea id="inbox-draft">'+esc(draft.body_text||'')+'</textarea>'
      +'<div class="row" style="margin-top:8px">'
      +'<button id="inbox-approve-btn">Approve &amp; Send</button>'
      +'<button id="inbox-discard-btn" class="ghost">Discard</button>'
      +'</div>'
      +'</div>';
  }
  // Invoice card — only when thread has an open invoice
  var invoiceHtml='';
  if(invoice&&invoice.id){
    var invItems=[];
    try{ invItems=JSON.parse(invoice.line_items_json||'[]'); }catch(e2){}
    var invRows=invItems.map(function(li){
      return '<tr><td>'+esc(li.title||'')+'</td><td style="text-align:right">'+esc(String(li.qty||1))+'</td><td style="text-align:right">£'+esc(Number(li.priceGbp||0).toFixed(2))+'</td></tr>';
    }).join('');
    var invUrlHtml='';
    if(invoice.status==='sent'&&invoice.invoice_url){
      invUrlHtml='<p style="margin:8px 0 0"><a href="'+esc(invoice.invoice_url)+'" target="_blank" rel="noopener noreferrer" style="color:var(--ok-ink)">Open invoice link ↗</a></p>';
    }
    invoiceHtml='<div class="inbox-draft-section">'
      +'<label style="font-weight:600;margin-bottom:6px">Invoice <span class="badge '+(invoice.status==='sent'?'ok':'no')+'">'+esc(invoice.status)+'</span></label>'
      +'<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:6px"><thead><tr><th style="text-align:left">Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr></thead><tbody>'+invRows+'</tbody></table>'
      +'<p style="margin:8px 0 0;font-weight:600">Total: £'+esc(Number(invoice.total||0).toFixed(2))+'</p>'
      +invUrlHtml
      +'<div class="row" style="margin-top:8px">'
      +'<button id="inbox-invoice-discard-btn" class="ghost">Discard invoice</button>'
      +'</div>'
      +'</div>';
  }
  // Catalog search + new invoice builder (shown when no open invoice)
  var catalogHtml='';
  if(!invoice||!invoice.id){
    catalogHtml='<div class="inbox-draft-section">'
      +'<label style="font-weight:600;margin-bottom:6px">Build invoice</label>'
      +'<div class="row" style="margin-bottom:6px">'
      +'<div class="grow"><label for="inbox-catalog-q">Search catalog</label><input id="inbox-catalog-q" type="text" placeholder="e.g. harness" autocomplete="off" spellcheck="false"></div>'
      +'<button id="inbox-catalog-search-btn" class="ghost">Search</button>'
      +'</div>'
      +'<div id="inbox-catalog-results" style="margin-bottom:8px;font-size:13px;color:var(--subdued)"></div>'
      +'<div id="inbox-invoice-items" style="font-size:13px;margin-bottom:8px"></div>'
      +'<div style="margin-bottom:6px"><label for="inbox-invoice-cover">Cover note (optional)</label><textarea id="inbox-invoice-cover" style="width:100%;min-height:60px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;font-family:inherit;resize:vertical" placeholder="e.g. Here is the invoice for the items we discussed."></textarea></div>'
      +'<div class="row" style="margin-top:8px">'
      +'<button id="inbox-invoice-build-btn">Approve &amp; Send invoice</button>'
      +'</div>'
      +'<p id="inbox-invoice-msg" class="msg muted"></p>'
      +'</div>';
  }
  var labOpts=['lead','product-question','order-status','shipping-returns','wholesale-b2b','affiliate','complaint','spam','automated','other'];
  var labSel='<select id="inbox-label-sel" multiple size="4" style="width:100%;font-size:13px">';
  for(var j=0;j<labOpts.length;j++){
    var isSel=labels.indexOf(labOpts[j])>=0?' selected':'';
    labSel+='<option value="'+esc(labOpts[j])+'"'+isSel+'>'+esc(labOpts[j])+'</option>';
  }
  labSel+='</select>';
  var statOpts=['new','needs_reply','awaiting_customer','converted','closed','spam'];
  var statSel='<select id="inbox-status-sel" style="width:100%;font-size:13px">';
  for(var k=0;k<statOpts.length;k++){
    var isCur=thread.status===statOpts[k]?' selected':'';
    statSel+='<option value="'+esc(statOpts[k])+'"'+isCur+'>'+esc(statOpts[k])+'</option>';
  }
  statSel+='</select>';
  detail.innerHTML='<hr><div id="inbox-reconnect-banner" style="display:none;margin-bottom:8px;padding:8px 12px;background:var(--no-bg);color:var(--no-ink);border-radius:8px;font-size:13px"></div>'
    +'<strong>'+esc(thread.contact_email||'')+'</strong>'
    +' — <span class="muted">'+esc(thread.subject||'(no subject)')+'</span>'
    +(thread.summary?'<p class="muted" style="margin:6px 0 0;font-size:12px">'+esc(thread.summary)+'</p>':'')
    +msgHtml
    +draftHtml
    +invoiceHtml
    +catalogHtml
    +'<div class="inbox-controls">'
    +'<div class="grow"><label>Status</label>'+statSel+'</div>'
    +'<div class="grow"><label>Labels (multi-select)</label>'+labSel+'</div>'
    +'<button id="inbox-save-status" class="ghost">Save status</button>'
    +'<button id="inbox-save-labels" class="ghost">Save labels</button>'
    +'</div>';
  var tid=thread.id;
  var ssb=el('inbox-save-status'); if(ssb) ssb.onclick=function(){ saveInboxStatus(tid); };
  var slb=el('inbox-save-labels'); if(slb) slb.onclick=function(){ saveInboxLabels(tid); };
  if(draft&&draft.id){
    var draftId=draft.id;
    var appBtn=el('inbox-approve-btn');
    if(appBtn) appBtn.onclick=function(){
      var ta=el('inbox-draft');
      var body=ta?ta.value:'';
      approveDraftAction(draftId,body,tid);
    };
    var discBtn=el('inbox-discard-btn');
    if(discBtn) discBtn.onclick=function(){ discardDraftAction(draftId,tid); };
  }
  // Invoice card: wire discard button
  if(invoice&&invoice.id){
    var invDiscBtn=el('inbox-invoice-discard-btn');
    if(invDiscBtn){ (function(invId,tId){ invDiscBtn.onclick=function(){ discardInvoiceAction(invId,tId); }; })(invoice.id,tid); }
  }
  // Catalog search + invoice builder: wire search and build buttons
  if(!invoice||!invoice.id){
    var invItems2=[];
    var catalogSearchBtn=el('inbox-catalog-search-btn');
    if(catalogSearchBtn){ (function(tId){ catalogSearchBtn.onclick=function(){ runCatalogSearch(tId); }; })(tid); }
    var invBuildBtn=el('inbox-invoice-build-btn');
    if(invBuildBtn){ (function(tId){ invBuildBtn.onclick=function(){ buildInvoiceAction(tId); }; })(tid); }
  }
}
async function approveDraftAction(draftId,body,threadId){
  setMsg('inboxmsg','Sending…','muted');
  var appBtn=el('inbox-approve-btn'); if(appBtn) appBtn.disabled=true;
  try{
    var r=await api('/inbox/approve',{id:draftId,body:body});
    if(r.ok){ openInboxThread(threadId); loadInboxThreads(); setMsg('inboxmsg','Sent ✓','ok'); }
    else { setMsg('inboxmsg','Failed: '+esc(r.error||'unknown error'),'no'); if(appBtn) appBtn.disabled=false; }
  }catch(e){ setMsg('inboxmsg','Failed: '+errText(e),'no'); if(appBtn&&el('inbox-approve-btn')) el('inbox-approve-btn').disabled=false; }
}
async function discardDraftAction(draftId,threadId){
  setMsg('inboxmsg','Discarding…','muted');
  var discBtn=el('inbox-discard-btn'); if(discBtn) discBtn.disabled=true;
  try{
    var r=await api('/inbox/discard',{id:draftId});
    if(r.ok){ openInboxThread(threadId); loadInboxThreads(); setMsg('inboxmsg','Draft discarded.','muted'); }
    else { setMsg('inboxmsg','Failed: '+esc(r.error||'unknown error'),'no'); if(discBtn) discBtn.disabled=false; }
  }catch(e){ setMsg('inboxmsg','Failed: '+errText(e),'no'); if(discBtn&&el('inbox-discard-btn')) el('inbox-discard-btn').disabled=false; }
}
// --- Invoice catalog search ---
// Uses POST (consistent with api()) — the route is /api/inbox/catalog, POST {q}.
var inboxInvoiceItems=[]; // [{variantId, title, qty, priceGbp}]
function renderInvoiceItems(){
  var box=el('inbox-invoice-items');
  if(!box) return;
  if(!inboxInvoiceItems.length){ box.innerHTML='<span class="muted">No items added yet.</span>'; return; }
  var rows=inboxInvoiceItems.map(function(item,idx){
    return '<div class="row" style="margin-bottom:4px">'
      +'<span class="grow">'+esc(item.title)+'</span>'
      +'<input type="number" min="1" max="99" value="'+esc(String(item.qty))+'" style="width:64px" data-inv-qty="'+idx+'">'
      +'<span style="width:70px;text-align:right">£'+esc(Number(item.priceGbp||0).toFixed(2))+'</span>'
      +'<button class="ghost" style="padding:4px 8px" data-inv-rm="'+idx+'">✕</button>'
      +'</div>';
  }).join('');
  box.innerHTML=rows;
  var qtyInputs=box.querySelectorAll('input[data-inv-qty]');
  for(var qi=0;qi<qtyInputs.length;qi++){
    (function(inp,i){ inp.onchange=function(){ var v=Math.max(1,parseInt(inp.value,10)||1); inboxInvoiceItems[i].qty=v; inp.value=v; }; })(qtyInputs[qi],Number(qtyInputs[qi].getAttribute('data-inv-qty')));
  }
  var rmBtns=box.querySelectorAll('button[data-inv-rm]');
  for(var ri=0;ri<rmBtns.length;ri++){
    (function(btn){ btn.onclick=function(){ inboxInvoiceItems.splice(Number(btn.getAttribute('data-inv-rm')),1); renderInvoiceItems(); }; })(rmBtns[ri]);
  }
}
async function runCatalogSearch(threadId){
  var qEl=el('inbox-catalog-q'); var q=(qEl&&qEl.value.trim())||'';
  if(!q) return;
  var resEl=el('inbox-catalog-results');
  if(resEl) resEl.textContent='Searching…';
  try{
    var r=await api('/inbox/catalog',{q:q});
    if(r.ok===false&&r.error==='reconnect_required'){
      showReconnectBanner(); if(resEl) resEl.textContent=''; return;
    }
    if(!r.ok){ if(resEl) resEl.textContent='Search failed: '+(r.error||'unknown'); return; }
    var variants=r.variants||[];
    if(!variants.length){ if(resEl) resEl.textContent='No products found.'; return; }
    if(resEl){
      resEl.innerHTML='';
      variants.slice(0,12).forEach(function(v){
        var btn=document.createElement('button');
        btn.className='ghost'; btn.style.cssText='display:block;width:100%;text-align:left;margin-bottom:4px;font-size:13px';
        btn.textContent='+ '+v.title+(v.variantTitle&&v.variantTitle!==v.title?' / '+v.variantTitle:'')+(v.priceGbp?' · £'+Number(v.priceGbp).toFixed(2):'');
        btn.onclick=function(){
          inboxInvoiceItems.push({variantId:v.variantId,title:(v.title+(v.variantTitle&&v.variantTitle!==v.title?' / '+v.variantTitle:'')),qty:1,priceGbp:v.priceGbp||0});
          renderInvoiceItems();
        };
        resEl.appendChild(btn);
      });
    }
  }catch(e){ if(resEl) resEl.textContent='Search failed: '+errText(e); }
}
async function buildInvoiceAction(threadId){
  var msgEl=el('inbox-invoice-msg');
  if(!inboxInvoiceItems.length){ if(msgEl) setMsg('inbox-invoice-msg','Add at least one item.','no'); return; }
  var coverEl=el('inbox-invoice-cover');
  var coverText=(coverEl&&coverEl.value.trim())||'';
  var btn=el('inbox-invoice-build-btn'); if(btn) btn.disabled=true;
  if(msgEl) setMsg('inbox-invoice-msg','Building invoice…','muted');
  try{
    var items=inboxInvoiceItems.map(function(it){ return {variantId:it.variantId,qty:it.qty}; });
    var r=await api('/inbox/invoice/build',{threadId:threadId,items:items,coverText:coverText});
    if(r.ok===false&&r.error==='reconnect_required'){
      showReconnectBanner(); if(msgEl) setMsg('inbox-invoice-msg','Re-authorise required — see banner above.','no');
      if(btn) btn.disabled=false; return;
    }
    if(!r.ok){ if(msgEl) setMsg('inbox-invoice-msg','Failed: '+esc(r.error||'unknown error'),'no'); if(btn) btn.disabled=false; return; }
    inboxInvoiceItems=[];
    openInboxThread(threadId);
    setMsg('inboxmsg','Invoice sent ✓','ok');
  }catch(e){ if(msgEl) setMsg('inbox-invoice-msg','Failed: '+errText(e),'no'); if(btn) btn.disabled=false; }
}
async function discardInvoiceAction(invoiceId,threadId){
  setMsg('inboxmsg','Discarding invoice…','muted');
  var btn=el('inbox-invoice-discard-btn'); if(btn) btn.disabled=true;
  try{
    var r=await api('/inbox/invoice/discard',{invoiceId:invoiceId});
    if(!r.ok){ setMsg('inboxmsg','Failed: '+esc(r.error||'unknown error'),'no'); if(btn) btn.disabled=false; return; }
    openInboxThread(threadId);
    setMsg('inboxmsg','Invoice discarded.','muted');
  }catch(e){ setMsg('inboxmsg','Failed: '+errText(e),'no'); if(btn) btn.disabled=false; }
}
function showReconnectBanner(){
  var banner=el('inbox-reconnect-banner');
  if(!banner) return;
  var shop=(new URL(location.href)).searchParams.get('shop')||'';
  var href='/auth'+(shop?'?shop='+encodeURIComponent(shop):'');
  banner.style.display='';
  banner.innerHTML='Re-authorisation required. <a href="'+esc(href)+'" style="color:var(--no-ink);font-weight:600">Click here to reconnect ↗</a>';
}
async function saveInboxStatus(id){
  var sel=el('inbox-status-sel');
  if(!sel){ setMsg('inboxmsg','Status selector not found.','no'); return; }
  var status=sel.value;
  setMsg('inboxmsg','Saving status…','muted');
  try{
    var r=await api('/inbox/status',{id:id,status:status});
    if(r.ok){ setMsg('inboxmsg','Status updated to '+esc(status)+'.','ok'); }
    else { setMsg('inboxmsg','Failed: '+esc(r.error||'unknown error'),'no'); }
  }catch(e){ setMsg('inboxmsg','Failed: '+errText(e),'no'); }
}
async function saveInboxLabels(id){
  var sel=el('inbox-label-sel');
  if(!sel){ setMsg('inboxmsg','Label selector not found.','no'); return; }
  var chosen=[];
  for(var i=0;i<sel.options.length;i++){ if(sel.options[i].selected) chosen.push(sel.options[i].value); }
  setMsg('inboxmsg','Saving labels…','muted');
  try{
    var r=await api('/inbox/labels',{id:id,labels:chosen});
    if(r.ok){ setMsg('inboxmsg','Labels saved.','ok'); }
    else { setMsg('inboxmsg','Failed: '+esc(r.error||'unknown error'),'no'); }
  }catch(e){ setMsg('inboxmsg','Failed: '+errText(e),'no'); }
}
var currentInboxCfg={enabled:true,labels:[]};
function setReplyModeUI(on){
  var wrap=el('reply-mode'), st=el('reply-mode-state'), ds=el('reply-mode-desc');
  if(wrap) wrap.className='reply-mode'+(on?' is-auto':'');
  if(st) st.textContent=on?'Automatic — human review OFF':'Manual review';
  if(ds) ds.textContent=on
    ?'PawScout emails customers automatically when its confidence is at or above the threshold. No human review.'
    :'Drafts wait here for you to approve and send — nothing is emailed to customers automatically.';
}
async function onReplyModeToggle(){
  var chk=el('inbox-autosend-chk'); if(!chk) return;
  if(chk.checked && !confirm('Turn ON automatic replies?\\n\\nThis switches OFF human review: PawScout will email customers on its own when its confidence is high. You can turn it back off here anytime.')){
    chk.checked=false; setReplyModeUI(false); return;
  }
  setReplyModeUI(chk.checked);
  var ok=await saveInboxSettings();
  setMsg('inboxmsg', ok?('Reply mode set to '+(chk.checked?'Automatic.':'Manual.')):'Could not save reply mode — try the Save button in Inbox settings.', ok?'ok':'no');
}
async function loadInboxSettings(){
  try{
    var r=await api('/inbox/config',{});
    if(!r.ok||!r.inbox) return;
    var cfg=r.inbox;
    currentInboxCfg={enabled:cfg.enabled!==false,labels:Array.isArray(cfg.labels)?cfg.labels:[]};
    var chk=el('inbox-autosend-chk'); if(chk) chk.checked=!!cfg.autosend;
    setReplyModeUI(!!cfg.autosend);
    var at=el('inbox-auto-thresh'); if(at&&cfg.autoConfidenceThreshold!=null) at.value=cfg.autoConfidenceThreshold;
    var it=el('inbox-intent-thresh'); if(it&&cfg.intentThreshold!=null) it.value=cfg.intentThreshold;
    var ae=el('inbox-alert-email'); if(ae&&cfg.alertEmail) ae.value=cfg.alertEmail;
    var gt=el('inbox-guidance-ta'); if(gt) gt.value=cfg.replyGuidance||'';
    // Invoice settings
    var aichk=el('inbox-autoinvoice-chk'); if(aichk) aichk.checked=!!cfg.autoInvoice;
    var ict=el('inbox-invoice-conf-thresh'); if(ict&&cfg.invoiceConfidenceThreshold!=null) ict.value=cfg.invoiceConfidenceThreshold;
    var ivc=el('inbox-invoice-value-ceiling'); if(ivc&&cfg.invoiceValueCeiling!=null) ivc.value=cfg.invoiceValueCeiling;
    var irl=el('inbox-invoice-rate-limit'); if(irl&&cfg.invoiceRateLimit!=null) irl.value=cfg.invoiceRateLimit;
    var ssb=el('inbox-settings-save'); if(ssb) ssb.onclick=saveInboxSettings;
  }catch(e){ setMsg('inboxcfgmsg','Could not load inbox settings.','no'); }
}
async function saveInboxSettings(){
  setMsg('inboxcfgmsg','Saving…','muted');
  var chk=el('inbox-autosend-chk');
  var at=el('inbox-auto-thresh');
  var it=el('inbox-intent-thresh');
  var ae=el('inbox-alert-email');
  var gt=el('inbox-guidance-ta');
  var aichk=el('inbox-autoinvoice-chk');
  var ict=el('inbox-invoice-conf-thresh');
  var ivc=el('inbox-invoice-value-ceiling');
  var irl=el('inbox-invoice-rate-limit');
  try{
    var payload={
      enabled:currentInboxCfg.enabled,
      labels:currentInboxCfg.labels,
      autosend:!!(chk&&chk.checked),
      autoConfidenceThreshold:Number(at&&at.value||80),
      intentThreshold:Number(it&&it.value||70),
      alertEmail:(ae&&ae.value.trim())||'',
      replyGuidance:(gt&&gt.value)||'',
      autoInvoice:!!(aichk&&aichk.checked),
      invoiceConfidenceThreshold:Number(ict&&ict.value||95),
      invoiceValueCeiling:Number(ivc&&ivc.value||250),
      invoiceRateLimit:Math.max(1,parseInt((irl&&irl.value)||'2',10)||2)
    };
    var r=await api('/inbox/config',payload);
    if(r.ok){ setMsg('inboxcfgmsg','Saved ✓','ok'); return true; }
    setMsg('inboxcfgmsg','Failed: '+esc(r.error||'unknown error'),'no'); return false;
  }catch(e){ setMsg('inboxcfgmsg','Failed: '+errText(e),'no'); return false; }
}
refresh();
loadInsights();
loadInboxThreads();
loadInboxSettings();
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
