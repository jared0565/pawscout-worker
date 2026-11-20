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
// Owner 2026-11-20: a "no" is worded as not for now ("not this time", "at the
// moment"), never as a permanent no; the 2026-09-27 ban on "for now" is lifted.
import type { CategoryAgent, Grounding } from './types';

export const SUPPLIER_PROMPT =
  'This sender offers to SUPPLY US goods, packaging or materials, or supply-chain services such as warehousing, fulfilment or logistics. They are a supplier, not a customer and not a partnership. ' +
  'Write a few short sentences that: (1) answer any direct question they asked, from the store facts only; ' +
  '(2) mention the range or service they described in a few words (for example "your pet grooming tools"), not a list of every product, and without thanking them again, because the opening thank-you covers that; ' +
  '(3) if the conversation shows a "Files with this message" line, acknowledge those files briefly by name and do not ask for a catalogue; if they mention a file but none arrived, or a "Files sent but not kept" line shows, follow that instead; otherwise say they are welcome to email over their catalogue, price list, specifications or product listing; ' +
  '(4) unless the thread reading says a website or store link is already given, ask for the link to their website or their Alibaba or other online store, for our reference; ' +
  '(5) unless the thread reading says a dropshipping answer is already given, and only for goods or packaging, ask whether they offer dropshipping, meaning sending single orders directly to our customers; ' +
  '(6) say we keep supplier details on file for future reference, and nothing more. ' +
  'Never promise or suggest an order, a review, a reply, a meeting, a call, a trial, samples, a partnership or any next step on our side. Never mention the affiliate programme, a discount code or commission. ' +
  'Whenever the reply says we are not doing something (not ordering, not arranging samples, calls or custom work, not naming styles, no set volume), word it as not for now, in whatever words read naturally, such as "not this time", "at the moment", "for now" or "at present", never as a permanent no; never say when or whether it will change. ' +
  'If they ask for a call, a meeting, WhatsApp or to send samples, say we keep supplier contact on email and are not arranging samples or calls at the moment. ' +
  'For a logistics, warehousing or fulfilment service: keep their service details and website on file, do not ask about dropshipping, and never share our products, order volumes or any detail of the business for a quote. ' +
  'A follow-up gets a shorter reply that acknowledges only what is new and does not ask again for anything they already gave.';

// Off-niche suppliers (design 2026-11-14, 8.2; the owner's ruling): a sender
// whose range is outside dog and cat products is told only that their details
// are noted and kept. No catalogue invitation, no questions, nothing on files.
export const OFF_NICHE_SUPPLIER_PROMPT =
  'This sender offers goods or services outside our range (dog and cat products). Write one or two short sentences after the opener: say we have noted their details and keep them on file for future reference. ' +
  'Answer a direct question only from the store facts. Do not invite a catalogue or any file, do not ask for links, do not ask about dropshipping, do not mention files, and promise nothing.';

/** True when the supplier grounding says the register files this sender off-niche. */
export function isOffNicheGrounding(g: Grounding): boolean {
  return (g.data as { offNiche?: unknown } | undefined)?.offNiche === true;
}

export const supplierAgent: CategoryAgent = {
  category: 'supplier',
  displayName: 'Suppliers',
  description: 'Supplier and logistics offers: thanks, welcomes information, asks for their link and about dropshipping, promises nothing',
  department: 'sourcing',
  commercial: false,
  // Reads the register row, freshly merged from this thread's reading just
  // before. Only "off-niche" shortens the reply: "adjacent", no row, or a read
  // failure keep the full flow, and a failure never throws.
  async ground(ctx): Promise<Grounding> {
    let offNiche = false;
    try {
      offNiche = (await ctx.store.getSupplier(ctx.contactEmail))?.niche_fit === 'off-niche';
    } catch (e) {
      console.warn(`supplier register read failed in ground: ${(e as Error).message}`);
    }
    return { confident: true, facts: '', quotesFigure: false, data: { offNiche } };
  },
  promptFragment(g: Grounding): string { return isOffNicheGrounding(g) ? OFF_NICHE_SUPPLIER_PROMPT : SUPPLIER_PROMPT; },
  deterministicAppendix(): string | null { return null; }
};
