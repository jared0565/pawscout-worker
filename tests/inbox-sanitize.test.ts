import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, applySalutation, salutationName, applyFooter, stripTrailingSignoff } from '../src/inbox/draft';

describe('salutationName (skip honorifics, never greet a title)', () => {
  it('skips a leading title and greets the next name token', () => {
    expect(salutationName('Mr DHIKIRULLAH')).toBe('Dhikirullah');
    expect(salutationName('Dr. Jane Smith')).toBe('Jane');
  });
  it('greets a normal first name, title-cased', () => {
    expect(salutationName('mary johnson')).toBe('Mary');
    expect(salutationName('JANE')).toBe('Jane');
  });
  it('returns null for role inboxes and junk (falls back to "Hi there,")', () => {
    expect(salutationName('support')).toBeNull();
    expect(salutationName('a@b.com')).toBeNull();
    expect(salutationName('')).toBeNull();
  });

  it('uses the email to pick the first name when the display name is surname-first', () => {
    // "Adedigba Ridwan" is surname-first; the email leads with the given name "ridwan"
    expect(salutationName('Adedigba Ridwan', 'ridwanadedigba41@gmail.com')).toBe('Ridwan');
    // normal order is unaffected
    expect(salutationName('Mary Johnson', 'maryjohnson.hub@gmail.com')).toBe('Mary');
  });

  it('does NOT mistake an initial+surname email for a surname-first name', () => {
    // "jsmith" starts with neither "john" nor "smith" -> keep the first token John
    expect(salutationName('John Smith', 'jsmith@example.com')).toBe('John');
  });

  it('falls back to the first token when no email is given', () => {
    expect(salutationName('Adedigba Ridwan')).toBe('Adedigba');
  });
});

// Construct the dash glyphs at runtime so this test file contains NO literal em/en-dash
// (the codebase-wide dash scrub would otherwise rewrite the inputs and make the test vacuous).
const EM = String.fromCharCode(0x2014); // em-dash
const EN = String.fromCharCode(0x2013); // en-dash
const HB = String.fromCharCode(0x2015); // horizontal bar
const DASH_RE = new RegExp('[' + EM + EN + HB + ']'); // glyph-free dash matcher (scrub-safe)

describe('sanitizeOutbound', () => {
  it('replaces em-dash, en-dash and horizontal bar with a hyphen', () => {
    expect(sanitizeOutbound(`co${EM}op`)).toBe('co-op');
    expect(sanitizeOutbound(`5${EN}11 days`)).toBe('5-11 days');
    expect(sanitizeOutbound(`a ${HB} b`)).toBe('a - b');
  });
  it('preserves surrounding spacing (a spaced em-dash becomes a spaced hyphen)', () => {
    expect(sanitizeOutbound(`working together ${EM} we'd love to`)).toBe("working together - we'd love to");
  });
  it('leaves ordinary hyphens and text untouched', () => {
    expect(sanitizeOutbound('best-in-class, 5-7 days')).toBe('best-in-class, 5-7 days');
  });
  it('no em/en-dash glyph survives a sanitized string', () => {
    const out = sanitizeOutbound(`one${EM}two ${EN} three`);
    expect(out).not.toMatch(DASH_RE);
  });
});

describe('applySalutation strips dashes from the composed body', () => {
  it('the final customer-facing draft contains no em/en-dash', () => {
    const body = applySalutation(`Thanks for reaching out ${EM} we'd love to help, in 5${EN}7 days.`, 'Mary');
    expect(body.startsWith('Hi Mary,\n\n')).toBe(true);
    expect(body).not.toMatch(DASH_RE);
    expect(body).toContain("Thanks for reaching out - we'd love to help, in 5-7 days.");
  });
});

describe('stripTrailingSignoff (no doubled sign-offs under the deterministic footer)', () => {
  it('removes a trailing "Best regards" block with a team line', () => {
    expect(stripTrailingSignoff('Yes, we ship to France.\n\nBest regards,\nActive Paw Customer Support'))
      .toBe('Yes, we ship to France.');
  });
  it('removes a bare trailing "Kind regards" line', () => {
    expect(stripTrailingSignoff('Happy to help.\n\nKind regards')).toBe('Happy to help.');
  });
  it('never eats a real sentence that merely contains a courtesy phrase', () => {
    const s = 'Many thanks for your patience while we sorted this. The refund is on its way.';
    expect(stripTrailingSignoff(s)).toBe(s);
    const inline = 'We wish you all the best with your new puppy.';
    expect(stripTrailingSignoff(inline)).toBe(inline);
  });
});

describe('applyFooter (deterministic department signature, lives IN the draft)', () => {
  it('appends the Customer Support footer in the owner format', () => {
    expect(applyFooter('Your order is on its way.', 'service'))
      .toBe('Your order is on its way.\n\nBest Regards,\nActive Paw Customer Support');
  });
  it('appends the Sales Team footer in the owner format', () => {
    expect(applyFooter('Yes, that bed comes in large.', 'sales'))
      .toBe('Yes, that bed comes in large.\n\nBest Regards,\nActive Paw Sales Team');
  });
  it('appends the Partnerships footer for the affiliate lane', () => {
    expect(applyFooter('Thank you for thinking of us.', 'partnership'))
      .toBe('Thank you for thinking of us.\n\nBest Regards,\nActive Paw Partnerships');
  });
  it('appends the Technical Team footer for product and spec questions', () => {
    expect(applyFooter('That bed holds up to 40kg.', 'tech'))
      .toBe('That bed holds up to 40kg.\n\nBest Regards,\nActive Paw Technical Team');
  });
  it('replaces an LLM sign-off instead of doubling it', () => {
    const out = applyFooter('Happy to help.\n\nBest regards,\nActive Paw', 'service');
    expect(out).toBe('Happy to help.\n\nBest Regards,\nActive Paw Customer Support');
  });
  it('sanitizes dashes so the footer path is also em-dash-safe', () => {
    expect(applyFooter(`See you soon ${EM} team`, 'sales')).not.toMatch(DASH_RE);
  });
});
