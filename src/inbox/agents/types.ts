import type { TenantStore } from '../../tenant-store';
import type { TenantConfig } from '../../types';
import type { AdminGraphql } from '../../shopify-admin';
import type { ThreadRow, InboxLabel } from '../types';

/** Everything an agent needs, assembled once per draft. Agents stay free of I/O wiring. */
export interface AgentContext {
  store: TenantStore;
  cfg: TenantConfig;
  admin: AdminGraphql | null;   // Shopify caller; null when not authed -> agents hedge
  cj: import('../../cj').CjClient | null; // lazily-authed CJ client for live freight fallback; null when unconfigured
  thread: ThreadRow;
  conversation: string;         // full thread text, quoted replies stripped
  latestMessage: string;        // the turn we are answering ('' when only a quote)
  contactEmail: string;
  customerName: string | null;
  productQuery?: string | null; // the thread reader's product phrase; null/absent -> agents use the message text
  llm?: import('../../llm').LlmClient | null; // the catalogue matcher's model; null/absent -> the product agent searches titles only
}

/** Deterministic grounding result. Never thrown; a miss is { confident:false }. */
export interface Grounding {
  confident: boolean;      // real, fresh data found? false => the prompt hedges
  facts: string;           // human-readable facts injected into the system prompt
  quotesFigure: boolean;   // does the appendix introduce a trusted number/date?
  data?: unknown;          // structured payload for the appendix (audit/repro)
  holdReason?: string;     // a named reason this draft must wait for the owner (e.g. 'sourcing_offer')
}

/** Which team signs the reply. Drives the deterministic footer appended to every
 * draft ("Best Regards, / Active Paw Sales Team | Customer Support | Partnerships |
 * Technical Team") so the owner reviews exactly what will be sent - the LLM never
 * writes its own sign-off. Each category picks its department in its agent definition,
 * so a reply is recognisable/auditable by the desk that signed it. */
export type Department = 'sales' | 'service' | 'partnership' | 'tech' | 'sourcing';

/** One dedicated agent per category. A small handler object, not an autonomous loop. */
export interface CategoryAgent {
  category: InboxLabel;
  displayName: string;     // e.g. "Shipping & Returns" (console)
  description: string;     // one-line "grounds in ..." (console)
  department: Department;  // signs the deterministic footer
  commercial: boolean;     // carries a bounded commercial objective?
  /** Optional deterministic P.S. line appended AFTER the footer on the FIRST reply of a
   * thread only (the post-signature P.S. is the most-read line of an email after the
   * opener; repeating it on every turn would read robotic). Fixed copy, never LLM text. */
  postscript?: string;
  ground(ctx: AgentContext): Promise<Grounding>;
  promptFragment(g: Grounding): string;            // category-specific instructions
  deterministicAppendix(g: Grounding): string | null; // verbatim trusted line, or null
}
