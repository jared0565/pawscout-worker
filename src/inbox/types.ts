export const INBOX_LABELS = [
  'lead', 'product-question', 'order-status', 'shipping-returns',
  'wholesale-b2b', 'affiliate', 'complaint', 'supplier', 'spam', 'automated', 'other'
] as const;
export type InboxLabel = (typeof INBOX_LABELS)[number];

export type ThreadStatus =
  | 'new' | 'needs_reply' | 'awaiting_customer' | 'converted' | 'closed' | 'spam';

/** How affiliate/partnership approaches are handled (owner-set, 2026-07-04):
 *  'signup_page' (owner policy 2026-07-18, now that the self-serve marketplace
 *  is live) points new approaches at the public application form, where
 *  screening, terms and code issuance run on the standard rails; in-flight
 *  email-funnel applicants continue on the legacy machine. 'funnel_voucher'
 *  screens candidates over email for a discount-code trial; 'funnel_link' is
 *  the preserved link-partnership funnel; 'decline_all' politely declines
 *  everything (the 2026-07-03 policy, kept behind this toggle). All funnel
 *  emails stay HITL. */
export type AffiliateMode = 'signup_page' | 'funnel_voucher' | 'funnel_link' | 'decline_all';
export const AFFILIATE_MODES: readonly AffiliateMode[] = ['signup_page', 'funnel_voucher', 'funnel_link', 'decline_all'];

export interface InboxConfig {
  enabled: boolean;
  alertEmail?: string;      // owner address for high-signal alerts; falls back to fulfil.alertEmail
  intentThreshold: number;  // 0-100; intentScore >= this → hot-lead alert
  labels: string[];         // allowed taxonomy (defaults to INBOX_LABELS)
  autosend: boolean;        // HITL (false) | Auto (true)
  autoConfidenceThreshold: number; // 0-100; Auto floor
  replyGuidance: string;           // owner's standing voice/instructions, steers every draft
  agents?: Record<string, { autosend: boolean }>; // per-agent auto toggle; resolveAgents fills defaults
  autoInvoice: boolean;               // false = HITL invoicing; true = Auto behind the floor
  invoiceConfidenceThreshold: number; // 0-100; Auto-invoice floor (separate from replies)
  invoiceValueCeiling: number;        // GBP; total above this → HITL
  invoiceRateLimit: number;           // max invoices per contact per 24h
  affiliateMode: AffiliateMode;       // partnership handling; see AffiliateMode
  autoIssueVoucher?: boolean;         // owner switch (default false): a passing voucher screen mints the code + sends the invite automatically (also requires the global autosend master)
  postalAddress?: string;             // business postal address for marketing-email footers (CAN-SPAM); campaigns refuse to send without it
}

export const DEFAULT_INBOX: InboxConfig = {
  enabled: true,
  intentThreshold: 70,
  labels: [...INBOX_LABELS],
  autosend: false,
  autoConfidenceThreshold: 80,
  replyGuidance: '',
  autoInvoice: false,
  invoiceConfidenceThreshold: 95,
  invoiceValueCeiling: 250,
  invoiceRateLimit: 2,
  affiliateMode: 'funnel_voucher'
};

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { email: string; name: string | null };
  to: string[];
  subject: string;
  date: string;             // ISO 8601
  text: string;
  html: string | null;
  headers: Record<string, string>;
}

export interface Classification {
  isHuman: boolean;
  category: InboxLabel;
  intentScore: number;      // 0-100
  summary: string;          // <= 200 chars
  labels: InboxLabel[];
}

export interface DraftResult {
  bodyText: string;            // plain-text reply; HTML is built from this
  confidence: number;          // 0-100 self-reported
  quotesPriceOrOrder: boolean; // LLM's own flag (OR'd with mechanical mentionsMoney downstream)
  commercialIntent: boolean;   // reply carried a CTA / grounded nudge (validator always sets it)
  customerAsks?: string[];     // the model's extract-first plan: what the customer is actually asking ([]=no answerable question)
}

