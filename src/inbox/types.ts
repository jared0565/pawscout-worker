export const INBOX_LABELS = [
  'lead', 'product-question', 'order-status', 'shipping-returns',
  'wholesale-b2b', 'complaint', 'spam', 'automated', 'other'
] as const;
export type InboxLabel = (typeof INBOX_LABELS)[number];

export type ThreadStatus =
  | 'new' | 'needs_reply' | 'awaiting_customer' | 'converted' | 'closed' | 'spam';

export interface InboxConfig {
  enabled: boolean;
  alertEmail?: string;      // owner address for high-signal alerts; falls back to fulfil.alertEmail
  intentThreshold: number;  // 0-100; intentScore >= this → hot-lead alert
  labels: string[];         // allowed taxonomy (defaults to INBOX_LABELS)
  autosend: boolean;        // ALWAYS false in W-INBOX-1
}

export const DEFAULT_INBOX: InboxConfig = {
  enabled: true,
  intentThreshold: 70,
  labels: [...INBOX_LABELS],
  autosend: false
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

export interface ContactRow {
  shop: string; email: string; name: string | null; phone: string | null;
  shopify_customer_id: string | null; message_count: number;
  first_seen_at: string; last_seen_at: string;
}
export interface ThreadRow {
  shop: string; id: string; contact_email: string; subject: string | null;
  subject_norm: string | null; status: ThreadStatus; primary_category: string | null;
  intent_score: number | null; summary: string | null; classified_at: string | null;
  last_message_at: string; created_at: string; updated_at: string;
}
export interface MessageRow {
  shop: string; id: string; thread_id: string; direction: 'inbound' | 'outbound';
  message_id: string | null; in_reply_to: string | null; ref_ids: string | null;
  from_addr: string; to_addr: string | null; subject: string | null;
  body_text: string | null; body_html: string | null; headers_json: string | null;
  received_at: string; created_at: string;
}
