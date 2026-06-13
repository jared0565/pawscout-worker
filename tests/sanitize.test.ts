import { describe, it, expect } from 'vitest';
import { stripInternalNotes } from '../src/jobs';

describe('stripInternalNotes', () => {
  it('removes the demo-store supplier note', () => {
    const body = '<div class="cj-description"><p>Great product.</p>\n<p><strong>Supplier:</strong> CJ Dropshipping. This product is imported for demo-store dropshipping testing and should be monitored for inventory, price, and listing status before paid traffic is scaled.</p>\n</div>';
    const out = stripInternalNotes(body);
    expect(out).toContain('Great product.');
    expect(out).not.toContain('demo-store');
    expect(out).not.toContain('Supplier:');
    expect(out).toContain('</div>');
  });

  it('removes the demo-category / traffic-testing note', () => {
    const body = '<p>Specs here.</p><p><strong>Demo category:</strong> Pet Health. This product is imported from CJ Dropshipping for storefront, bundle, PDP, and traffic-testing workflows.</p>';
    const out = stripInternalNotes(body);
    expect(out).toBe('<p>Specs here.</p>');
  });

  it('is idempotent and leaves clean bodies untouched', () => {
    const clean = '<div class="cj-description"><p>Lift stubborn pet hair.</p><ul><li>Reusable</li></ul></div>';
    expect(stripInternalNotes(clean)).toBe(clean);
    expect(stripInternalNotes(stripInternalNotes(clean))).toBe(clean);
  });

  it('does not touch a legitimate paragraph that merely says supplier', () => {
    const body = '<p>Supplied in recyclable packaging.</p>';
    expect(stripInternalNotes(body)).toBe(body);
  });

  it('strips multiple internal notes in one body', () => {
    const body = '<p>A</p><p>imported for demo-store testing</p><p>B</p><p>traffic-testing workflows here</p>';
    const out = stripInternalNotes(body);
    expect(out).toBe('<p>A</p><p>B</p>');
  });
});
