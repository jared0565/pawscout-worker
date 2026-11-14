// src/inbox/attachments.ts
//
// Inbound files (owner-approved design 2026-11-14, spec
// docs/superpowers/specs/2026-11-14-inbox-attachments-and-reply-shell-design.md).
// Until this existed every attachment was thrown away at parse, and replies
// then claimed catalogues we never held (FOOFEE thread 2d6559b9) or asked for
// one that had arrived (thread de23fa70). One pure rule here decides each MIME
// part: keep it, drop it silently (signature logos, calendar invites), or
// record why it was not kept so the console and the drafter stay truthful.
import type { InboundAttachment } from './types';
import { TenantStore, listOwedFileErasures, clearOwedFileErasure } from '../tenant-store';
import type { Env } from '../types';
import { hmacHex, timingSafeEqual } from '../retention';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_KEPT_PER_MESSAGE = 10;
export const INLINE_LOGO_MAX_BYTES = 100 * 1024;
const MAX_FILENAME_CHARS = 120;

export type PartVerdict = 'store' | 'drop' | 'skipped_type' | 'skipped_size' | 'skipped_count';

// Kept file types, by extension (spec 5.2). Everything else is refused and
// recorded. zip is the owner-visible call in spec section 14: suppliers send
// image packs, and only the owner downloads.
const KEPT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt', 'ods', 'txt', 'rtf',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'zip',
]);

// A declared type in one of these families refuses the part whatever its
// extension says: a ".pdf" declared text/html could still render as a page.
// An empty type or application/octet-stream never contradicts.
const REFUSED_TYPE = /^(?:text\/html|image\/svg\+xml|[\w.+-]+\/[\w.+-]*xml|[\w.+-]+\/[\w.+-]*javascript|application\/x-msdownload|application\/x-sh)$/;

// Extension fallback for a part that arrived without a name.
const EXT_FOR_TYPE: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'text/plain': 'txt', 'text/csv': 'csv',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A filename safe to store and show: the last path segment, without control
 * characters, quotes, angle brackets or backslashes, whitespace collapsed,
 * capped at 120 characters with the extension kept. An empty name becomes
 * attachment-N plus an extension from the declared type. */
