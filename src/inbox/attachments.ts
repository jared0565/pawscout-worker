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
