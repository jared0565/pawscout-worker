import { describe, it, expect } from 'vitest';
import { parseInbound, extractContactForm } from '../src/inbox/mime';

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
});
