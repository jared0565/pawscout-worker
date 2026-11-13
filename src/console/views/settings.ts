// Settings view (Phase 1 relocation): Connect CJ; the new "AI models" card
// (the three model-picker selects moved verbatim out of the AI curation card,
// with their own Save button calling the same saveLlm()); the reply-mode
// block + #agents-panel (formerly at the top of the Inbox card) as a "Reply
// mode and per-agent auto-send" card; the Inbox settings card; and the
// Current configuration card. Markup otherwise verbatim from the original
// single-page console.
export const settingsView = `  <section class="card">
    <h2>Connect CJ</h2>
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
    <h2>AI models</h2>
    <p class="sub" style="margin:0 0 10px">The newest model of each family from OpenRouter, grouped by provider and refreshed daily. A new choice is tested live before it is saved, and a choice that costs more than 3x the current one asks you to confirm first.</p>
    <div class="row" style="align-items:flex-start">
      <div class="grow">
        <label for="mdl-image">Image (vision) model</label><select id="mdl-image" onchange="onModelChange('image')"></select>
        <label for="mdl-image-effort" style="margin-top:6px">Image effort</label><select id="mdl-image-effort"><option value="">Model default</option></select>
      </div>
      <div class="grow">
        <label for="mdl-text">Text model</label><select id="mdl-text" onchange="onModelChange('text')"></select>
        <label for="mdl-text-effort" style="margin-top:6px">Text effort</label><select id="mdl-text-effort"><option value="">Model default</option></select>
      </div>
      <div class="grow"><label for="mdl-fallback">Fallback model</label><select id="mdl-fallback" onchange="onModelChange('fallback')"></select></div>
    </div>
    <p class="sub muted" style="margin:6px 0 0">Effort is how long a model thinks before it answers. Higher effort means more thinking, billed as output tokens. Raising it asks you to confirm first. Model default sends no effort at all, and the fallback runs at the effort of the slot it backs.</p>
    <p id="llm-fallback-hint" class="msg muted" style="display:none"></p>
    <div id="llm-models-warn" class="msg no mdl-warn" style="display:none"></div>
    <div class="row" style="margin-top:10px">
      <button onclick="saveLlm()">Save AI models</button>
    </div>
    <div id="llm-models-msg" class="msg muted"></div>
    <details id="llm-menu" class="mdl-menu">
      <summary>Menu: providers, pins and hidden models</summary>
      <p class="sub" style="margin:8px 0">The menu lists the newest model of each family from these providers. Pin a model to keep it listed; hide one to drop it from the menu. A model already saved in a slot stays selected either way.</p>
      <div id="mdl-menu-body"><p class="muted">Loading…</p></div>
      <div class="row" style="margin-top:10px">
        <div class="grow"><label for="mdl-provider-add">Add a provider (its OpenRouter id, for example x-ai)</label><input id="mdl-provider-add" type="text" spellcheck="false" autocomplete="off"></div>
        <button type="button" class="ghost" onclick="menuAddProvider()">Add</button>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="grow"><label for="mdl-pin">Pin a model (its OpenRouter slug, for example openai/gpt-5.6-luna)</label><input id="mdl-pin" type="text" spellcheck="false" autocomplete="off"></div>
        <button type="button" class="ghost" onclick="menuPin()">Pin</button>
      </div>
      <p id="mdl-menu-msg" class="msg muted"></p>
    </details>
    <p class="sub muted" style="margin:8px 0 0">Last resort: GPT-5.4 mini · OpenAI direct (system-managed, used only if OpenRouter fails).</p>
  </section>

  <section class="card">
    <h2>AI spend</h2>
    <p class="sub" style="margin:0 0 10px">The daily expense record of every AI call the system makes, logged at the moment it happens: which function spent it, on which model, how many calls, and the cost. Last 14 days, newest first, with a total per day. Amounts are USD (the providers bill in dollars).</p>
    <div id="llm-usage"><p class="muted">Loading…</p></div>
    <div class="row" style="margin-top:10px"><button type="button" class="ghost" onclick="loadLlmUsage()">Refresh</button></div>
  </section>

  <section class="card">
    <h2>Reply mode and per-agent auto-send</h2>
    <div id="reply-mode" class="reply-mode">
      <div class="reply-mode__text">
        <div>Reply mode: <span class="reply-mode__state" id="reply-mode-state">Manual review</span></div>
        <p class="sub" id="reply-mode-desc" style="margin:4px 0 0">Drafts wait here for you to approve and send - nothing is emailed to customers automatically.</p>
      </div>
      <label class="reply-mode__sw">
        <input type="checkbox" id="inbox-autosend-chk" data-inbox-autosend onchange="onReplyModeToggle()">
        <span style="font-weight:600">Reply automatically</span>
      </label>
    </div>
    <div id="agents-panel" class="agents-panel">
      <div class="agents-panel__head">Per-agent auto-send <span class="sub">(each agent stays on manual review until you switch it to Auto)</span></div>
      <div id="agents-list"></div>
    </div>
    <div class="agents-panel" id="affiliate-mode-panel">
      <div class="agents-panel__head">Partnership approaches <span class="sub">(affiliate and collaboration pitches)</span></div>
      <select id="affiliate-mode" aria-label="Partnership handling" onchange="saveInboxSettings()">
        <option value="signup_page">Point them to the affiliate application page (self-serve screening)</option>
        <option value="funnel_voucher">Qualify for a voucher trial over email - send the screening questions</option>
        <option value="funnel_link">Qualify for a link partnership - future programme</option>
        <option value="decline_all">Politely decline every approach</option>
      </select>
      <p class="sub" style="margin:8px 0 0">In the qualifying modes, screening questions and results always wait for your approval before sending. Passing voucher-trial candidates are flagged so you can issue their discount code in Partners with one click.</p>
      <label class="toggle-wrap" style="margin-top:6px">
        <input type="checkbox" id="inbox-autoissue-chk" onchange="saveInboxSettings()">
        <span>Auto-issue voucher trials: when a candidate passes screening, create their discount code in Shopify and send the invite automatically. Codes are scheduled around running storewide promotions and capped (uses, end date). Also requires the Reply mode master switch above to be on Automatic.</span>
      </label>
    </div>
  </section>

  <section class="card inbox-settings">
    <h2>Inbox settings</h2>
    <p class="sub" style="margin:0 0 12px">Controls how PawScout handles incoming emails and drafts replies. The <strong>Reply mode</strong> switch (manual vs. automatic) is in the card above.</p>
    <div class="row" style="margin-top:8px">
      <div class="grow">
        <label for="inbox-auto-thresh">Auto-confidence threshold (0-100)</label>
        <input id="inbox-auto-thresh" type="number" min="0" max="100" step="1" value="80">
      </div>
      <div class="grow">
        <label for="inbox-intent-thresh">Intent threshold (0-100)</label>
        <input id="inbox-intent-thresh" type="number" min="0" max="100" step="1" value="70">
      </div>
    </div>
    <div style="margin-top:10px">
      <label for="inbox-alert-email">Alert email</label>
      <input id="inbox-alert-email" type="text" spellcheck="false" autocomplete="off" placeholder="alerts@example.com">
    </div>
    <div style="margin-top:10px">
      <label for="inbox-guidance-ta">Reply guidance (voice &amp; standing instructions for every draft)</label>
      <textarea id="inbox-guidance-ta" data-inbox-guidance placeholder="e.g. Always be warm and concise. (A department signature is added to every draft automatically.)"></textarea>
    </div>
    <hr style="margin:14px 0">
    <p class="sub" style="margin:0 0 10px;font-weight:600;color:var(--ink)">Invoice settings</p>
    <div class="toggle-wrap">
      <input type="checkbox" id="inbox-autoinvoice-chk" data-inbox-autoinvoice>
      <label for="inbox-autoinvoice-chk" style="display:inline;font-weight:550">Auto-invoice - create and send invoices automatically when confidence &ge; threshold (HITL off)</label>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="grow">
        <label for="inbox-invoice-conf-thresh">Invoice confidence threshold (0-100)</label>
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

  <section class="card">
    <h2>System states</h2>
    <p class="sub" style="margin:0 0 10px">The live register of every switch and enforcement setting in PawScout: what the system is actually enforcing right now, grouped by area. Values are read at the moment you load or refresh from the same stores the running code reads - nothing on this table is a stored copy, so it can never go stale. Green means active, red means off or missing, plain values are informational.</p>
    <div id="sys-states"><p class="muted">Loading…</p></div>
    <div class="row" style="margin-top:10px"><button type="button" class="ghost" onclick="loadSystemStates()">Refresh</button></div>
  </section>

  <section class="card">
    <h2>Current configuration</h2>
    <div id="status"><p class="muted">Loading…</p></div>
  </section>`;

