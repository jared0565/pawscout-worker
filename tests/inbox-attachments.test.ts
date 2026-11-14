import { describe, it, expect } from 'vitest';
import { attachmentDisposition, sanitizeFilename } from '../src/inbox/attachments';
import type { InboundAttachment } from '../src/inbox/types';

// Spec 2026-11-14 inbox attachments, sections 5.1 and 5.2: one pure rule
// decides every MIME part (store it, drop it silently, or record why it was
// not kept).
const part = (o: Partial<InboundAttachment>): InboundAttachment => ({
  filename: 'a.pdf', contentType: 'application/pdf', disposition: 'attachment',
  contentId: null, related: false, bytes: new Uint8Array(10), ...o,
});

describe('attachmentDisposition', () => {
  it('stores an ordinary PDF', () => expect(attachmentDisposition(part({}), 0)).toBe('store'));

  it('drops a small inline image with a content id (signature logo)', () =>
    expect(attachmentDisposition(part({ filename: 'logo.png', contentType: 'image/png', disposition: 'inline', contentId: '<l@x>', bytes: new Uint8Array(5000) }), 0)).toBe('drop'));

  it('keeps an inline image of 100 KB or more', () =>
    expect(attachmentDisposition(part({ filename: 'photo.jpg', contentType: 'image/jpeg', disposition: 'inline', contentId: '<p@x>', bytes: new Uint8Array(100 * 1024) }), 0)).toBe('store'));

  // Live test 2026-11-14: Gmail rebuilt an inline signature logo as
  // "disposition: attachment" outside multipart/related, Content-ID kept and
  // still shown by the HTML. Shown by the body is what makes it a logo.
  it('drops a small image the HTML shows by cid even when it is marked attachment', () =>
    expect(attachmentDisposition(part({ filename: 'logo.png', contentType: 'image/png', disposition: 'attachment', contentId: '<att2_d4488a1191bd7050>', related: false, shown: true, bytes: new Uint8Array(139) }), 0)).toBe('drop'));

  it('keeps an attached image with a content id that the HTML does not show (Gmail gives every attachment one)', () =>
    expect(attachmentDisposition(part({ filename: 'damage.jpg', contentType: 'image/jpeg', disposition: 'attachment', contentId: '<f_abc123>', related: false, shown: false, bytes: new Uint8Array(5000) }), 0)).toBe('store'));

  it('keeps an image the HTML shows when it is 100 KB or more', () =>
    expect(attachmentDisposition(part({ filename: 'photo.jpg', contentType: 'image/jpeg', disposition: 'attachment', contentId: '<p@x>', shown: true, bytes: new Uint8Array(100 * 1024) }), 0)).toBe('store'));

  // Review Focus 1: Apple Mail sends PDFs inline with a Content-ID.
  it('stores an Apple Mail style inline PDF with a content id', () =>
    expect(attachmentDisposition(part({ disposition: 'inline', contentId: '<c@x>' }), 0)).toBe('store'));

  // Review Focus 3: a meeting invite is not a file the sender "sent us".
  it('drops a calendar invite silently', () => {
    expect(attachmentDisposition(part({ filename: 'invite.ics', contentType: 'text/calendar' }), 0)).toBe('drop');
    expect(attachmentDisposition(part({ filename: 'meeting', contentType: 'text/calendar' }), 0)).toBe('drop');
  });

  // Final review 2026-11-14 (Important 2): a mail client's signature or contact
  // card is not a file the sender sent us; recorded as refused, it made replies
  // say "We were not able to accept the file you sent".
  it.each([
    ['smime.p7s', 'application/pkcs7-signature'], ['smime.p7s', 'application/x-pkcs7-signature'],
    ['signature.asc', 'application/pgp-signature'], ['key.asc', 'application/pgp-keys'],
    ['anna.vcf', 'text/vcard'], ['anna.vcf', 'text/x-vcard'],
    ['smime.p7s', 'application/octet-stream'], ['anna.vcf', ''], ['signature', 'application/pgp-signature'],
  ])('drops %s (%s) silently', (filename, contentType) =>
    expect(attachmentDisposition(part({ filename, contentType }), 0)).toBe('drop'));

  it.each(['x.html', 'x.htm', 'x.svg', 'x.xml', 'x.js', 'x.exe', 'x.msi', 'x.bat', 'x.cmd', 'x.scr', 'x.vbs', 'x.jar', 'x.ps1', 'x.lnk', 'x.iso', 'x.img', 'x.hta', 'x.docm', 'x.xlsm', 'x.pptm', 'x.dotm', 'catalogue.pdf.exe', 'x.eml'])(
    'refuses %s by type', (f) => expect(attachmentDisposition(part({ filename: f, contentType: 'application/octet-stream' }), 0)).toBe('skipped_type'));

  it.each(['a.pdf', 'a.doc', 'a.docx', 'a.xls', 'a.xlsx', 'a.csv', 'a.ppt', 'a.pptx', 'a.odt', 'a.ods', 'a.txt', 'a.rtf', 'a.jpg', 'a.jpeg', 'a.png', 'a.gif', 'a.webp', 'a.heic', 'a.zip'])(
    'keeps %s', (f) => expect(attachmentDisposition(part({ filename: f, contentType: '' }), 0)).toBe('store'));

  it('a declared HTML or SVG type contradicts a kept extension', () => {
    expect(attachmentDisposition(part({ filename: 'a.pdf', contentType: 'text/html' }), 0)).toBe('skipped_type');
    expect(attachmentDisposition(part({ filename: 'a.png', contentType: 'image/svg+xml' }), 0)).toBe('skipped_type');
  });

  it('octet-stream never contradicts', () =>
    expect(attachmentDisposition(part({ contentType: 'application/octet-stream' }), 0)).toBe('store'));

  it('refuses over 20 MB', () =>
    expect(attachmentDisposition(part({ bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), 0)).toBe('skipped_size'));

  it('the eleventh kept part is skipped_count', () =>
    expect(attachmentDisposition(part({}), 10)).toBe('skipped_count'));
});

describe('sanitizeFilename', () => {
  it('keeps the last path segment and drops unsafe characters', () =>
    expect(sanitizeFilename('../../etc/"evil"<x>.pdf', 'application/pdf', 0)).toBe('evilx.pdf'));

  it('names an unnamed part by its position and type', () => {
    expect(sanitizeFilename('', 'application/pdf', 2)).toBe('attachment-3.pdf');
    expect(sanitizeFilename(null, 'image/jpeg', 0)).toBe('attachment-1.jpg');
  });

  // Review Focus 2: Chinese suppliers name files in Chinese.
  it('keeps a non-ASCII name intact', () =>
    expect(sanitizeFilename('产品目录 2026.pdf', 'application/pdf', 0)).toBe('产品目录 2026.pdf'));

  it('caps a long name at 120 characters, keeping the extension', () => {
    const long = sanitizeFilename('a'.repeat(300) + '.xlsx', '', 0);
    expect(long.length).toBe(120);
    expect(long.endsWith('.xlsx')).toBe(true);
  });
});
