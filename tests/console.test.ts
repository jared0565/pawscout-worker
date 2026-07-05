import { describe, it, expect } from 'vitest';
import { consolePage } from '../src/console/page';

describe('consolePage', () => {
  it('emits inline <script> that is syntactically valid JS', async () => {
    const html = await consolePage('test-api-key').text();
    // The console page is one big template literal; a broken quote-escape inside
    // it produces malformed browser JS that silently freezes the whole console.
    // Parse every inline script (the CDN <script src=...> has no body) and fail
    // on any SyntaxError. Wrapped in an async fn so top-level await is allowed.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      expect(() => new Function('return (async function(){' + body + '\n})')).not.toThrow();
    }
  });

  it('includes the Inbox tab and its mount point', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('data-tab="inbox"');
    expect(html).toContain('id="inbox-threads"');
  });

  // 2026-07-04: optional margin cap (smooth high-end taper) in the pricing card.
  it('pricing card exposes the optional margin cap and only sends it when set', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="pmaxm"');
    expect(html).toContain('Max margin');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // save path includes the field conditionally (blank input = no cap sent)
    expect(scripts).toContain('maxMarginGbp');
    expect(scripts).toMatch(/if\s*\(\s*mx\s*!==\s*''\s*\)/);
    // status summary renders the cap only when configured
    expect(scripts).toContain('cap £');
  });

  // Phase 2: the modal is replaced by a full-height THREE-PANE mail workspace.
  it('renders the three-pane inbox workspace and the modal is fully removed', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // Static skeleton: grid + list pane + conversation pane + context rail.
    expect(html).toContain('class="ibx-grid"');
    expect(html).toContain('id="inbox-threads"');       // pane 1: thread list mount
    expect(html).toContain('id="ibx-convo-head"');      // pane 2: conversation header
    expect(html).toContain('id="ibx-timeline"');        // pane 2: message timeline
    expect(html).toContain('id="ibx-context-body"');    // pane 3: context rail mount
    expect(html).toContain('id="ibx-auto-pill"');       // header automation pill
    expect(html).toContain('id="inbox-reconnect-banner"');
    // Filter chips + the full status select coexist (chips are shortcuts).
    expect(html).toContain('id="inbox-status-filter"');
    expect(html).toContain('data-filter="open"');
    expect(html).toContain('data-filter="needs_reply"');
    expect(scripts).toContain('function ibxSetFilter(');
    // Empty states: no selection / inbox zero / no pending draft.
    expect(html).toContain('Select a conversation');
    expect(scripts).toContain('Inbox zero');
    expect(scripts).toContain('No draft pending');
    // Row click loads the conversation in-pane (no modal), and processing a
    // thread reloads the list so it drops off the Open filter.
    expect(scripts).toContain('function openInboxThread(');
    expect(scripts).toContain('loadInboxThreads()');
    // The Phase-1 modal markup + JS are gone.
    expect(html).not.toContain('id="inbox-modal"');
    expect(html).not.toContain('id="inbox-modal-close"');
    expect(html).not.toContain('inbox-modal-msg');
    expect(scripts).not.toContain('function openInboxModal(');
    expect(scripts).not.toContain('function closeInboxModal(');
    expect(scripts).not.toContain('function wireInboxModal(');
    // Automation pill derives from the /inbox/config payload on load AND save.
    expect(scripts).toContain('function renderInboxAutoPill(');
    expect(scripts).toContain('renderInboxAutoPill(cfg)');
    expect(scripts).toContain('renderInboxAutoPill(payload)');
    expect(scripts).toContain('Manual review');
  });

  it('renders the pending draft as a dashed editable card and approves with the edited text', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // Draft card: distinct header + confidence chip + hold-reason chips from
    // hold_reasons JSON + contenteditable body at the END of the timeline.
    expect(scripts).toContain('DRAFT - not sent');
    expect(scripts).toContain('contenteditable="true"');
    expect(scripts).toContain('id="inbox-draft"');
    expect(scripts).toContain('hold_reasons');
    expect(scripts).toContain('% confident');
    // Approve must send the CURRENT edited text: the contenteditable innerText
    // is read and passed as the `body` override of POST /api/inbox/approve
    // (approveDraft(db, shop, env, draftId, editedBody) uses it when non-empty).
    expect(scripts).toContain('.innerText');
    expect(scripts).toContain("'/inbox/approve'");
    expect(scripts).toContain('body:body');
  });

  it('uses Regenerate (LLM re-draft) and the old draft-Discard is fully removed', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('id="inbox-regen-btn"');        // renamed button
    expect(html).toContain('Regenerate');
    expect(scripts).toContain('/inbox/regenerate');        // calls the new endpoint
    expect(html).not.toContain('id="inbox-discard-btn"');  // old draft-discard button gone
    expect(scripts).not.toContain('discardDraftAction');   // dead handler removed
    expect(scripts).not.toContain("'/inbox/discard'");     // old endpoint gone (invoice discard path is different)
  });

  it('includes the draft editor + settings controls', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="inbox-draft"');
    expect(html).toContain('data-inbox-autosend');
    expect(html).toContain('data-inbox-guidance');
  });

  // W-INBOX-3 Task 11: invoice card + settings controls
  it('includes the auto-invoice settings toggle (data-inbox-autoinvoice)', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('data-inbox-autoinvoice');
  });

  it('references the invoice build endpoint in the script source', async () => {
    const html = await consolePage('test-api-key').text();
    // api() prepends '/api', so the literal path in the source is '/inbox/invoice/build'
    expect(html).toContain('/inbox/invoice/build');
  });

  it('references the catalog search endpoint in the script source', async () => {
    const html = await consolePage('test-api-key').text();
    // api() prepends '/api', so the literal path in the source is '/inbox/catalog'
    expect(html).toContain('/inbox/catalog');
  });

  it('renderInboxThread accepts + renders the partnership applicant panel', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function renderInboxThread(thread,messages,labels,draft,invoice,applicant,contact)');
    expect(scripts).toContain('Partnership screening');
    expect(scripts).toContain('r.applicant||null');
  });

  it('esc() renders a crafted <script> payload as HTML-escaped text (not raw tags)', async () => {
    // consolePage is a static template - all esc() calls run client-side inside the
    // <script> block, not at SSR time. We extract the esc() helper from the emitted
    // source and execute it directly on the crafted payload so the assertion is over
    // real output, not source patterns.
    const html = await consolePage('test-api-key').text();
    // esc is a single-line function - match the whole line so the nested {} in the
    // replacement map are captured correctly (non-greedy would truncate at the first }).
    const escMatch = html.match(/function esc\(s\)\{[^\n]+\}/);
    expect(escMatch).not.toBeNull();
    const esc: (s: string) => string = new Function(escMatch![0] + '; return esc;')() as (s: string) => string;
    const crafted = '<script>alert(1)</script>';
    const out = esc(crafted);
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('renders one AI-models block and no legacy/inbox model selectors', async () => {
    const html = await consolePage('test-key').text();
    expect(html).toContain('id="mdl-image"');
    expect(html).toContain('id="mdl-text"');
    expect(html).toContain('id="mdl-fallback"');
    expect(html).toContain('Last resort: GPT-5.4 mini');
    expect(html).not.toContain('id="llmcuration"');
    expect(html).not.toContain('id="llmvision"');
    expect(html).not.toContain('id="inbox-reply-model"');
    expect(html).not.toContain('id="inbox-classify-model"');
    expect(html).not.toContain('id="llmmodel"');
  });

  it('surfaces the contact-form declared intent in the thread detail', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // renderInboxThread maps the declared_intent token to a friendly label and shows a
    // "Declared:" line when present - visible even on non-funnel order/wholesale threads
    // where there is no Partnership screening panel. Reinforces the classifier.
    expect(scripts).toContain('thread.declared_intent');
    expect(scripts).toContain('Declared:');
    expect(scripts).toContain('Creator / affiliate partnership');
  });

  // 2026-07-04: partnership handling is a Settings mode (voucher funnel default,
  // link funnel preserved, decline-all kept as a toggle) saved with inbox config.
  it('includes the partnership-approaches mode select and saves it with inbox settings', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="affiliate-mode"');
    expect(html).toContain('<option value="funnel_voucher">');
    expect(html).toContain('<option value="funnel_link">');
    expect(html).toContain('<option value="decline_all">');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('affiliateMode:');
    expect(scripts).toContain('cfg.affiliateMode');
  });

  it('includes the per-agent auto-send toggle panel', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // Markup: agents panel container and list mount point
    expect(html).toContain('id="agents-panel"');
    expect(html).toContain('id="agents-list"');
    // JS: INBOX_AGENTS list and render/collect helpers
    expect(scripts).toContain('INBOX_AGENTS');
    expect(scripts).toContain('function renderAgents(');
    expect(scripts).toContain('function collectAgents(');
    // Each agent row uses data-agent attribute
    expect(scripts).toContain('data-agent');
    // Save payload includes agents
    expect(scripts).toContain('agents:collectAgents()');
    // setReplyModeUI re-renders agents on master toggle
    expect(scripts).toContain('renderAgents({autosend:on,agents:collectAgents()})');
  });

  it('includes the GB Local free-UK shipping panel + the verify-then-flip toggle', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('id="gb-shipping-panel"');
    expect(html).toContain('id="gb-free-uk-chk"');
    expect(html).toContain('data-gb-free-uk');
    expect(html).toContain('id="gb-profile-status"');
    expect(scripts).toContain('function saveGbFreeUk(');
    expect(scripts).toContain('/gb-free-uk'); // api() prepends /api
  });

  it('includes the GB Local "sync now" trigger (create/reconcile the profile on demand)', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('id="gb-sync-btn"');
    expect(html).toContain('id="gb-sync-result"');
    expect(scripts).toContain('function syncGbLocal(');
    expect(scripts).toContain('/gb-sync'); // api() prepends /api
  });

  // Phase 1 shell (extended in Phase 3): left rail + always-in-DOM views
  // toggled by a hash router; Glance is the landing view.
  it('renders the nine view containers, the rail, and the hash router', async () => {
    const html = await consolePage('test-api-key').text();
    for (const v of ['view-glance', 'view-inbox', 'view-catalog', 'view-ops', 'view-audit', 'view-partners', 'view-campaigns', 'view-settings', 'view-help']) {
      expect(html).toContain('id="' + v + '"');
    }
    expect(html).toContain('class="rail"');
    expect(html).toContain('data-route="glance"');
    expect(html).toContain('data-route="inbox"');
    expect(html).toContain('data-route="audit"');
    expect(html).toContain('data-route="partners"');
    expect(html).toContain('data-route="campaigns"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function applyRoute(');
    expect(scripts).toContain("window.addEventListener('hashchange',applyRoute)");
    expect(scripts).toContain('applyRoute();'); // applied on load too
    // Glance is the default route: unknown/missing hash falls back to it.
    expect(scripts).toContain("var ROUTES=['glance','inbox','catalog','ops','audit','partners','campaigns','traffic','settings','help']");
    expect(scripts).toContain(":'glance'");
  });

  // --- Campaigns view (2026-07-05): consented marketing broadcasts ---

  it('renders the Campaigns view: compose, audiences, sender details, armed send', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['cmp-list', 'cmp-msg', 'cmp-audiences', 'cmp-audience', 'cmp-subject',
      'cmp-body', 'cmp-preview', 'cmp-new-msg', 'cmp-postal', 'cmp-postal-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadCampaigns(');
    expect(scripts).toContain("'/campaigns'");
    expect(scripts).toContain("'/campaigns/create'");
    expect(scripts).toContain("'/campaigns/audiences'");
    expect(scripts).toContain("'/campaigns/test'");
    expect(scripts).toContain("'/campaigns/send'");
    expect(scripts).toContain("'/campaigns/discard'");
    expect(scripts).toContain('loadCampaigns();');      // loaded on startup
    // Ids ride in ESCAPED data attributes resolved by delegation (XSS discipline).
    expect(scripts).toContain('data-cmp-send="\'+esc(');
    // Broadcasting is two-click armed like the other consequential actions.
    expect(scripts).toContain('Click again to send to everyone');
    const cmpBlock = scripts.slice(scripts.indexOf('var cmpState'), scripts.indexOf('async function cmpSavePostal('));
    expect(cmpBlock.length).toBeGreaterThan(0);
    expect(cmpBlock).not.toContain('window.confirm');
  });

  // --- Traffic view (2026-07-05): acquisition strategy board ---

  it('renders the Traffic view: rail entry, board, editor wired to /traffic endpoints', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('data-route="traffic"');
    expect(html).toContain('id="view-traffic"');
    for (const id of ['trf-list', 'trf-msg', 'trf-editor-card', 'trf-name', 'trf-status',
      'trf-priority', 'trf-rationale', 'trf-next', 'trf-notes']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadTraffic(');
    expect(scripts).toContain("'/traffic'");
    expect(scripts).toContain("'/traffic/save'");
    expect(scripts).toContain("'/traffic/delete'");
    expect(scripts).toContain('loadTraffic();'); // loaded on startup
    // Ids ride in ESCAPED data attributes resolved by delegation (XSS discipline).
    expect(scripts).toContain('data-trf-id="\'+esc(');
    // Deleting a channel is two-click armed like the other consequential actions.
    expect(scripts).toContain('Click again to delete');
  });

  it('Help covers Traffic as a full KB section: board, starter strategy, methodology, evidence', async () => {
    const html = await consolePage('test-api-key').text();
    for (const topic of ['The Traffic strategy board', 'The starter strategy, channel by channel',
      'Working a channel: idea to active', 'Where the evidence lives']) {
      expect(html).toContain('<summary>' + topic + '</summary>');
    }
    // The methodology states the honest-status rule, grounded not generic.
    expect(html).toContain('statuses describe evidence, not enthusiasm');
    expect(html).toContain('demonstrably brings visitors or orders');
  });

  // --- Privacy policy keeper (2026-07-05): check + one-click apply ---

  it('Campaigns view carries the privacy-policy keeper wired to /legal/check and /legal/apply', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('Privacy policy wording');
    for (const id of ['lgl-status', 'lgl-actions', 'lgl-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    expect(html).toContain('Apply recommended update');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function lglCheck(');
    expect(scripts).toContain('function lglApply(');
    expect(scripts).toContain("'/legal/check'");
    expect(scripts).toContain("'/legal/apply'");
    // Updating a legal page is two-click armed like the other consequential actions.
    expect(scripts).toContain('Click again to update the live policy');
  });

  // --- Email analytics (2026-07-05): tracking setup + per-campaign metrics ---

  it('Campaigns view carries the Email analytics panel: status probe, one-click setup, per-campaign metrics', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('Email analytics');
    for (const id of ['cmp-tracking', 'cmp-tracking-actions', 'cmp-tracking-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    expect(html).toContain('Turn on tracking');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function cmpLoadTracking(');
    expect(scripts).toContain('function cmpEnableTracking(');
    expect(scripts).toContain("'/email-tracking'");
    expect(scripts).toContain("'/email-tracking/setup'");
    // Metrics render per campaign row when the rollup is present.
    expect(scripts).toContain('if(cp.metrics){');
    expect(scripts).toContain('Delivered <strong>');
    expect(scripts).toContain('Opened <strong>');
    expect(scripts).toContain('Clicked <strong>');
  });

  it('Partners view carries the marketing opt-in toggle wired to /partners/consent', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain("'/partners/consent'");
    expect(scripts).toContain('data-prt-consent="\'+esc(');
    expect(scripts).toContain('Mark updates opt-in');
    expect(scripts).toContain('Remove updates opt-in');
  });

  // --- Voucher issuance automation (2026-07-05): one-click issue + promo status ---

  it('Partners view issues vouchers with one click and shows event-aware promo status', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="prt-promos"');
    expect(html).toContain('Issue automatically');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function issuePartnerVoucher(');
    expect(scripts).toContain("'/partners/issue'");
    expect(scripts).toContain("'/partners/discount-status'");
    expect(scripts).toContain('loadDiscountStatus();'); // probe runs on startup
    // A missing write_discounts grant explains the fix, not a stack trace.
    expect(scripts).toContain('approve the updated permissions');
  });

  it('the rail badge re-syncs from every inbox list load (stale-badge fix)', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('updateRailBadge(r.openCount)');
  });

  it('Settings carries the auto-issue voucher switch, loaded and saved with inbox config', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="inbox-autoissue-chk"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain("autoIssueVoucher:!!(el('inbox-autoissue-chk')");
    expect(scripts).toContain('aiv.checked=!!cfg.autoIssueVoucher');
  });

  // --- Partners view (2026-07-04): affiliate voucher trials ---

  it('renders the Partners view: list, register form, orders modal, armed actions', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['prt-list', 'prt-msg', 'prt-email', 'prt-name', 'prt-channel', 'prt-code',
      'prt-pct', 'prt-comm', 'prt-ends', 'prt-notes', 'prt-reg-msg',
      'prt-overlay', 'prt-orders', 'prt-orders-title']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadPartners(');
    expect(scripts).toContain("'/partners'");          // api() prepends /api
    expect(scripts).toContain("'/partners/create'");
    expect(scripts).toContain("'/partners/voucher'");
    expect(scripts).toContain("'/partners/orders'");
    expect(scripts).toContain('loadPartners();');      // loaded on startup
    // Ids ride in ESCAPED data attributes resolved by delegation, never
    // string-built into inline onclick JS (same discipline as Audit).
    expect(scripts).toContain('data-prt-orders="\'+esc(');
    expect(scripts).not.toContain("openPartnerOrders('\"+");
    // Money-adjacent actions are two-click armed, not window.confirm (the
    // embedded admin iframe can swallow confirm dialogs). Scoped to the
    // partners block: other, older view JS still uses confirm elsewhere.
    expect(scripts).toContain('function prtArm(');
    const prtBlock = scripts.slice(scripts.indexOf('function prtMoney('), scripts.indexOf('function closePartnerOrders('));
    expect(prtBlock.length).toBeGreaterThan(0);
    expect(prtBlock).not.toContain('window.confirm');
    expect(scripts).toContain('Click again to revoke');
    expect(scripts).toContain('Click again to confirm payout');
    // Revoke really deactivates the code in Shopify (write_discounts); when
    // Shopify does not confirm, the message tells the owner the manual step.
    expect(scripts).toContain('deactivated in Shopify too');
    expect(scripts).toContain('disable the code under Discounts in Shopify admin');
    // The modal suppresses the digit view-switch shortcuts while open.
    expect(scripts).toContain('__modalOpen');
  });

  // --- Audit view v2 (2026-07-04 owner redesign): contact list + conversation modal ---

  it('renders the Audit view: contact list, category filter, conversation modal', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('Audit log');
    for (const id of ['aud-list', 'aud-category', 'aud-more', 'aud-msg', 'aud-overlay', 'aud-convo', 'aud-convo-title']) {
      expect(html).toContain('id="' + id + '"');
    }
    // The classification dropdown is generated from the REAL label taxonomy.
    expect(html).toContain('<option value="affiliate">');
    expect(html).toContain('<option value="lead">');
    expect(html).toContain('<option value="product-question">');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadAudit(');
    expect(scripts).toContain("'/audit'");                // api() prepends /api
    expect(scripts).toContain("'/audit/conversation'");   // modal fetch
    expect(scripts).toContain('loadAudit();');            // loaded on startup
    expect(scripts).toContain('function openAuditConvo(');
    expect(scripts).toContain('function closeAuditConvo(');
    // Contact emails are attacker-controlled: rows carry them in an ESCAPED data
    // attribute read back via delegation - never string-built into onclick JS.
    expect(scripts).toContain("data-aud-email=\"'+esc(");
    expect(scripts).not.toContain("openAuditConvo('\"+");
    // Provenance is spelled out for the owner, and message bodies are escaped.
    expect(scripts).toContain('sent automatically');
    expect(scripts).toContain('approved by you');
    expect(scripts).toMatch(/aud-body">'\+esc\(/);
    // Read-only view: no send/approve path is reachable from audit code.
    const audBlock = scripts.slice(scripts.indexOf('var audOldest'), scripts.indexOf('async function loadOlderAudit'));
    expect(audBlock).not.toContain('approveDraft');
    // The modal suppresses the digit view-switch shortcuts while open.
    expect(scripts).toContain('__modalOpen');
  });

  // --- Phase 3: Glance landing view + thread-list upgrades + cache header ---

  it('serves /app with Cache-Control: no-store (stale-console fix)', () => {
    expect(consolePage('test-api-key').headers.get('Cache-Control')).toBe('no-store');
  });

  it('renders the Glance skeleton and its loader', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['gl-kpis', 'gl-attn', 'gl-activity', 'gl-health', 'gl-markets', 'gl-auto-pill', 'gl-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    expect(html).toContain('Shop at a Glance');
    expect(html).toContain('Needs your attention');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadGlance(');
    expect(scripts).toContain("'/glance'"); // api() prepends /api
    expect(scripts).toContain('loadGlance();'); // loaded on startup
    // Honest empty states, not fabricated numbers.
    expect(scripts).toContain('All clear');
    expect(scripts).toContain('no record yet');
  });

  it('thread list rows show the contact name and a real draft-ready chip', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('t.contactName||t.contactEmail');
    expect(scripts).toContain('t.hasDraft');
    expect(scripts).toContain('draft ready');
  });

  it('Save AI models confirms in BOTH the Settings and Catalog message slots', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="llm-models-msg"'); // Settings AI-models card slot
    expect(html).toContain('id="llmmsg"');         // Catalog AI-curation card slot
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function llmMsg(');
    expect(scripts).toContain("setMsg('llm-models-msg'");
  });

  // --- Phase 4: rail badge + keyboard shortcuts + timeline polish ---

  it('rail Inbox badge is driven by the Open-queue size (badge == Inbox list, 2026-07-05 invariant)', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="rail-inbox-badge"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function updateRailBadge(');
    // The badge counts open THREADS (same query as the Inbox default list), never
    // pending drafts - a superseded/regenerating draft must not shrink the badge.
    expect(scripts).toContain('updateRailBadge(k.openThreads)');
    expect(scripts).not.toContain('updateRailBadge(k.pendingDrafts)');
    // Approving a draft changes the count, so approve refreshes the glance data.
    expect(scripts).toMatch(/function approveDraftAction[\s\S]{0,900}loadGlance\(\)/);
  });

  it('keyboard shortcuts: digits switch views, j/k walk the inbox, editable targets are ignored, nothing sends', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function keyEditable(');
    expect(scripts).toContain("window.addEventListener('keydown'");
    expect(scripts).toContain('d>=1&&d<=ROUTES.length');
    // Ten routes, nine digits: 0 reaches the tenth view (Help).
    expect(scripts).toContain("e.key==='0'&&ROUTES.length>=10");
    expect(scripts).toContain("e.key==='j'");
    // The shortcut handler must never reference the approve/send path.
    const keyBlock = scripts.slice(scripts.indexOf('function keyEditable('));
    expect(keyBlock.slice(0, keyBlock.indexOf('});'))).not.toContain('approve');
    // Discoverability: shortcuts documented in Help.
    expect(html).toContain('Keyboard shortcuts');
  });

  it('timeline renders day dividers and the draft card shows its drafted age', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function ibxDayLabel(');
    expect(scripts).toContain('ibx-day');
    expect(scripts).toContain('>drafted ');
  });

  // --- Phase 5: Help knowledge base ---

  it('renders the Help knowledge base: every console area covered as collapsible topics', async () => {
    const html = await consolePage('test-api-key').text();
    for (const section of [
      'PawScout guide', 'Getting started', 'Shop at a Glance', 'Inbox and customer replies',
      'Catalog and pricing', 'Operations and orders', 'Shipping, markets and stock safety',
      'Settings and automation', 'Partners and vouchers', 'Campaigns and marketing email', 'Traffic and growth', 'Keyboard shortcuts'
    ]) {
      expect(html).toContain('<h2>' + section + '</h2>');
    }
    const topics = html.match(/<details class="hlp-topic">/g) ?? [];
    expect(topics.length).toBeGreaterThanOrEqual(30);
    // Spot-check that the guide states the REAL bounds (grounded, not generic prose).
    expect(html).toContain('80 out of 100 by default');       // auto-confidence threshold
    expect(html).toContain('95 out of 100');                  // invoice confidence
    expect(html).toContain('250 pounds');                     // invoice value ceiling
    expect(html).toContain('one hundred pounds');             // order review threshold
    expect(html).toContain('sixty minute grace window');      // fulfil grace
    expect(html).toContain('one unit back in reserve');       // low-stock reserve
  });

  it('help diagrams are accessible inline SVG using theme tokens, with no element ids', async () => {
    const html = await consolePage('test-api-key').text();
    const svgs = [...html.matchAll(/<svg class="hlp-diagram"[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    expect(svgs.length).toBe(4);
    for (const svg of svgs) {
      expect(svg).toContain('role="img"');
      expect(svg).toContain('<title>');
      expect(svg).toContain('var(--');   // themes with the console palette
      expect(svg).not.toMatch(/\sid="/); // keeps the duplicate-id test meaningful
    }
  });

  it('the entire served console contains no em or en dash (house style, enforced)', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html.includes('—')).toBe(false);
    expect(html.includes('–')).toBe(false);
  });

  it('has no duplicate id="..." attributes in the static HTML (all views share one DOM)', async () => {
    const html = await consolePage('test-api-key').text();
    // Strip script blocks first: ids inside JS-built strings (thread modal internals)
    // are injected at runtime into #inbox-thread, never duplicated in the static DOM.
    const staticHtml = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const ids = [...staticHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(80); // sanity: the relocation dropped nothing
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it('wraps every invoice field in esc() in the client render code', async () => {
    const html = await consolePage('test-api-key').text();
    // Verify that the renderInboxThread / invoice-card code wraps dynamic values in esc()
    // rather than raw-interpolating them. We check that the source references esc() in
    // the invoice-card region - a source-level guard against the XSS class seen in W-INBOX-1.
    // The inline script block must contain esc() calls near invoice-related identifiers.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // The invoice card must reference esc() and invoice fields in the same script block.
    expect(scripts).toContain('invoice');
    // Confirm all identified invoice field names are passed through esc():
    // title, total, status are the three raw string fields that could carry injected content.
    const invoiceCardMatch = scripts.match(/invoice[\s\S]{0,3000}invoice_url/);
    expect(invoiceCardMatch).not.toBeNull();
    // No raw .title or .status insertion without esc() wrapping
    // (i.e. the string '+inv.title+' pattern must not appear - only esc(inv.title))
    expect(scripts).not.toMatch(/'\s*\+\s*inv\.\s*title\s*\+\s*'/);
    expect(scripts).not.toMatch(/'\s*\+\s*inv\.\s*status\s*\+\s*'/);
  });
});
