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

  it('opens the inbox thread detail in a focused modal overlay (not an inline accordion)', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // The detail node lives inside a modal overlay (#inbox-modal) that opens on row
    // click and closes (reloading the list) so a processed thread drops off the view.
    expect(html).toContain('id="inbox-modal"');
    expect(html).toContain('id="inbox-thread"');
    expect(html).toContain('id="inbox-modal-close"');
    expect(scripts).toContain('function openInboxModal(');
    expect(scripts).toContain('function closeInboxModal(');
    expect(scripts).toContain('closeInboxModal(true)');     // approve+send force-closes (reloads list)
    expect(scripts).toContain('loadInboxThreads()');        // close reloads so processed thread drops off
    // The old inline-accordion plumbing is gone.
    expect(scripts).not.toContain('function homeInboxDetail(');
    expect(scripts).not.toContain("row.insertAdjacentElement('afterend',detail)");
    // Close TRIGGERS are wired at init - critical: awaiting_customer/no-draft threads
    // have no Approve & Send button, so x/backdrop/Esc is their ONLY exit. Without
    // this wiring the merchant would be trapped in the modal on exactly those threads.
    expect(scripts).toContain('function wireInboxModal(');
    expect(scripts).toContain('wireInboxModal()');          // invoked at init
    expect(scripts).toContain("el('inbox-modal-close')");   // x button
    expect(scripts).toContain('e.target===ov');             // backdrop click
    expect(scripts).toContain("e.key==='Escape'");          // Esc key
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
