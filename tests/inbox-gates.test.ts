import { describe, it, expect } from 'vitest';
import { parseAuthResults, isAutomated, isHardSpam, normalizeSubject } from '../src/inbox/gates';
import type { ParsedEmail } from '../src/inbox/types';

function email(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<x@y>', inReplyTo: null, references: [], from: { email: 'a@b.com', name: null },
    to: ['support@activepaw.co.uk'], subject: 'Hi', date: '2026-06-18T00:00:00Z',
    text: 'hello', html: null, headers: {}, ...over
  };
}

describe('parseAuthResults', () => {
  it('reads spf/dkim/dmarc verdicts', () => {
    const a = parseAuthResults({ 'authentication-results': 'mx.cloudflare.net; spf=pass dkim=pass dmarc=fail' });
    expect(a).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'fail' });
  });
  it('defaults to none when the header is absent', () => {
    expect(parseAuthResults({})).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none' });
  });
  it('does not match a different key whose name ends in the wanted key', () => {
    const a = parseAuthResults({ 'authentication-results': 'mx; my-dkim=pass dkim=fail' });
    expect(a.dkim).toBe('fail');
  });
});

describe('isAutomated', () => {
  it('flags Auto-Submitted', () => {
    expect(isAutomated(email({ headers: { 'auto-submitted': 'auto-replied' } }))).toBe(true);
  });
  it('flags bulk precedence and list mail', () => {
    expect(isAutomated(email({ headers: { precedence: 'bulk' } }))).toBe(true);
    expect(isAutomated(email({ headers: { 'list-unsubscribe': '<https://x>' } }))).toBe(true);
  });
  it('flags no-reply senders', () => {
    expect(isAutomated(email({ from: { email: 'no-reply@shop.com', name: null } }))).toBe(true);
  });
  it('passes a normal human email', () => {
    expect(isAutomated(email({ from: { email: 'jane@example.com', name: 'Jane' } }))).toBe(false);
  });
  it('flags bare Auto-Submitted: auto-submitted but not "no"', () => {
    expect(isAutomated(email({ headers: { 'auto-submitted': 'auto-submitted' } }))).toBe(true);
    expect(isAutomated(email({ headers: { 'auto-submitted': 'no' } }))).toBe(false);
  });
});

describe('isHardSpam', () => {
  it('is true on DMARC fail', () => {
    expect(isHardSpam({ spf: 'pass', dkim: 'fail', dmarc: 'fail' })).toBe(true);
  });
  it('is false when DMARC passes or is absent', () => {
    expect(isHardSpam({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })).toBe(false);
    expect(isHardSpam({ spf: 'none', dkim: 'none', dmarc: 'none' })).toBe(false);
  });
});

describe('normalizeSubject', () => {
  it('strips Re:/Fwd: prefixes and lowercases', () => {
    expect(normalizeSubject('Re: Fwd:  Do you ship?')).toBe('do you ship?');
    expect(normalizeSubject('AW: SV: hello')).toBe('hello');
  });
});
