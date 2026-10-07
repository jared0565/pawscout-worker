import { describe, it, expect } from 'vitest';
import { parseInbound, extractContactForm } from '../src/inbox/mime';
import { parseAuthResults, isHardSpam } from '../src/inbox/gates';

const RAW = [
  'From: Jane Doe <jane@example.com>',
  'To: support@activepaw.co.uk',
  'Subject: Re: Do you ship to Ireland?',
  'Message-ID: <abc123@example.com>',
  'In-Reply-To: <prev@activepaw.co.uk>',
  'References: <root@activepaw.co.uk> <prev@activepaw.co.uk>',
  'Date: Wed, 18 Jun 2026 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi, do you ship the slow feeder to Ireland? Thanks, Jane'
].join('\r\n');

describe('parseInbound', () => {
  it('extracts headers, addresses, refs and body', async () => {
    const p = await parseInbound(RAW);
    expect(p.from.email).toBe('jane@example.com');
    expect(p.from.name).toBe('Jane Doe');
    expect(p.to).toContain('support@activepaw.co.uk');
    expect(p.subject).toBe('Re: Do you ship to Ireland?');
    expect(p.messageId).toBe('<abc123@example.com>');
    expect(p.inReplyTo).toBe('<prev@activepaw.co.uk>');
    expect(p.references).toEqual(['<root@activepaw.co.uk>', '<prev@activepaw.co.uk>']);
    expect(p.text).toContain('ship the slow feeder to Ireland');
    expect(p.headers['subject']).toBeDefined(); // headers keyed lowercase
  });

  it('never throws on malformed/empty input', async () => {
    const empty = await parseInbound(new ArrayBuffer(0));
    expect(empty.text).toBe('');
    expect(empty.from.email).toBe('');
    const garbage = await parseInbound('}{ not an email at all \x00\x01');
    expect(garbage).toBeDefined();
    expect(Array.isArray(garbage.references)).toBe(true);
  });

  // aramid 2f32d185 (2026-10-07): the receiving server adds its
  // Authentication-Results at the TOP; anything below it came with the
  // message, so the sender wrote it. Reading the bottom one let a spoofer
  // forge "dmarc=pass" past a real "dmarc=fail".
  it('reads the receiver\'s Authentication-Results (the topmost), never one the sender put further down', async () => {
    const raw = [
      'Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=bank.example; dkim=none; dmarc=fail header.from=bank.example',
      'Received: from attacker.example by mx.cloudflare.net',
      'Authentication-Results: attacker.example; spf=pass; dkim=pass; dmarc=pass',
      'From: Bank <help@bank.example>',
      'To: support@activepaw.co.uk',
      'Subject: Hello',
      '',
      'Hi'
    ].join('\r\n');
    const p = await parseInbound(raw);
    expect(p.headers['authentication-results']).toMatch(/^mx\.cloudflare\.net;/);
    const auth = parseAuthResults(p.headers);
    expect(auth).toEqual({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
    expect(isHardSpam(auth)).toBe(true);
  });

  it('still reads a single Authentication-Results header as before', async () => {
    const raw = ['Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass', RAW].join('\r\n');
    const p = await parseInbound(raw);
    expect(parseAuthResults(p.headers)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(p.from.email).toBe('jane@example.com');
  });
});

describe('extractContactForm', () => {
  it('pulls the real visitor out of a Shopify contact-form notification', async () => {
    const p: Awaited<ReturnType<typeof parseInbound>> = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['support@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-18T10:00:00Z',
      text: 'Name: John Smith\nEmail: john@buyer.com\nPhone: 07700 900000\n\nMessage:\nDo you have the large bed in stock?',
      html: null, headers: { 'reply-to': 'John Smith <john@buyer.com>' }
    };
    const c = extractContactForm(p);
    expect(c).not.toBeNull();
    expect(c!.email).toBe('john@buyer.com');
    expect(c!.name).toBe('John Smith');
    expect(c!.phone).toBe('07700 900000');
    expect(c!.body).toContain('large bed in stock');
  });

  it('returns null for a normal direct email', async () => {
    const p = await parseInbound(RAW);
    expect(extractContactForm(p)).toBeNull();
  });

  it('parses a recognised Reason token from the notification body', async () => {
    const p: Awaited<ReturnType<typeof parseInbound>> = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['contact@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      text: 'Name: Mia Creator\nEmail: mia@creator.com\nReason: partnerships\n\nMessage:\nI run a dog TikTok and want to collaborate.',
      html: null, headers: { 'reply-to': 'Mia Creator <mia@creator.com>' }
    };
    const c = extractContactForm(p);
    expect(c).not.toBeNull();
    expect(c!.reason).toBe('partnerships');
    expect(c!.email).toBe('mia@creator.com');
  });

  it('maps an unknown / general / empty / absent Reason to null (safe degradation)', async () => {
    const base = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['contact@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      html: null as string | null, headers: { 'reply-to': 'Sam <sam@x.com>' }
    };
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: bananas\n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: general\n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: \n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\n\nMessage:\nhi' } as any)!.reason).toBeNull();
  });

  it('does not treat the word "reason" inside the message body as a declared intent', async () => {
    const p = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['support@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      text: 'Email: bob@x.com\n\nMessage:\nThe reason I am writing is to ask about an order.',
      html: null, headers: { 'reply-to': 'Bob <bob@x.com>' }
    };
    expect(extractContactForm(p as any)!.reason).toBeNull();
  });
});
