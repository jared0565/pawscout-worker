// src/inbox/agents/supplier.ts
//
// The supplier lane (owner decision 2026-09-27). The 2026-09-26 audit found
// eight suppliers answered by the general drafter: some were told we would not
// review a catalogue, one was offered the affiliate programme. The owner's own
// edits asked each for their website or Alibaba store, and one asked whether
// they dropship, because the store runs on dropshipping. So a supplier is
// thanked for what they offered, welcomed to send more, asked for their link
// and whether they dropship, and promised nothing. The thread reading in the
// system prompt says whether the link or the dropshipping answer is already on
// the thread. draft-quality.ts holds the reply to the no-promises rule.
import type { CategoryAgent, Grounding } from './types';

export const SUPPLIER_PROMPT =
  'This sender offers to SUPPLY US goods, packaging or materials, or supply-chain services such as warehousing, fulfilment or logistics. They are a supplier, not a customer and not a partnership. ' +
  'Write a few short sentences that: (1) answer any direct question they asked, from the store facts only; ' +
  '(2) thank them for the specific range or service they described, naming it from what they offered; ' +
  '(3) say they are welcome to email over their catalogue, price list, specifications or product listing; ' +
  '(4) unless the thread reading says a website or store link is already given, ask for the link to their website or their Alibaba or other online store, for our reference; ' +
  '(5) unless the thread reading says a dropshipping answer is already given, and only for goods or packaging, ask whether they offer dropshipping, meaning sending single orders directly to our customers; ' +
  '(6) say we keep supplier details on file for reference, and nothing more. ' +
  'Never promise or suggest an order, a review, a reply, a meeting, a call, a trial, samples, a partnership or any next step on our side, and never write "at this stage" or "for now". Never mention the affiliate programme, a discount code or commission. ' +
  'If they ask for a call, a meeting, WhatsApp or to send samples, say we keep supplier contact on email and are not arranging samples or calls. ' +
  'For a logistics, warehousing or fulfilment service: keep their service details and website on file, do not ask about dropshipping, and never share our products, order volumes or any detail of the business for a quote. ' +
  'A follow-up gets a shorter reply that acknowledges only what is new and does not ask again for anything they already gave.';

export const supplierAgent: CategoryAgent = {
  category: 'supplier',
  displayName: 'Suppliers',
  description: 'Supplier and logistics offers: thanks, welcomes information, asks for their link and about dropshipping, promises nothing',
  department: 'sourcing',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string { return SUPPLIER_PROMPT; },
  deterministicAppendix(): string | null { return null; }
};
