// Catalog view (Phase 1 relocation): Quality gates, Collection map, Pricing
// rule, AI curation (threshold + on/off only - the three model-picker selects
// moved to the Settings view's "AI models" card), Add-on products, Search
// demand, Search source diagnostic. Markup verbatim from the original
// single-page console; the onboarding step-number spans were removed because
// the numbered sequence no longer exists across views.
export const catalogView = `  <section class="card">
    <h2>Quality gates</h2>
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
          <option value="loose">Loose - any keyword match</option>
          <option value="title" selected>Title - keyword in title</option>
          <option value="strict">Strict - all keywords in title</option>
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
    <h2>Collection map</h2>
    <p class="sub" style="margin:0 0 12px">Map each storefront collection handle to the supplier tag that fills it. Lowercase letters, digits and hyphens only.</p>
    <div id="maprows"></div>
    <div class="row">
      <button class="ghost" type="button" onclick="addMapRow('','')">Add mapping</button>
      <button type="button" onclick="saveCollections()">Save collections</button>
    </div>
    <p id="mapmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Pricing rule</h2>
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
    <h2>AI curation</h2>
    <p class="sub" style="margin:0 0 12px">Scores supplier candidates and rewrites titles/descriptions at warehouse admission (via OpenRouter). Off = mechanical gates only.</p>
    <div class="row" style="margin-top:10px">
      <div class="grow" style="flex:0 1 140px"><label for="llmthresh">Min score</label><input id="llmthresh" type="number" value="60" min="0" max="100" step="5"></div>
      <div class="grow" style="flex:0 1 120px"><label for="llmon">Enabled</label><select id="llmon"><option value="true" selected>On</option><option value="false">Off</option></select></div>
      <button onclick="saveLlm()">Save AI</button>
    </div>
    <p id="llmmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Add-on / filler products</h2>
    <p class="sub" style="margin:0 0 12px">A hidden pool of cheap, curated items that never appear in browsing or search - they surface only as "Complete the kit" picks on product pages and in the cart's free-delivery nudge. Set the supplier cost band below your main price range.</p>
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
          <option value="true" selected>Hidden - add-on slots only (default)</option>
          <option value="false">Visible - also in browsing &amp; search</option>
        </select>
      </div>
      <button onclick="saveAddons()">Save add-ons</button>
    </div>
    <p id="addmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Search demand - last 30 days</h2>
    <div id="insights"><p class="muted">Loading…</p></div>
  </section>

  <section class="card">
    <h2>Search source diagnostic</h2>
    <p class="sub" style="margin:0 0 12px">Compares what our CJ <code>listV2</code> search returns vs CJ's own website (via Firecrawl) for a query - to verify relevance.</p>
    <div class="row">
      <div class="grow"><label for="diagq">Query</label><input id="diagq" type="text" value="dog toy" spellcheck="false"></div>
      <button id="diagbtn" onclick="runDiag()">Compare</button>
    </div>
    <div id="diagout" class="msg muted"></div>
  </section>`;