// Namespaced (.sys-*) styles for the states register table.
export const settingsCss = `
  /* --- Settings: AI models card --- */
  .mdl-warn div{margin:2px 0}
  .mdl-menu{margin-top:12px}
  .mdl-menu summary{cursor:pointer;font-weight:600;color:var(--ink)}
  .mdl-head{margin:12px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--subdued)}
  .mdl-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 4px 2px 10px;margin:0 6px 6px 0;border:1px solid var(--border);border-radius:999px;font-size:12.5px}
  .mdl-entry{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:3px 0;border-bottom:1px solid var(--border);font-size:12.5px;overflow-wrap:anywhere}
  .mdl-mini{padding:2px 8px;font-size:12px}
  /* --- Settings: System states register --- */
  .sys-group{margin:14px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--subdued)}
  .sys-row{display:grid;grid-template-columns:230px 130px minmax(0,1fr);gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px}
  .sys-label{color:var(--ink);font-weight:550}
  .sys-detail{color:var(--subdued);overflow-wrap:anywhere}
  .sys-src{display:block;font-size:10.5px;color:var(--subdued);opacity:.75;overflow-wrap:anywhere}
  @media(max-width:820px){.sys-row{grid-template-columns:1fr 110px}.sys-detail{grid-column:1 / -1}}
  /* --- Settings: AI spend ledger --- */
  .spend-day{margin:14px 0 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--subdued);display:flex;justify-content:space-between;align-items:baseline}
  .spend-day:first-child{margin-top:2px}
  .spend-total{color:var(--ink);font-weight:650;font-variant-numeric:tabular-nums}
  .spend-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) 52px 76px;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12.5px}
  .spend-head{border-bottom:none;padding:2px 0 0;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--subdued)}
  .spend-task{color:var(--ink);font-weight:550;overflow-wrap:anywhere}
  .spend-model{color:var(--subdued);overflow-wrap:anywhere}
  .spend-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--subdued)}
`;
