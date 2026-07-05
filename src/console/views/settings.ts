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
    <div class="row">
      <div class="grow"><label for="mdl-image">Image (vision) model</label><select id="mdl-image"></select></div>
      <div class="grow"><label for="mdl-text">Text model</label><select id="mdl-text"></select></div>
      <div class="grow"><label for="mdl-fallback">Fallback model</label><select id="mdl-fallback"></select></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button onclick="saveLlm()">Save AI models</button>
    </div>
    <p id="llm-models-msg" class="msg muted"></p>
    <p class="sub muted" style="margin:8px 0 0">Last resort: GPT-5.4 mini · OpenAI direct (system-managed, used only if OpenRouter fails).</p>
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
        <option value="funnel_voucher">Qualify for a voucher trial - send the screening questions (default)</option>
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
    <h2>Current configuration</h2>
    <div id="status"><p class="muted">Loading…</p></div>
  </section>`;
