import { describe, it, expect } from 'vitest';
import { parseInbound, extractContactForm, describeParts } from '../src/inbox/mime';
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

// A supplier email carrying a PDF catalogue and an inline signature logo
// (spec 2026-11-14 inbox attachments, 5.1).
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%fake catalogue body for the parser test\n');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const MULTIPART = [
  'From: Jennie <jennie@nongshine.example>',
  'To: contact@activepaw.co.uk',
  'Subject: Our 2026 catalogue',
  'Message-ID: <cat1@nongshine.example>',
  'Date: Fri, 13 Nov 2026 09:12:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please find our catalogue attached.',
  '--b1',
  'Content-Type: application/pdf; name="Catalogue-2026.pdf"',
  'Content-Disposition: attachment; filename="Catalogue-2026.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PDF_BYTES),
  '--b1',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <logo@x>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PNG_BYTES),
  '--b1--',
  ''
].join('\r\n');

describe('parseInbound attachments', () => {
  it('returns attachment parts with their bytes', async () => {
    const p = await parseInbound(MULTIPART);
    expect(p.text).toContain('catalogue attached');
    expect(p.attachments?.map((a) => a.filename)).toEqual(['Catalogue-2026.pdf', 'logo.png']);
    expect(p.attachments?.[0].bytes).toBeInstanceOf(Uint8Array);
    expect(p.attachments?.[0].bytes.byteLength).toBe(PDF_BYTES.byteLength);
    expect(p.attachments?.[0].contentType).toBe('application/pdf');
    expect(p.attachments?.[0].disposition).toBe('attachment');
    expect(p.attachments?.[1].contentId).toBe('<logo@x>');
    expect(p.attachments?.[1].disposition).toBe('inline');
  });

  it('describeParts sums up each part in one line, with no filenames (live test 2026-11-14)', async () => {
    const raw = [
      'From: Kate <kate@supplier.example>', 'To: contact@activepaw.co.uk', 'Subject: Price list',
      'Message-ID: <p1@supplier.example>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="m1"', '',
      '--m1', 'Content-Type: text/html; charset=utf-8', '',
      '<p>Price list attached.</p><img src="cid:sig1@x">',
      '--m1', 'Content-Type: application/pdf; name="Secret-Name.pdf"',
      'Content-Disposition: attachment; filename="Secret-Name.pdf"', 'Content-Transfer-Encoding: base64', '',
      b64(PDF_BYTES),
      '--m1', 'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: attachment; filename="logo.png"', 'Content-ID: <sig1@x>', 'Content-Transfer-Encoding: base64', '',
      b64(PNG_BYTES),
      '--m1--', '',
    ].join('\r\n');
    const line = describeParts(await parseInbound(raw));
    expect(line).toBe(
      `application/pdf disp=attachment cid=- related=0 shown=0 ${PDF_BYTES.byteLength}B; ` +
      `image/png disp=attachment cid=sig1@x related=0 shown=1 ${PNG_BYTES.byteLength}B`);
    expect(line).not.toMatch(/Secret-Name|logo\.png/);
    expect(describeParts(await parseInbound(RAW))).toBe('');
  });

  it('a parse failure returns attachments: []', async () =>
    expect((await parseInbound(new ArrayBuffer(0))).attachments).toEqual([]));

  it('a plain email has no attachments', async () =>
    expect((await parseInbound(RAW)).attachments).toEqual([]));
});

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
