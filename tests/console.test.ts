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
});
