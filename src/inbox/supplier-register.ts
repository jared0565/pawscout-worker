// The supplier register's row shape and its one merge rule (owner decision
// 2026-09-27). Pure, so the rule is tested without a database: a later reading
// fills or extends a row and never blanks it, the owner's status and notes are
// never touched, and "unknown" never overwrites a supplier's yes or no on
// dropshipping.

export type SupplierKind = 'goods' | 'packaging' | 'logistics';
export type NicheFit = 'on-niche' | 'adjacent' | 'off-niche';
export type Dropship = 'yes' | 'no' | 'unknown';
export type SupplierStatus = 'new' | 'reviewed' | 'dismissed';
export const SUPPLIER_STATUSES: readonly SupplierStatus[] = ['new', 'reviewed', 'dismissed'];

/** What the thread reader extracts about a supplier. */
export interface SupplierFacts {
  company: string | null;
  contactName: string | null;
  website: string | null;
  storeLinks: string[];
  kind: SupplierKind;
  productLines: string[];
  shipsFrom: string | null;
  nicheFit: NicheFit;
  dropship: Dropship;
}

/** One supplier_register row. store_links and product_lines are JSON arrays. */
export interface SupplierRow {
  shop: string; email: string; company: string | null; contact_name: string | null;
  website: string | null; store_links: string; kind: SupplierKind; product_lines: string;
  ships_from: string | null; niche_fit: NicheFit; dropship: Dropship;
  first_thread_id: string | null; first_seen_at: string; last_seen_at: string;
  message_count: number; status: SupplierStatus; notes: string | null;
}

const MAX_STORE_LINKS = 10;
const MAX_PRODUCT_LINES = 20;

function parseList(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function union(a: string[], b: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...a, ...b]) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
    if (out.length >= cap) break;
  }
  return out;
}

/** The facts the supplier asks are judged on (design 2026-11-14, 8.1): the
 * thread's reading merged with the register row, so a link or a dropshipping
 * answer given on an EARLIER thread still counts. Website: the reading's, else
 * the register's. Store links: both. Dropshipping: a yes or no from either side
 * beats unknown (the reading's wins a tie). Kind and niche fit: the reading's,
 * else the register's. Null only when both are absent. Pure. */
export function supplierFactsFor(
  reading: SupplierFacts | null | undefined, row: SupplierRow | null | undefined
): Pick<SupplierFacts, 'website' | 'storeLinks' | 'kind' | 'dropship' | 'nicheFit'> | null {
  if (!reading && !row) return null;
  const known = (d: Dropship | undefined): d is 'yes' | 'no' => d === 'yes' || d === 'no';
  return {
    website: reading?.website || row?.website || null,
    storeLinks: union(reading?.storeLinks ?? [], parseList(row?.store_links), MAX_STORE_LINKS),
    kind: reading?.kind ?? row!.kind,
    dropship: known(reading?.dropship) ? reading!.dropship : known(row?.dropship) ? row!.dropship : 'unknown',
    nicheFit: reading?.nicheFit ?? row!.niche_fit,
  };
}

/** Merge a fresh reading into the stored row (or start one). */
export function mergeSupplier(
  existing: SupplierRow | null,
  incoming: SupplierFacts,
  meta: { email: string; threadId: string; seenAt: string; inboundCount: number }
): Omit<SupplierRow, 'shop'> {
  const e = existing;
  return {
    email: meta.email,
    company: incoming.company ?? e?.company ?? null,
    contact_name: incoming.contactName ?? e?.contact_name ?? null,
    website: incoming.website ?? e?.website ?? null,
    store_links: JSON.stringify(union(parseList(e?.store_links), incoming.storeLinks, MAX_STORE_LINKS)),
    kind: incoming.kind,
    product_lines: JSON.stringify(union(parseList(e?.product_lines), incoming.productLines, MAX_PRODUCT_LINES)),
    ships_from: incoming.shipsFrom ?? e?.ships_from ?? null,
    niche_fit: incoming.nicheFit,
    dropship: incoming.dropship !== 'unknown' ? incoming.dropship : (e?.dropship ?? 'unknown'),
    first_thread_id: e && e.first_seen_at <= meta.seenAt ? e.first_thread_id : meta.threadId,
    first_seen_at: e && e.first_seen_at < meta.seenAt ? e.first_seen_at : meta.seenAt,
    last_seen_at: e && e.last_seen_at > meta.seenAt ? e.last_seen_at : meta.seenAt,
    message_count: Math.max(e?.message_count ?? 0, meta.inboundCount),
    status: e?.status ?? 'new',
    notes: e?.notes ?? null,
  };
}
