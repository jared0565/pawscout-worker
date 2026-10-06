import type { TenantStore } from '../tenant-store';
import type { AdminGraphql } from '../shopify-admin';
import { sanitizeOutbound } from '../inbox/draft';
import { needsDescriptionRewrite, PRODUCT_DESC, UPDATE_DESC } from './import';

/**
 * Owner product notes (2026-10-06): one owner-approved factual line appended to
 * a single product's description, for a fact the supplier states only in its
 * images (first use: a 4G tracker collar whose box holds no SIM card). The
 * worker has no other way to edit one live description: descriptions are
 * written at import and by the raw-supplier-copy sweep only.
 *
 * The note is its own `<p class="pawscout-note">` paragraph, so a later note
 * replaces it instead of stacking a second one.
 */

export const NOTE_MAX = 300;
const NOTE_CLASS = 'pawscout-note';
const NOTE_PARAGRAPH = new RegExp(`\\n?<p class="${NOTE_CLASS}">[\\s\\S]*?</p>`, 'g');

/** Why a note may not be written, or null when it may. */
export function productNoteProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return 'The note is empty.';
  if (t.length > NOTE_MAX) return `The note is longer than ${NOTE_MAX} characters.`;
  if (/[<>]/.test(t)) return 'The note must be plain text, not HTML.';
  // The description sweep LLM-rewrites any description that reads like raw
  // supplier copy, and that rewrite would silently drop the note.
  if (needsDescriptionRewrite(t)) return 'The note uses wording the description sweep treats as raw supplier copy (for example refunds or a packing list), so the sweep would rewrite the description and drop it.';
  return null;
}

/** The description with `text` as its single note paragraph at the end. */
export function withProductNote(html: string, text: string): string {
  const escaped = sanitizeOutbound(text.trim()).replace(/&/g, '&amp;');
  return `${html.replace(NOTE_PARAGRAPH, '')}\n<p class="${NOTE_CLASS}">${escaped}</p>`;
}

export async function setProductNote(
  store: TenantStore, admin: AdminGraphql, handle: unknown, text: unknown
): Promise<{ ok: true; productId: string; descriptionHtml: string } | { ok: false; status: number; error: string }> {
  if (typeof handle !== 'string' || !handle.trim()) return { ok: false, status: 400, error: 'A product handle is required.' };
  if (typeof text !== 'string') return { ok: false, status: 400, error: 'The note must be text.' };
  const problem = productNoteProblem(text);
  if (problem) return { ok: false, status: 400, error: problem };

  const link = await store.getLinkByHandle(handle.trim());
  if (!link?.shopify_product_id) return { ok: false, status: 404, error: `No imported product with handle ${handle.trim()}.` };

  const data = await admin(PRODUCT_DESC, { id: link.shopify_product_id }) as { product?: { descriptionHtml?: string } };
  const descriptionHtml = withProductNote(data.product?.descriptionHtml ?? '', text);
  const r = await admin(UPDATE_DESC, { input: { id: link.shopify_product_id, descriptionHtml } }) as {
    productUpdate?: { userErrors?: { message: string }[] };
  };
  const errs = r.productUpdate?.userErrors ?? [];
  if (errs.length) return { ok: false, status: 502, error: `Shopify refused the update: ${errs.map((e) => e.message).join('; ')}` };
  return { ok: true, productId: link.shopify_product_id, descriptionHtml };
}
