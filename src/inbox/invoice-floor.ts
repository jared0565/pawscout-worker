const ALWAYS_HOLD = new Set(['complaint', 'wholesale-b2b', 'spam', 'automated', 'other']);
/** The only categories an invoice can ever be created for. The sweep reuses it to
 * skip the invoice model for every other thread. */
export const INVOICE_CATEGORIES: ReadonlySet<string> = new Set(['lead', 'product-question']);

/** Deterministic Auto-invoice floor. The LLM never decides; this does. */
export function invoiceSendDecision(opts: {
  autoInvoice: boolean;
  confidence: number;
  threshold: number;
  total: number;
  ceiling: number;
  category: string;
  allResolved: boolean;
  quantitiesWithinCaps: boolean;
  recentInvoiceCount: number;
  rateLimit: number;
}): { create: boolean; holdReasons: string[] } {
  const r: string[] = [];
  if (!opts.autoInvoice) r.push('auto_invoice_off');
  if (opts.confidence < opts.threshold) r.push('low_confidence');
  if (!opts.allResolved) r.push('unresolved_items');
  if (opts.total > opts.ceiling) r.push('over_ceiling');
  if (!opts.quantitiesWithinCaps) r.push('qty_over_cap');
  if (ALWAYS_HOLD.has(opts.category) || !INVOICE_CATEGORIES.has(opts.category)) r.push('always_hold_category');
  if (opts.recentInvoiceCount >= opts.rateLimit) r.push('rate_limited');
  return { create: r.length === 0, holdReasons: r };
}
