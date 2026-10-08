import { describe, it, expect } from 'vitest';
import { consolePage } from '../src/console/page';
import { DRAFT_TEMPLATES } from '../src/inbox/routes';

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

  // 2026-07-19: guide link health (dead product links in published guides).
  it('ops card exposes the guide-link-health panel wired to /blog/health', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="bloghealth-btn"');
    expect(html).toContain('Heal guide links now');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('runBlogHealth');
    expect(scripts).toContain("api('/blog/health',{})");
    expect(scripts).toContain('Dead product links found');
  });

  // 2026-09-19: orders card surfaces webhook subscription health, a re-check
  // button, and a per-order event timeline.
  it('orders card surfaces order-events webhook status, a recheck button, and per-order timelines', async () => {
    const html = await consolePage('test-api-key').text();
    // Static markup: hookline/hookbtn live in the ops card (src/console/views/ops.ts),
    // right after the Fulfilment mode line - not built by the inline script.
    expect(html).toContain('id="hookline"');
    expect(html).toContain('id="hookbtn"');
    expect(html).toContain('Check order events');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain("api('/ensure-webhooks',{})");
    expect(scripts).toContain("api('/order-events',{id:id})");
    expect(scripts).toContain('Order events: not checked yet');
    expect(scripts).toContain('Order events: all 3 subscribed');
    expect(scripts).toContain('Order events: MISSING ');
    expect(scripts).toContain('A cancel or refund can go unnoticed.');
    expect(scripts).toContain('the check failed (');
    expect(scripts).toContain('so nothing is known. Checked ');
  });

  // The owner pays the supplier by hand and PawScout cannot see that payment:
  // an order stays awaiting-payment until its tracking number arrives. So the
  // banner must not read as an instruction to pay everything it lists, and a
  // supplier order id must show on EVERY row that has one: a held, errored or
  // cancelled row with a supplier order is exactly the one the owner has to
  // act on at the supplier.
  it('orders card: the awaiting-payment banner says a hand payment is invisible, and every row with a supplier order shows its id', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('PawScout cannot see a payment you make by hand');
    expect(scripts).toContain('check its state at the supplier before you pay');
    expect(scripts).not.toContain('Pay these CJ order(s)');
    expect(scripts).toContain("var cjid=o.cj?(' · CJ '+esc(o.cj)):'';");
  });

  // "I paid this" (aramid 87a8dc74): extracted and driven, like renderHookLine below.
  it('orders card: "I paid this" on an unmarked awaiting-payment row, the undo on a marked one, and the banner leaves marked rows out', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const extract = (name: string) => {
      const start = scripts.indexOf('function ' + name + '(');
      expect(start).toBeGreaterThanOrEqual(0);
      let depth = 0;
      let end = scripts.indexOf('{', start);
      for (let i = end; i < scripts.length; i++) {
        if (scripts[i] === '{') depth++;
        else if (scripts[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      return scripts.slice(start, end);
    };
    const esc = (s: unknown) => String(s);
    // One compile for all three, so the file gains one reviewed suppression, not three.
    const src = ['orderRowActions', 'ordersAwaitingOwnerPayment', 'orderStatusLabel'].map(extract).join('\n');
    const fns = new Function('esc', src + '\nreturn { orderRowActions, ordersAwaitingOwnerPayment, orderStatusLabel };')(esc) as {
      orderRowActions: (o: Record<string, unknown>) => string;
      ordersAwaitingOwnerPayment: (os: Record<string, unknown>[]) => Record<string, unknown>[];
      orderStatusLabel: (o: Record<string, unknown>) => string;
    };
    const rowActions = fns.orderRowActions;
    const awaitingOwner = fns.ordersAwaitingOwnerPayment;
    const statusLabel = fns.orderStatusLabel;

    const unmarked = { id: 'O1', status: 'awaiting-payment', cj: 'CJ1', ownerPaidAt: null };
    const marked = { id: 'O2', status: 'awaiting-payment', cj: 'CJ2', ownerPaidAt: '2026-10-07T16:00:00.000Z' };
    expect(rowActions(unmarked)).toBe('<button class="ghost" data-act="paid" data-id="O1">I paid this</button>');
    expect(rowActions(marked)).toBe('<button class="ghost" data-act="unpaid" data-id="O2">Not paid after all</button>');
    expect(rowActions({ id: 'O3', status: 'awaiting-payment', cj: null, ownerPaidAt: null })).toBe('');
    expect(rowActions({ id: 'H1', status: 'held', cj: 'CJ4' })).toBe('<button class="ghost" data-act="release" data-id="H1">Release</button> <button class="ghost" data-act="cancel" data-id="H1">Cancel</button>');
    expect(rowActions({ id: 'Q1', status: 'queued' })).toBe('<button class="ghost" data-act="cancel" data-id="Q1">Cancel</button>');
    expect(rowActions({ id: 'S1', status: 'submitted', cj: 'CJ5' })).toBe('');
    expect(awaitingOwner([unmarked, marked, { id: 'H1', status: 'held' }]).map((o) => o.id)).toEqual(['O1']);
    // The label describes the mark only while the row is still waiting: a
    // marked order that then ships, is cancelled or is held reads as that.
    expect(statusLabel(marked)).toBe('paid by you, waiting for tracking');
    expect(statusLabel(unmarked)).toBe('awaiting-payment');
    for (const st of ['fulfilled', 'cancelled', 'held']) {
      expect(statusLabel({ id: 'M', status: st, cj: 'CJ9', ownerPaidAt: '2026-10-07T16:00:00.000Z' })).toBe(st);
    }
    // Marking is a money statement, so it takes a second click, the same way
    // switching PawScout mode on does (window.confirm is blocked in the iframe).
    expect(scripts).toContain('Click I paid this again within 8s to confirm.');
  });

  // Every remaining place the console names this status has to agree with the
  // banner above: PawScout has not paid it, and a payment made by hand is
  // invisible here, so nothing may read as "this is unpaid, go and pay it".
  it('the status label and the fulfilment-mode help never call an awaiting-payment row simply unpaid', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain("'awaiting-payment':'not paid by PawScout'");
    expect(scripts).not.toContain('awaiting CJ payment');
    expect(html).toContain('PawScout cannot see a payment you make by hand, so once you have paid it, press <em>I paid this</em> next to it');
    expect(html).not.toContain('Any order sitting unpaid shows');
    expect(html).not.toContain('a supplier order that is waiting for you to pay it');
  });

  // 2026-09-19 follow-up: the server now distinguishes "check failed" (nothing
  // known about order-events subscriptions) from "missing" (topics genuinely
  // absent) via a new hooks.error field. Source-text checks can't verify which
  // branch wins when both error and a non-empty missing list are present, so
  // this extracts the shipped renderHookLine and drives it against a fake DOM
  // node directly.
  it('renderHookLine: a check failure takes precedence over MISSING, and each state renders exactly', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const marker = 'function renderHookLine(';
    const start = scripts.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = scripts.indexOf('{', start);
    for (let i = end; i < scripts.length; i++) {
      if (scripts[i] === '{') depth++;
      else if (scripts[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const fnSrc = scripts.slice(start, end);
    const node = { textContent: '', className: '' };
    const fakeEl = (id: string) => (id === 'hookline' ? node : null);
    const esc = (s: unknown) => String(s);
    const renderHookLine = new Function('el', 'esc', fnSrc + '\nreturn renderHookLine;')(fakeEl, esc);
    const checkedAt = '2026-09-19T12:00:00.000Z';
    const localTime = new Date(checkedAt).toLocaleString();

    // Branch order: BOTH an error and a non-empty missing list -> check-failed line, not MISSING.
    renderHookLine({ ok: false, missing: ['ORDERS_CANCELLED'], checkedAt, error: 'Shopify API unavailable' });
    expect(node.textContent).toBe(
      'Order events: the check failed (Shopify API unavailable), so nothing is known. Checked ' + localTime + '.'
    );
    expect(node.textContent).not.toContain('MISSING');
    expect(node.className).toBe('msg no');

    // null: unchanged.
    renderHookLine(null);
    expect(node.textContent).toBe('Order events: not checked yet');
    expect(node.className).toBe('msg muted');

    // ok true: unchanged.
    renderHookLine({ ok: true, missing: [], checkedAt, error: null });
    expect(node.textContent).toBe('Order events: all 3 subscribed (checked ' + localTime + ')');
    expect(node.className).toBe('msg ok');

    // error null/absent, ok false, non-empty missing: MISSING line, unchanged.
    renderHookLine({ ok: false, missing: ['ORDERS_CANCELLED', 'REFUNDS_CREATE'], checkedAt, error: null });
    expect(node.textContent).toBe('Order events: MISSING ORDERS_CANCELLED, REFUNDS_CREATE. A cancel or refund can go unnoticed.');
    expect(node.className).toBe('msg no');
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
    expect(scripts).toContain('function renderInboxThread(thread,messages,labels,draft,invoice,applicant,contact,partnerPool,partnerConsent,events)');
    expect(scripts).toContain('Partnership screening');
    expect(scripts).toContain('r.applicant||null');
    // Email engagement rail block (2026-07-12): per-thread delivered/opened/
    // clicked events from email_events, threaded through the same payload.
    expect(scripts).toContain('Email engagement');
    expect(scripts).toContain('r.events||[]');
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

  // 2026-09-06, found by the first eslint run (no-useless-escape): partners-js.ts
  // is a template literal, so `\/` in its source reaches the browser as `/` and
  // the applicant channel-link scheme check arrived as `/^https?:///i.test(...)`,
  // which is a regex followed by a LINE COMMENT. channelSafe was therefore the
  // regex object itself (truthy) for every non-empty URL, so a javascript: URL
  // submitted on an application rendered as a clickable link in the console.
  // Assert over the emitted line, executed as the browser would execute it.
  it('partners view links an applicant channel only when its scheme is http(s)', async () => {
    const html = await consolePage('test-api-key').text();
    const line = html.split('\n').find((l) => l.includes('channelSafe='));
    expect(line).toBeDefined();
    const probe = new Function('a', line + '\nreturn !!channelSafe;') as (a: { channelUrl: string }) => boolean;
    expect(probe({ channelUrl: 'https://www.youtube.com/@activepaw' })).toBe(true);
    expect(probe({ channelUrl: 'http://example.com' })).toBe(true);
    expect(probe({ channelUrl: 'javascript:alert(1)' })).toBe(false);
    expect(probe({ channelUrl: 'ftp://example.com' })).toBe(false);
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
  it('renders the view containers, the rail, and the hash router', async () => {
    const html = await consolePage('test-api-key').text();
    for (const v of ['view-glance', 'view-inbox', 'view-answers', 'view-catalog', 'view-ops', 'view-audit', 'view-partners', 'view-campaigns', 'view-settings', 'view-help']) {
      expect(html).toContain('id="' + v + '"');
    }
    expect(html).toContain('class="rail"');
    expect(html).toContain('data-route="glance"');
    expect(html).toContain('data-route="inbox"');
    expect(html).toContain('data-route="answers"');
    expect(html).toContain('data-route="audit"');
    expect(html).toContain('data-route="partners"');
    expect(html).toContain('data-route="campaigns"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function applyRoute(');
    expect(scripts).toContain("window.addEventListener('hashchange',applyRoute)");
    expect(scripts).toContain('applyRoute();'); // applied on load too
    // Glance is the default route: unknown/missing hash falls back to it.
    // 'events','content','profitability','answers' are appended LAST so digits
    // 1-9 and 0 keep their existing routes.
    expect(scripts).toContain("var ROUTES=['glance','inbox','catalog','ops','audit','partners','campaigns','traffic','settings','help','events','content','profitability','answers']");
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
    // Lifecycle controls (2026-07-06): edit drafts, pause/resume/stop a live
    // send, duplicate anything finished. Stop and Resume are two-click armed.
    for (const route of ['/campaigns/update', '/campaigns/pause', '/campaigns/resume', '/campaigns/cancel', '/campaigns/duplicate']) {
      expect(scripts).toContain("'" + route + "'");
    }
    for (const attr of ['data-cmp-edit', 'data-cmp-pause', 'data-cmp-resume', 'data-cmp-cancel', 'data-cmp-dup']) {
      expect(scripts).toContain(attr + '="\'+esc(');
    }
    expect(scripts).toContain('Click again to stop this campaign for good');
    expect(scripts).toContain('Click again to resume sending');
    expect(html).toContain('cmp-paused');
    expect(html).toContain('cmp-cancelled');
    for (const id of ['cmp-compose-title', 'cmp-save-btn', 'cmp-edit-cancel']) {
      expect(html).toContain('id="' + id + '"');
    }
    const cmpBlock = scripts.slice(scripts.indexOf('var cmpState'), scripts.indexOf('async function cmpSavePostal('));
    expect(cmpBlock.length).toBeGreaterThan(0);
    expect(cmpBlock).not.toContain('window.confirm');
  });

  // --- Traffic view (2026-07-05): acquisition strategy board ---

  // Traffic activity card (2026-10-07): daily charts above the strategy board,
  // replacing the two fixed-window tile walls of the 2026-09-05 quality card.
  // It reads /traffic/activity for a 7, 30 or 90 day window, and only when the
  // Traffic view is open: the console boots every view, and three ShopifyQL
  // calls on every open of any view would be load for nothing.
  it('renders the Traffic activity card above the board, with a 7/30/90 day range control', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="trf-activity"');
    expect(html.indexOf('id="trf-activity"')).toBeLessThan(html.indexOf('id="trf-list"'));
    for (const d of ['7', '30', '90']) expect(html).toContain('data-trf-days="' + d + '"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function trfActivityLoad(');
    expect(scripts).toContain("'/traffic/activity'");
    expect(scripts).not.toContain("'/traffic/quality'");
    for (const label of ['People', 'Automated', 'Engaged', 'Single-page', 'read_reports', 'reached checkout']) expect(scripts).toContain(label);
  });

  it('loads the activity charts only when the Traffic view is open, not on every console boot', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function trfMaybeLoadActivity(');
    expect(scripts).toContain('trfActivityAction(trfAct,currentRoute(),');
    // One tick later: this listener is registered before the router's, so the
    // view is not visible yet (width 0) when the hashchange itself fires.
    expect(scripts).toContain("window.addEventListener('hashchange',function(){ setTimeout(trfMaybeLoadActivity,0); })");
    const boot = scripts.slice(scripts.lastIndexOf('loadCampaigns();'));
    expect(boot).not.toContain('trfActivityLoad(');
  });

  describe('traffic chart helpers', () => {
    async function helpers() {
      const html = await consolePage('test-api-key').text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
      const escSrc = scripts.match(/function esc\([\s\S]*?\n\}/)![0];
      const start = scripts.indexOf('function trfNiceMax(');
      const end = scripts.indexOf('// --- end traffic charts ---');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return new Function(escSrc + '\n' + scripts.slice(start, end) + '\nreturn { trfNiceMax: trfNiceMax, trfBarsSvg: trfBarsSvg, trfRankHtml: trfRankHtml, trfActivityAction: trfActivityAction };')() as {
        trfActivityAction: (state: Record<string, unknown>, route: string, width: number, now: number) => string;
        trfNiceMax: (v: number) => number;
        trfBarsSvg: (series: Record<string, unknown>[], layers: { key: string; color: string; label: string }[], opts: { height: number; partialLast?: boolean; marks?: string }) => string;
        trfRankHtml: (items: { label: string; people: number }[], empty: string) => string;
      };
    }
    const week = [
      { day: '2026-10-05', people: 1, engaged: 0, singlePage: 1, cartAdds: 0, reachedCheckout: 0 },
      { day: '2026-10-06', people: 3, engaged: 1, singlePage: 2, cartAdds: 1, reachedCheckout: 1 },
      { day: '2026-10-07', people: 0, engaged: 0, singlePage: 0, cartAdds: 0, reachedCheckout: 0 },
    ];
    const layers = [{ key: 'engaged', color: '#8fe0a6', label: 'Engaged' }, { key: 'singlePage', color: '#4f7a5c', label: 'Single-page' }];

    // A load that finishes while another view is showing draws at width 0 (a
    // fallback 700, stretched to the card); coming back redraws from the kept
    // response at the real width instead of keeping the stretched chart.
    it('decides on each Traffic visit whether to load, redraw at the new width, or do nothing', async () => {
      const { trfActivityAction } = await helpers();
      const fresh = { last: { ok: true }, loadedAt: 1_000_000, drawnWidth: 1290, inflight: false };
      expect(trfActivityAction(fresh, 'inbox', 1290, 1_000_500)).toBe('none');
      expect(trfActivityAction({ ...fresh, last: null }, 'traffic', 1290, 1_000_500)).toBe('load');
      expect(trfActivityAction(fresh, 'traffic', 1290, 1_000_000 + 300_001)).toBe('load');
      expect(trfActivityAction({ ...fresh, drawnWidth: 0 }, 'traffic', 1290, 1_000_500)).toBe('redraw');
      expect(trfActivityAction(fresh, 'traffic', 1290, 1_000_500)).toBe('none');
      expect(trfActivityAction(fresh, 'traffic', 0, 1_000_500)).toBe('none');
      expect(trfActivityAction({ ...fresh, last: null, inflight: true }, 'traffic', 1290, 1_000_500)).toBe('none');
    });

    it('picks a readable axis top: small counts stay whole, a bot spike gets a round ceiling', async () => {
      const { trfNiceMax } = await helpers();
      expect(trfNiceMax(0)).toBe(1);
      expect(trfNiceMax(3)).toBe(3);
      expect(trfNiceMax(11)).toBe(15);
      expect(trfNiceMax(242)).toBe(300);
    });

    it('draws one hoverable column per day with its date and counts, the last day marked as so far', async () => {
      const { trfBarsSvg } = await helpers();
      const svg = trfBarsSvg(week, layers, { height: 160, partialLast: true, marks: 'cartAdds' });
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('viewBox=');
      expect(svg.match(/<title>/g)?.length).toBe(3);
      expect(svg).toContain('Tue 6 Oct');
      expect(svg).toContain('Engaged 1');
      expect(svg).toContain('Single-page 2');
      expect(svg).toContain('so far');
      expect(svg).toContain('trf-mark'); // the day someone added to cart is marked
    });

    it('draws at the width it is given, so axis text stays its real size in a wide card', async () => {
      const { trfBarsSvg } = await helpers();
      expect(trfBarsSvg(week, layers, { height: 160 })).toContain('viewBox="0 0 700 160"');
      expect(trfBarsSvg(week, layers, { height: 160, width: 1290 } as never)).toContain('viewBox="0 0 1290 160"');
      expect(trfBarsSvg(week, layers, { height: 160, width: 40 } as never)).toContain('viewBox="0 0 320 160"'); // floor
    });

    // Centred on a narrow last column (90 days in a wide card, or 30 days at
    // the 320 floor), the final date ran past the right edge and lost its
    // last letter. It now ends at its own bar's right edge, inside the plot.
    it('keeps the final date label inside the chart at every range and width', async () => {
      const { trfBarsSvg } = await helpers();
      const days = (n: number) => Array.from({ length: n }, (_, i) => {
        const d = new Date(Date.UTC(2026, 9, 7) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        return { day: d, engaged: 1, singlePage: 1 };
      });
      const lastLabel = (svg: string) => {
        const labels = [...svg.matchAll(/<text x="([\d.]+)" y="155" text-anchor="(\w+)">([^<]*)<\/text>/g)];
        const m = labels[labels.length - 1];
        return { x: Number(m[1]), anchor: m[2], text: m[3] };
      };
      for (const [n, width] of [[90, 1022], [30, 1022], [7, 1022], [90, 320], [30, 320], [7, 320]]) {
        const W = Math.max(320, width), padL = 30, padR = 6, slot = (W - padL - padR) / n;
        const cx = padL + (n - 1) * slot + slot / 2;
        const label = lastLabel(trfBarsSvg(days(n), layers, { height: 160, width } as never));
        expect(label.text).toBe(n <= 7 ? 'Wed 7' : '7 Oct');
        expect(label.anchor).toBe('end');
        expect(label.x).toBeLessThanOrEqual(W - padR); // never past the plot's right edge
        expect(label.x).toBeGreaterThanOrEqual(cx); // still under its own bar
      }
    });

    it('escapes every label it writes into the chart', async () => {
      const { trfBarsSvg, trfRankHtml } = await helpers();
      const svg = trfBarsSvg(week, [{ key: 'engaged', color: '#fff', label: '<b>x</b>' }], { height: 100 });
      expect(svg).not.toContain('<b>x</b>');
      expect(svg).toContain('&lt;b&gt;x&lt;/b&gt;');
      const ranked = trfRankHtml([{ label: '/products/<script>', people: 2 }], 'none');
      expect(ranked).not.toContain('<script>');
      expect(ranked).toContain('2');
      expect(trfRankHtml([], 'No people yet')).toContain('No people yet');
    });
  });

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

  // --- Content view (2026-07-07): blog agents author DRAFT posts ---

  it('renders the Content view: rail entry, generate control, list, wired to /blog endpoints', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('data-route="content"');
    expect(html).toContain('id="view-content"');
    for (const id of ['blg-topic', 'blg-gen-btn', 'blg-msg', 'blg-list']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function blogGenerate(');
    expect(scripts).toContain('function loadContent(');
    expect(scripts).toContain("'/blog/generate'");
    expect(scripts).toContain("'/blog/list'");
    expect(scripts).toContain('loadContent();'); // loaded on startup
    // Dynamic values are escaped before innerHTML (XSS discipline).
    expect(scripts).toContain('esc(p.title)');
    // The copy makes the DRAFT-not-published contract explicit to the owner.
    expect(html).toContain('Nothing is published automatically');
  });

  it('blog view carries the Distribution card and its JS wiring', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="syd-channels"');
    expect(html).toContain('id="syd-list"');
    expect(html).toContain('/syndicate/list');
    expect(html).toContain('/syndicate/send');
    expect(html).toContain('/syndicate/config');
    expect(html).toContain('/syndicate/accounts');
    expect(html).toContain('/syndicate/regenerate');
    expect(html).toContain('data-syd-send');
    expect(html).toContain('data-syd-wire');       // account picker: inert data-* + delegation, never inline onclick JS
    expect(html).toContain('sydLoad()');           // wired into loadContent
    expect(html).toContain("prtArm(btn,'Posts publicly - click again to confirm')");
  });

  // --- Profitability view (2026-07-09): active adjust-or-drop agent window ---

  it('renders the Profitability view: rail entry, switches (incl. dry-run), list, ledger, wired to /profit endpoints', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('data-route="profitability"');
    expect(html).toContain('id="view-profitability"');
    for (const id of ['pf-enabled', 'pf-dryrun', 'pf-hardblock', 'pf-adshare', 'pf-banner', 'pf-thresholds', 'pf-summary', 'pf-list', 'pf-ledger', 'pf-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function pfLoad(');
    expect(scripts).toContain('function pfRunNow(');
    expect(scripts).toContain('function pfArchive(');
    // The dry-run flip is wired (preview vs full-auto, onchange in the view HTML)
    // and the ledger renders (function in the script bundle).
    expect(html).toContain("pfSetFlag('dryRun'");
    expect(scripts).toContain('function pfRenderLedger(');
    // Sectioned list + search (2026-07-19): grouped verdict sections replace the
    // old all-or-needs-review toggle, and the search input lives OUTSIDE #pf-list.
    expect(scripts).toContain('function pfToggleSection(');
    expect(scripts).toContain('function pfSearch(');
    expect(html).toContain('id="pf-search"');
    expect(scripts).not.toContain('pfToggleAll');
    // Explanations live in "?" info popovers (2026-07-19, reusing the Partners
    // overlay): hidden help divs wired to openPartnerInfo, and the old inline
    // explanation spans next to the three action buttons are gone.
    expect(html).toContain('data-prt-help="pf-help-agent"');
    expect(html).toContain('id="pf-help-agent"');
    expect(html).toContain('data-prt-help="pf-help-products"');
    expect(html).toContain('id="pf-help-products"');
    expect(html).not.toContain('style="align-self:center;font-size:12px">Wipes every decision');
    // The ad-share tuning field is wired (onchange in the view HTML, handler in JS).
    expect(html).toContain('pfSetAdShare(this.value)');
    expect(scripts).toContain('function pfSetAdShare(');
    for (const route of ["'/profit'", "'/profit/config'", "'/profit/run'", "'/profit/archive'", "'/profit/keep'", "'/profit/reject-match'"]) {
      expect(scripts).toContain(route); // api() prepends /api
    }
    expect(scripts).toContain('pfLoad();'); // loaded on startup
    // The pid rides an ESCAPED data attribute resolved by delegation (XSS discipline),
    // never string-built into inline onclick JS. Same for every row action.
    expect(scripts).toContain('data-pf-pid="\'+esc(');
    expect(scripts).toContain('data-pf-keep="\'+esc(');
    expect(scripts).toContain('data-pf-release="\'+esc(');
    expect(scripts).toContain('data-pf-badmatch="\'+esc(');
    expect(scripts).toContain('function pfKeep(');
    expect(scripts).toContain('function pfRejectMatch(');
    // Archiving one product is two-click armed (prtArm), never automatic - and so
    // is discarding a market match (it changes the judgment basis).
    expect(scripts).toContain('Click again to archive');
    expect(scripts).toContain('Click again to discard this market match');
    // Row actions live behind a per-row Actions dropdown (owner ask 2026-07-12:
    // cleaner table than stacked buttons). The menu is rebuilt per open with the
    // same escaped data-* delegation as before, positioned FIXED so the table's
    // overflow-x wrapper cannot clip it, and closes on outside click / Escape.
    expect(scripts).toContain('data-pf-menu="\'+esc(');
    expect(scripts).toContain('function pfOpenMenu(');
    expect(scripts).toContain('function pfCloseMenu(');
    expect(html).toContain('.pf-menu{position:fixed');
    expect(scripts).toContain('pf-actions-c');
    // The kept override is visible on the row.
    expect(scripts).toContain('pf-kept');
    // profitability is appended to ROUTES so the digit shortcuts stay stable.
    expect(scripts).toContain("'events','content','profitability'");
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
    // Setup reports the VERIFIED post-enable state (2026-07-12: 93 delivered /
    // 0 opened - the button must prove the enable stuck, not assume it).
    expect(scripts).toContain('r.verified');
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
    // 2026-09-05 (owner): a card that shows only "ends 30/08/2027" reads as a
    // promotion running continuously until then. Both ends of the window are
    // shown, worded by state: "starts" for a scheduled event, "started" for a
    // running one.
    expect(scripts).toContain("'starts '");
    expect(scripts).toContain("'started '");
    // 2026-09-05 leftover (b): the windows are UTC calendar days (a 23:59:59Z
    // end), but prtWhen formats in the browser's zone, so during BST an event
    // "ends" the day after it does. The Events view formats its window dates
    // in UTC through evDay; prtWhen stays for the timestamps elsewhere.
    expect(scripts).toContain('evDay(p.startsAt)');
    expect(scripts).toContain('evDay(p.endsAt)');
    expect(scripts).toContain('evDay(ev.nextStartsAt)');
    expect(scripts).not.toContain('prtWhen(p.startsAt)');
    const evDayLine = scripts.split('\n').find((l) => l.includes('function evDay('));
    expect(evDayLine).toBeDefined();
    expect(evDayLine).toContain("timeZone:'UTC'");
    expect(scripts).toContain('loadDiscountStatus();'); // probe runs on startup
    // A missing write_discounts grant explains the fix, not a stack trace.
    expect(scripts).toContain('approve the updated permissions');
  });

  // --- Events view (2026-07-06): yearly recurring cards + one-off form ---

  it('the Events view carries the one-off form wired to /event/create and /event/end', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="view-events"');
    expect(html).toContain('data-route="events"');
    for (const id of ['ev-promos', 'ev-recurring', 'ev-rec-msg', 'ev-code', 'ev-pct', 'ev-start', 'ev-end', 'ev-stage-chk', 'ev-create-btn', 'ev-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function evCreate(');
    expect(scripts).toContain('function evEnd(');
    expect(scripts).toContain("'/event/create'");
    expect(scripts).toContain("'/event/end'");
    expect(scripts).toContain('evLoad();'); // probe runs at startup
    // Consequential buttons are two-click armed, ids ride in escaped data attrs.
    expect(scripts).toContain('Click again to create the event');
    expect(scripts).toContain('Click again to end the event');
    expect(scripts).toContain('data-ev-end="\'+esc(');
    // Events is appended to ROUTES so the existing digit shortcuts stay stable.
    expect(scripts).toContain("'settings','help','events'");
  });

  it('yearly event cards toggle through /events/recurring with armed buttons', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function evRecLoad(');
    expect(scripts).toContain('function evRecToggle(');
    expect(scripts).toContain("'/events/recurring'");
    expect(scripts).toContain("'/events/recurring/toggle'");
    expect(scripts).toContain('Click again to enable');
    expect(scripts).toContain('Click again to disable');
    expect(scripts).toContain('data-ev-on="\'+esc(');
    expect(scripts).toContain('data-ev-off="\'+esc(');
    expect(scripts).toContain('evRecLoad();'); // cards load at startup
  });

  // --- System states register (2026-07-06): the live truth table of switches ---

  it('Settings carries the System states register, loaded live on startup', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="sys-states"');
    expect(html).toContain('System states');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadSystemStates(');
    expect(scripts).toContain("'/system-states'");
    expect(scripts).toContain('loadSystemStates();'); // read live at startup
    // Register rows are rendered with esc() on every dynamic value.
    expect(scripts).toContain("sysChip(st)");
    expect(scripts).toContain("esc(st.label)");
    expect(scripts).toContain("esc(st.source)");
  });

  it('Settings carries the AI spend daily ledger, loaded live on startup', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="llm-usage"');
    expect(html).toContain('AI spend');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadLlmUsage(');
    expect(scripts).toContain("'/llm/usage'");
    expect(scripts).toContain('loadLlmUsage();'); // read live at startup
    // Ledger rows are rendered with esc() on every dynamic value.
    expect(scripts).toContain('esc(row.task)');
    expect(scripts).toContain('esc(row.model)');
    expect(scripts).toContain('esc(Number(row.cost_usd).toFixed(4))');
  });

  // --- Draft templates (2026-07-06): swap the pending draft from a dropdown ---

  // Sender-level block (owner rule 2026-09-04): a blocked sender is visible on
  // the thread, and the block is reversible from the same place.
  it('Inbox shows a blocked-sender badge with an Unblock button wired to /inbox/unblock', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('id="inbox-unblock-btn"');
    expect(scripts).toContain('Blocked sender');
    expect(scripts).toContain("'/inbox/unblock'");
  });

  // aramid b4b33fbf, rest of it (2026-10-07): every blocked address in one
  // place, each with its own Unblock, loaded only when the panel is opened.
  it('Inbox lists blocked senders on demand, each with an Unblock by email', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('id="ibx-blocked"');
    expect(html).toContain('id="ibx-blocked-list"');
    expect(scripts).toContain("'/inbox/blocked'");
    expect(scripts).toContain('data-unblock-email');
    expect(scripts).toMatch(/api\('\/inbox\/unblock',\s*\{\s*email:/);
    expect(scripts).toContain('esc(x.email)');
    expect(scripts).toContain('esc(x.reason');
  });

  // Owner review 2026-09-04: the picker mirrors the five live templates and
  // nothing else; the four superseded funnel entries must not linger in the JS.
  it('the picker no longer offers the superseded funnel templates', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join(' ');
    for (const gone of ['value="qualifying"', 'value="voucher_invite"', 'value="partnership_decline"', 'value="holding_ack"', 'Partnership screening questions', 'Holding note (we are reviewing)']) {
      expect(scripts, gone).not.toContain(gone);
    }
    expect(scripts).toContain('value="signup_followup"');
    expect(scripts).toContain('value="collaboration_decline"');
    // 2026-09-17 (prove-first): the service decline is retired in favour of the
    // prove-first answer, and the supplier thank-you joins the picker.
    expect(scripts).not.toContain('value="service_decline"');
    expect(scripts).toContain('value="service_prove_first"');
    expect(scripts).toContain('value="supplier_ack"');
    expect(scripts).toContain('value="access_decline"');
  });

  it('Inbox carries the template picker wired to /inbox/template', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('id="inbox-tpl-sel"');
    expect(scripts).toContain("'/inbox/template'");
    expect(scripts).toContain('function applyTemplateAction(');
    // The dropdown's options mirror the server registry EXACTLY - a key or
    // label changed on one side without the other fails here.
    for (const t of DRAFT_TEMPLATES) {
      expect(scripts).toContain('value="' + t.key + '"');
      expect(scripts).toContain('>' + t.label + '<');
    }
    // The picker also renders on threads with no pending draft (it creates one).
    // 2026-09-27: that branch now also offers Draft anyway/Draft a reply, so the
    // literal text changed; the picker itself still rides alongside it.
    expect(scripts).toContain('No draft pending');
    expect(scripts).toContain("Draft a reply</button> '+tplSel");
  });

  // --- Per-row reissue (2026-07-06): finished rows restart the same partner ---

  it('revoked/expired rows offer one-click Reissue through /partners/issue', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function reissuePartnerVoucher(');
    expect(scripts).toContain('data-prt-reissue="\'+esc(');
    // Only when the partner has no live code anywhere - reissue can never
    // mint a duplicate active discount for the same person.
    expect(scripts).toContain("p.status!=='live'&&!live[p.partnerId]");
    // Armed like every other consequential button (it creates a real code).
    expect(scripts).toContain('Click again to reissue');
  });

  // --- Partners table redesign (2026-07-06): rows scale to 100+ partners ---

  it('Partners renders as tables with a per-row Actions menu and info popovers', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('.prt-table');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function prtVoucherRowHtml(');
    expect(scripts).toContain('function prtToggleMenu(');
    expect(scripts).toContain('prt-float-menu');
    // The menu is a single fixed-position panel so the table's overflow-x
    // wrapper cannot clip it, and it survives clicks inside itself so armed
    // actions can ask-and-confirm without the menu vanishing.
    expect(html).toContain('.prt-menu{position:fixed');
    expect(scripts).toContain("t.closest('#prt-float-menu')");
    // Long how-it-works prose lives in hidden divs opened as an info popover.
    expect(html).toContain('data-prt-help="prt-help-list"');
    expect(html).toContain('data-prt-help="prt-help-issue"');
    expect(html).toContain('id="prt-info-overlay"');
    expect(scripts).toContain('function openPartnerInfo(');
  });

  // --- Trial code queue (2026-07-06): qualify in the Inbox, issue later ---

  it('the inbox context rail offers Add to trial code queue via /inbox/queue-partner', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function queuePartnerAction(');
    expect(scripts).toContain("'/inbox/queue-partner'");
    expect(scripts).toContain('Add to trial code queue');
    // Queueing is bookkeeping only; the copy says so and nothing is sent.
    expect(scripts).toContain('Sends nothing now.');
  });

  it('the inbox Partnership panel records the partner updates opt-in where the yes arrives', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function threadConsentAction(');
    expect(scripts).toContain("'/inbox/partner-consent'");
    // Guardrail copy: only on the sender's own yes, never mere correspondence.
    expect(scripts).toContain('Only when they have themselves said yes');
    // Queue rows in Partners carry the same consent switch and chip.
    expect(scripts).toContain('q.marketingConsent');
  });

  it('Partners renders the queue with armed Issue code now / Remove actions', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function prtQueueHtml(');
    expect(scripts).toContain('function issueQueuedPartner(');
    expect(scripts).toContain('function unqueuePartner(');
    expect(scripts).toContain("'/partners/queue-remove'");
    // Ids/emails ride in escaped data attributes, resolved by delegation.
    expect(scripts).toContain('data-prt-issueq="\'+esc(');
    expect(scripts).toContain('data-prt-unqueue="\'+esc(');
    // Issue mints a real Shopify discount - two-click armed like reissue.
    expect(scripts).toContain('Click again to issue');
  });

  // --- Commission payout records (2026-07-06): accounting documentation ---

  it('payouts are recorded through a modal and documented with exportable statements', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="prt-payout-overlay"');
    expect(html).toContain('id="prt-payout-method"');
    expect(html).toContain('id="prt-payout-ref"');
    expect(html).toContain('Ledger CSV');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function recordPartnerPayout(');
    expect(scripts).toContain('function prtStatementCsv(');
    expect(scripts).toContain('function exportPartnerLedger(');
    expect(scripts).toContain('function prtCsvDownload(');
    // Statement rows come from the FROZEN payout snapshot, not the live ledger.
    expect(scripts).toContain('Payout history');
    expect(scripts).toContain('data-prt-stmt=');
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
    // Mark-paid opens the payout-record modal; its Record button is armed.
    expect(scripts).toContain('function prtOpenPayout(');
    expect(scripts).toContain('Click again to record');
    // Revoke really deactivates the code in Shopify (write_discounts); when
    // Shopify does not confirm, the message tells the owner the manual step.
    expect(scripts).toContain('deactivated in Shopify too');
    expect(scripts).toContain('disable the code under Discounts in Shopify admin');
    // The modal suppresses the digit view-switch shortcuts while open.
    expect(scripts).toContain('__modalOpen');
  });

  // --- Self-serve affiliate marketplace (Task 6, 2026-07-12): Applications
  // card, self-referral order flag, and the selfServe config section ---

  it('renders the self-serve Applications card wired to /affiliate/applications with two-click armed owner actions', async () => {
    const html = await consolePage('test-api-key').text();
    expect(html).toContain('id="prt-app-list"');
    expect(html).toContain('id="prt-app-msg"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function loadApplications(');
    expect(scripts).toContain("'/affiliate/applications'");           // api() prepends /api
    expect(scripts).toContain("'/affiliate/applications/approve'");
    expect(scripts).toContain("'/affiliate/applications/decline'");
    expect(scripts).toContain('loadApplications();');                 // loaded on startup
    // Approve/decline ids ride in ESCAPED data attributes resolved by
    // delegation, never string-built into inline onclick JS.
    expect(scripts).toContain('data-prt-app-approve="\'+esc(');
    expect(scripts).toContain('data-prt-app-decline="\'+esc(');
    expect(scripts).not.toContain("prtApproveApplication('\"+");
    expect(scripts).not.toContain("prtDeclineApplication('\"+");
    // Two-click armed (prtArm), never window.confirm.
    expect(scripts).toContain('Click again to approve');
    expect(scripts).toContain('Click again to decline');
    // Every dynamic application field is escaped before it reaches innerHTML.
    expect(scripts).toContain('esc(a.email)');
    expect(scripts).toContain('esc(a.channelUrl)');
    expect(scripts).toContain('esc(a.flagsSummary');
  });

  it('flags a self-referral order in the Partners orders drill-down', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const orderRowFn = scripts.slice(scripts.indexOf('function prtOrderRowHtml('), scripts.indexOf('function prtOrderRowHtml(') + 800);
    expect(orderRowFn).toContain('o.selfReferral');
    expect(orderRowFn.toLowerCase()).toContain('self-referral');
  });

  it('renders the self-serve config section wired to /affiliate/config, saving all five fields', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['prt-ss-enabled', 'prt-ss-cap', 'prt-ss-spend', 'prt-ss-score', 'prt-ss-usage', 'prt-ss-msg']) {
      expect(html).toContain('id="' + id + '"');
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function saveSelfServeConfig(');
    expect(scripts).toContain("'/affiliate/config'");
    for (const field of ['enabled', 'autoIssueCapPerDay', 'screenSpendCapGbpPerDay', 'scoreThreshold', 'starterUsageLimit']) {
      expect(scripts).toContain(field);
    }
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

  it('Answer library is its own page (view-answers) wired to /inbox/answers with search + delegated toggles', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['ans-list', 'ans-count', 'ans-msg', 'ans-search']) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('<h1>Answer library</h1>');
    expect(html).toContain('.ansp-card'); // full-page stacked card CSS present
    // Promoted OUT of the cramped inbox <details> (2026-07-13): the old scoped
    // card and its 320px max-height clamp are gone, and the mail workspace no
    // longer carries the library markup.
    expect(html).not.toContain('id="ans-card"');
    expect(html).not.toContain('<details class="card" id="ans-card">');
    expect(html).not.toContain('#ans-list{max-height');
    expect(html).not.toContain('.ans-row{display:grid'); // old 3-col grid retired
    // Inbox workspace still owns its viewport floor (unrelated, unchanged).
    expect(html).toContain('.ibx{display:flex;flex-direction:column;flex:1 1 auto;min-height:min(300px,60vh)}');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function ansLoad(');
    expect(scripts).toContain('function ansToggle(');
    expect(scripts).toContain('function ansFilter(');
    expect(scripts).toContain("'/inbox/answers'");
    expect(scripts).toContain("'/inbox/answers/toggle'");
    // qhash rides an ESCAPED data attribute resolved by delegation, never inline onclick JS.
    expect(scripts).toContain('data-ans-toggle="\'+esc(');
    // Lazy-loaded on first open of #/answers, NOT on every console boot.
    expect(scripts).not.toContain('\nansLoad();');
    expect(scripts).toContain("window.addEventListener('hashchange',ansMaybe)");
  });

  it('inbox: a Suppliers view with the dropshipping column, a back-fill button, and Draft anyway on no-reply threads', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('data-filter="suppliers"');
    expect(scripts).toContain('id="ibx-sup-f-dropship"');
    expect(scripts).toContain('id="ibx-sup-f-kind"');
    expect(scripts).toContain('id="ibx-sup-f-fit"');
    expect(scripts).toContain('function ibxOpenSuppliers(');
    expect(scripts).toContain("api('/inbox/suppliers'");
    expect(scripts).toContain('Dropshipping');
    expect(scripts).toContain('Scan past inbox for suppliers');
    expect(scripts).toContain('No reply needed');
    expect(scripts).toContain("api('/inbox/draft-anyway'");
    expect(scripts).toContain('rel="noopener noreferrer"');
  });

  // Review Focus 2 (constraints.md): a supplier email carrying javascript: or
  // data: links, or HTML in its company name, must never produce a clickable
  // unsafe link or raw markup in the console. Runs the ACTUAL browser esc()/
  // ibxSupLink() source pulled out of the page (not a re-implementation), so a
  // future edit to either function is caught here.
  it('the suppliers table never renders an unsafe link or unescaped markup', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const escSrc = scripts.match(/function esc\(s\)\{[^\n]*/)![0];
    const linkSrc = scripts.match(/function ibxSupLink\(u,label\)\{[\s\S]*?\n\}/)![0];
    const ibxSupLink = new Function(escSrc + '\n' + linkSrc + '\nreturn ibxSupLink;')() as (u: unknown, label: unknown) => string;
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'JAVASCRIPT:alert(1)', ' https://x.example/']) {
      expect(ibxSupLink(unsafe, 'label')).toBe('');
    }
    const withQuote = ibxSupLink('https://a.cn/"onmouseover="alert(1)', 'w');
    expect(withQuote).toContain('&quot;');
    expect(withQuote).not.toContain('"onmouseover');
    const withHtmlLabel = ibxSupLink('https://a.cn/', '<img src=x onerror=alert(1)>');
    expect(withHtmlLabel).not.toContain('<img');
    expect(withHtmlLabel).toContain('&lt;img');
    // Source guard: the row-render code must esc() company/contact/product
    // fields rather than splice them in raw, mirroring the invoice-field guard
    // above (the same XSS class as W-INBOX-1).
    expect(scripts).not.toMatch(/'\s*\+\s*s\.company\s*\+/);
    expect(scripts).not.toMatch(/'\s*\+\s*s\.contact_name\s*\+/);
    expect(scripts).not.toMatch(/'\s*\+\s*\(s\.productLines/);
  });

  // Fix round 1 (2026-09-27): opening Suppliers must go through the same
  // unsent-draft-edits guard as switching threads (ibxRowClick), not bypass it.
  it('the Suppliers chip checks ibxDraftEdited through the same two-click-confirm guard as switching threads', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(html).toContain('onclick="ibxSuppliersChipClick()"');
    expect(scripts).toContain('function ibxSuppliersChipClick(');
    expect(scripts).toContain("ibxSelectedId!==null&&ibxDraftEdited()&&ibxSwitchArmedId!=='suppliers'");
    expect(scripts).toContain("ibxSwitchArmedId='suppliers'");
  });
});

describe('inbox supplier results', () => {
  async function renderFn() {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const start = scripts.indexOf('function renderSupplierOffers(');
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0; let end = scripts.indexOf('{', start);
    for (let i = end; i < scripts.length; i++) {
      if (scripts[i] === '{') depth++;
      else if (scripts[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const esc = (s: unknown) => String(s).replace(/</g, '&lt;');
    return new Function('esc', scripts.slice(start, end) + '\nreturn renderSupplierOffers;')(esc);
  }

  it('labels an overseas offer with its delivery band and an Import button', async () => {
    const render = await renderFn();
    const out = render([{ pid: 'T1', title: 'Smart GPS Pet Tracker', image: '', priceGbp: 26.99, origin: 'CN', overseas: true, days: '9-20', descriptionText: '', handle: null }], 'GB', true);
    expect(out).toContain('Smart GPS Pet Tracker');
    expect(out).toContain('£26.99');
    expect(out).toContain('ships from overseas');
    expect(out).toContain('9-20 days to GB');
    expect(out).toContain('data-src-import="T1"');
  });

  it('links an offer already in the catalog instead of offering an import', async () => {
    const render = await renderFn();
    const out = render([{ pid: 'T1', title: 'Tracker', image: '', priceGbp: 26.99, origin: 'CN', overseas: true, days: '9-20', descriptionText: '', handle: 'smart-gps-pet-tracker' }], 'GB', true);
    expect(out).toContain('/products/smart-gps-pet-tracker');
    expect(out).not.toContain('data-src-import=');
  });

  /** The console's own importForInquiry, run against a fake api(): `selected` is
   *  the thread the owner has open, `edited` whether its draft has unsaved edits. */
  async function runImport(selected: string, edited: boolean, statusReply: Record<string, unknown>) {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const start = scripts.indexOf('async function importForInquiry(');
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0; let end = scripts.indexOf('{', start);
    for (let i = end; i < scripts.length; i++) {
      if (scripts[i] === '{') depth++;
      else if (scripts[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const calls: [string, unknown][] = []; const opened: string[] = []; const msgs: string[] = [];
    const replies: Record<string, unknown[]> = {
      '/inbox/source-import': [{ ok: true, state: 'importing', handle: null }],
      '/inbox/source-status': [statusReply],
    };
    const api = async (path: string, body: unknown) => { calls.push([path, body]); return replies[path].shift(); };
    const deps = { api, setMsg: (_id: string, m: string) => { msgs.push(m); }, openInboxThread: (id: string) => { opened.push(id); }, errText: String, setTimeout: (f: () => void) => f(), ibxSelectedId: selected, ibxDraftEdited: () => edited };
    const run = new Function(...Object.keys(deps), scripts.slice(start, end) + '\nreturn importForInquiry;')(...Object.values(deps));
    await run('T1', 'th1');
    return { calls, opened, msgs };
  }

  it('asks for the held reply to be redrafted once the import lands, and reopens the thread', async () => {
    const r = await runImport('th1', false, { ok: true, state: 'imported', handle: 'smart-gps-pet-tracker', draftRefreshed: true });
    expect(r.calls[1]).toEqual(['/inbox/source-status', { pid: 'T1', threadId: 'th1' }]);
    expect(r.opened).toEqual(['th1']);
    expect(r.msgs.at(-1)).toContain('redrafted');
  });

  it('never redrafts or reloads over unsaved edits to the open draft', async () => {
    const r = await runImport('th1', true, { ok: true, state: 'imported', handle: 'smart-gps-pet-tracker', draftRefreshed: false });
    expect(r.calls[1]).toEqual(['/inbox/source-status', { pid: 'T1', threadId: '' }]);
    expect(r.opened).toEqual([]);
    expect(r.msgs.at(-1)).toContain('Regenerate');
  });

  it('does not pull the owner back to the thread after they moved on', async () => {
    const r = await runImport('th2', true, { ok: true, state: 'imported', handle: 'smart-gps-pet-tracker', draftRefreshed: true });
    expect(r.calls[1]).toEqual(['/inbox/source-status', { pid: 'T1', threadId: 'th1' }]);
    expect(r.opened).toEqual([]);
  });

  it('says so when the country was assumed', async () => {
    const render = await renderFn();
    expect(render([], 'GB', false)).toContain('No supplier match');
    const out = render([{ pid: 'T1', title: 'Tracker', image: '', priceGbp: 1, origin: 'GB', overseas: false, days: '2-5', descriptionText: '', handle: null }], 'GB', false);
    expect(out).toContain('country not stated, UK assumed');
    expect(out).toContain('local stock');
  });
});