export type DraftStatus = 'pending' | 'approved' | 'sent' | 'auto_sent' | 'discarded' | 'superseded';

export interface DraftRow {
  shop: string; id: string; thread_id: string; body_text: string; body_html: string;
  status: DraftStatus; confidence: number | null; quotes_price_order: number; commercial_intent: number;
  hold_reasons: string | null; model: string | null;
  created_at: string; sent_at: string | null; sent_message_id: string | null;
}

export type InvoiceStatus = 'proposed' | 'sent' | 'paid' | 'discarded' | 'expired' | 'failed' | 'superseded';
export interface InvoiceLineItem { variantId: string; sku: string | null; title: string; qty: number; priceGbp: number }
export interface InvoiceRow {
  shop: string; id: string; thread_id: string; status: InvoiceStatus;
  line_items_json: string; currency: string; total: number; cover_text: string | null;
  confidence: number | null; hold_reasons: string | null;
  shopify_draft_order_id: string | null; invoice_url: string | null; shopify_order_id: string | null;
  created_at: string; sent_at: string | null; paid_at: string | null;
}

export interface ContactRow {
  shop: string; email: string; name: string | null; phone: string | null;
  shopify_customer_id: string | null; message_count: number;
  first_seen_at: string; last_seen_at: string;
  /** Sender-level block (2026-09-04): set when the repeat-message rule fires or the
   * owner blocks them; every later inbound from them lands as spam at ingest. */
  blocked_at: string | null; blocked_reason: string | null;
}
export interface ThreadRow {
  shop: string; id: string; contact_email: string; subject: string | null;
  subject_norm: string | null; status: ThreadStatus; primary_category: string | null;
  intent_score: number | null; summary: string | null; classified_at: string | null;
  last_message_at: string; created_at: string; updated_at: string;
  declared_intent: string | null;  // Phase 2: contact-form Reason dropdown (reinforces classifier)
  reading_json: string | null;     // latest thread reading (src/inbox/thread-read.ts), JSON
  read_at: string | null;          // when that reading was taken
}
export interface MessageRow {
  shop: string; id: string; thread_id: string; direction: 'inbound' | 'outbound';
  message_id: string | null; in_reply_to: string | null; ref_ids: string | null;
  from_addr: string; to_addr: string | null; subject: string | null;
  body_text: string | null; body_html: string | null; headers_json: string | null;
  received_at: string; created_at: string;
}

// --- Affiliate inbound gating (Phase 1) ---
export type PartnershipStage =
  | 'screen_sent' | 'screen_answered' | 'passed_to_form' | 'declined' | 'escalated';

/** Controlled-vocabulary facts the LLM extracts from an applicant's screen answers.
 * Every field is an enum or a string[] so the deterministic scorer can map it. */
export interface ScreenFacts {
  channelUrls: string[];
  disqualifier: 'coupon_cashback' | 'brand_bidding' | 'prohibited_tactics' | 'none';
  audienceRelevance: 'pet_uk' | 'partial' | 'off' | 'unknown';
  acceptsTerms: 'yes' | 'no' | 'unclear';
  engagement: 'plausible' | 'unclear' | 'implausible';
  evidence: 'concrete' | 'vague' | 'none';
  experience: 'strong' | 'some' | 'none';
  method: 'content' | 'mixed' | 'discount' | 'unknown';
  specificity: 'specific' | 'partial' | 'vague';
}

export interface ScreenVerdict {
  decision: 'form' | 'escalate' | 'decline';
  score: number | null;             // null when a hard gate tripped
  gate: string | null;              // 'G1'..'G5' | 'LOW' | null
  signals: Record<string, number>;  // per-signal 0-2 (empty when gated)
  reasons: string[];
}

export interface ApplicantRow {
  shop: string; id: string; thread_id: string; contact_email: string;
  stage: PartnershipStage; declared_intent: string | null;
  verdict_json: string | null; score: number | null;
  created_at: string; updated_at: string;
}
