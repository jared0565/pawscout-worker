export const AUTO_RATELIMIT_PER_SENDER_DAY = 3;

// Mechanical money/commitment detector - the deterministic backstop to the LLM's
// self-reported flag. Conservative: false positives just route to HITL.
const MONEY_RE = /[£$€]\s?\d|\b(?:gbp|usd|eur)\s?\d|\b\d+(?:\.\d{2})?\s?(?:gbp|usd|eur|pounds?|dollars?|euros?|p|pence)\b|\b\d+\s?%|\b(?:discount|% ?off|percent off|coupon|promo ?code|voucher|invoice|checkout|order (?:now|today)|place (?:an|your) order)\b|\bfree\s+(?:ship\w*|deliver\w*|gift|sample|return\w*|upgrade)\b|\bhalf\s?(?:price|off)\b|\bbuy\s+\w+\s+get\b|\bbogo\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred)\s+(?:pounds?|dollars?|euros?|quid|pence|cents?)\b/i;

export function mentionsMoney(text: string): boolean {
  return MONEY_RE.test(text);
}

/** Deterministic auto-send floor. The LLM never decides; this does. */
export function autoSendDecision(opts: {
  autosend: boolean; confidence: number; threshold: number;
  quotesPriceOrOrder: boolean; bodyText: string; category: string; recentAutoCount: number;
}): { send: boolean; holdReasons: string[] } {
  const reasons: string[] = [];
  if (!opts.autosend) reasons.push('autosend_off');
  if (opts.confidence < opts.threshold) reasons.push('low_confidence');
  if (opts.quotesPriceOrOrder || mentionsMoney(opts.bodyText)) reasons.push('mentions_money');
  if (opts.recentAutoCount >= AUTO_RATELIMIT_PER_SENDER_DAY) reasons.push('rate_limited');
  return { send: reasons.length === 0, holdReasons: reasons };
}
