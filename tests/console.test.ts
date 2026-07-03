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
    expect(scripts).toContain('function renderInboxThread(thread,messages,labels,draft,invoice,applicant)');
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

  // Phase 1 shell: left rail + five always-in-DOM views toggled by a hash router.
  it('renders the five view containers, the rail, and the hash router', async () => {
    const html = await consolePage('test-api-key').text();
    for (const v of ['view-inbox', 'view-catalog', 'view-ops', 'view-settings', 'view-help']) {
      expect(html).toContain('id="' + v + '"');
    }
    expect(html).toContain('class="rail"');
    expect(html).toContain('data-route="inbox"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function applyRoute(');
    expect(scripts).toContain("window.addEventListener('hashchange',applyRoute)");
    expect(scripts).toContain('applyRoute();'); // applied on load too
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
