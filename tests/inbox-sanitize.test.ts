import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, applySalutation, salutationName } from '../src/inbox/draft';

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