export function sanitizeFilename(raw: string | null | undefined, contentType: string, index: number): string {
  const segment = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = segment.replace(/[\u0000-\u001f\u007f"<>\\]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') {
    name = `attachment-${index + 1}.${EXT_FOR_TYPE[contentType.toLowerCase()] ?? 'bin'}`;
  }
  if (name.length > MAX_FILENAME_CHARS) {
    const ext = extensionOf(name);
    const tail = ext && ext.length < 20 ? `.${ext}` : '';
    name = name.slice(0, MAX_FILENAME_CHARS - tail.length) + tail;
  }
  return name;
}

/** Decide one part. `keptSoFar` is how many earlier parts of the same message
 * were judged 'store'. */
export function attachmentDisposition(part: InboundAttachment, keptSoFar: number): PartVerdict {
  const type = part.contentType.toLowerCase();
  const ext = extensionOf(part.filename);
  // A calendar invite is a meeting request, not a file the sender sent us.
  if (type === 'text/calendar' || ext === 'ics') return 'drop';
  // A small inline image with a content id is a signature logo or a pixel.
  const inlineish = part.disposition === 'inline' || part.related;
  if (inlineish && part.contentId && type.startsWith('image/') && part.bytes.byteLength < INLINE_LOGO_MAX_BYTES) return 'drop';
  if (!KEPT_EXTENSIONS.has(ext) || REFUSED_TYPE.test(type)) return 'skipped_type';
  if (part.bytes.byteLength > MAX_ATTACHMENT_BYTES) return 'skipped_size';
  if (keptSoFar >= MAX_KEPT_PER_MESSAGE) return 'skipped_count';
  return 'store';
}

/** Where a kept file lives in R2. The filename is never part of the key: it is
 * untrusted and may be personal data. The thread prefix is what erasure lists. */
export function r2KeyFor(shop: string, threadId: string, attachmentId: string): string {
  return `inbox/${shop}/${threadId}/${attachmentId}`;
}

/** Judge and store one message's file parts (design 5.4). R2 first, then the
 * D1 record; a failed put, or no bucket at all, records the part as
 * store_failed so nothing claims a file we do not hold. Never throws: file
 * storage must never fail, delay or bounce the email itself. */
export async function storeInboundAttachments(
  bucket: R2Bucket | undefined, store: TenantStore,
  input: { threadId: string; messageId: string; attachments: InboundAttachment[] }
): Promise<void> {
  try {
    let kept = 0;
    for (const part of input.attachments) {
      const verdict = attachmentDisposition(part, kept);
      if (verdict === 'drop') continue;
      const id = crypto.randomUUID();
      const base = {
        id, thread_id: input.threadId, message_id: input.messageId, filename: part.filename,
        content_type: part.contentType || 'application/octet-stream', size_bytes: part.bytes.byteLength,
      };
      if (verdict !== 'store') {
        await store.insertAttachment({ ...base, status: verdict, r2_key: null });
        continue;
      }
      kept++;
      const key = r2KeyFor(store.shop, input.threadId, id);
      let stored = false;
      if (bucket) {
        try { await bucket.put(key, part.bytes); stored = true; }
        catch (e) { console.warn(`inbox attachment put failed for ${input.threadId}: ${(e as Error).message}`); }
      }
      await store.insertAttachment({ ...base, status: stored ? 'stored' : 'store_failed', r2_key: stored ? key : null });
    }
  } catch (e) {
    console.warn(`inbox attachment store failed: ${(e as Error).message}`);
  }
}

// --- Download links (design 5.5) ---------------------------------------------
// The console runs inside the Shopify admin iframe and every /api route is a
// session-authed POST, so a file is opened as a plain top-level link instead.
// The link is signed when the thread loads (not on click: a fetch-then-open
// loses the click's user gesture and the browser blocks the new tab), lasts
// 30 minutes, and always downloads: the sender's declared type is never used
// to serve, so an HTML or SVG "catalogue" can never render on this origin.

export const FILE_LINK_TTL_SECONDS = 1800;
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The signed string. The prefix keeps it from ever matching another token. */
export function fileLinkMessage(shop: string, id: string, exp: number): string {
  return `inbox-file:v1|${shop}|${id}|${exp}`;
}

export async function fileUrl(baseUrl: string, secret: string, shop: string, id: string, nowSec: number): Promise<string> {
  const exp = nowSec + FILE_LINK_TTL_SECONDS;
  const sig = await hmacHex(fileLinkMessage(shop, id, exp), secret);
  return `${baseUrl.replace(/\/+$/, '')}/inbox-file/${encodeURIComponent(id)}?shop=${encodeURIComponent(shop)}&exp=${exp}&sig=${sig}`;
}

export async function verifyFileLink(secret: string, shop: string, id: string, exp: string, sig: string, nowSec: number): Promise<'ok' | 'expired' | 'bad'> {
  if (!secret || !shop || !id || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return 'bad';
  const want = await hmacHex(fileLinkMessage(shop, id, Number(exp)), secret);
  if (!timingSafeEqual(want, sig)) return 'bad';
  return Number(exp) < nowSec ? 'expired' : 'ok';
}

/** RFC 6266 / 5987: an ASCII fallback (every non-ASCII character, quote and
 * backslash becomes "_") plus the exact name percent-encoded as UTF-8. */
export function contentDispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const plain = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

/** GET /inbox-file/:id. Outside session auth by design: the signature is the
 * authority, and the record is looked up under the signed shop only. */
export async function serveInboxFile(env: Env, id: string, q: { shop?: string; exp?: string; sig?: string }, nowSec: number): Promise<Response> {
  const shop = q.shop ?? '';
  if (!SHOP_DOMAIN.test(shop)) return plain('forbidden', 403);
  const verdict = await verifyFileLink(env.SHOPIFY_API_SECRET, shop, id, q.exp ?? '', q.sig ?? '', nowSec);
  if (verdict === 'bad') return plain('forbidden', 403);
  if (verdict === 'expired') return plain('This link has expired. Open the thread in PawScout again for a fresh link.', 410);
  const row = await new TenantStore(env.DB, shop).getStoredAttachment(id);
  if (!row?.r2_key || !env.INBOX_FILES) return plain('not found', 404);
  const obj = await env.INBOX_FILES.get(row.r2_key);
  if (!obj) return plain('not found', 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDispositionFor(row.filename),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

// --- Erasure (design 5.8) -----------------------------------------------------
// A GDPR redact records the R2 prefixes it owes in inbox_file_erasures, in the
// same D1 batch that deletes the rows. This finishes the R2 side: from the
// webhook's waitUntil for its own shop, and from the daily file-erasures stage
// for every shop (including one whose tenant row is already gone). A prefix
// whose objects are all gone loses its row; a failure keeps it for the next run.

const ERASE_PAGE = 1000;     // R2 deletes at most 1000 keys per call
const ERASE_MAX_PAGES = 200; // bound one run; the daily stage carries the rest

export async function eraseOwedFiles(bucket: R2Bucket, db: D1Database, shop?: string): Promise<{ deleted: number; remaining: number }> {
  let deleted = 0;
  let remaining = 0;
  for (const row of await listOwedFileErasures(db, shop)) {
    // Never delete outside the shop's own inbox prefix: an empty or foreign
    // prefix would otherwise list (and delete) the whole bucket.
    if (!row.prefix.startsWith(`inbox/${row.shop}/`)) {
      console.warn(`inbox file erasure skipped a prefix outside its shop: ${row.shop} ${row.prefix}`);
      remaining++;
      continue;
    }
    try {
      let done = false;
      for (let page = 0; page < ERASE_MAX_PAGES; page++) {
        const listed = await bucket.list({ prefix: row.prefix, limit: ERASE_PAGE });
        const keys = listed.objects.map((o) => o.key);
        if (keys.length === 0) { done = true; break; }
        await bucket.delete(keys);
        deleted += keys.length;
      }
      if (done) {
        await clearOwedFileErasure(db, row.shop, row.prefix);
      } else {
        remaining++;
      }
    } catch (e) {
      remaining++;
      console.warn(`inbox file erasure failed for ${row.prefix}: ${(e as Error).message}`);
    }
  }
  return { deleted, remaining };
}
