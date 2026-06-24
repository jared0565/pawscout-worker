import type { TenantStore } from '../../tenant-store';
import type { TenantConfig } from '../../types';
import type { AdminGraphql } from '../../shopify-admin';
import type { ThreadRow, InboxLabel } from '../types';

/** Everything an agent needs, assembled once per draft. Agents stay free of I/O wiring. */
export interface AgentContext {
  store: TenantStore;
  cfg: TenantConfig;
  admin: AdminGraphql | null;   // Shopify caller; null when not authed -> agents hedge
  thread: ThreadRow;
  conversation: string;         // full thread text, quoted replies stripped
  latestMessage: string;        // the turn we are answering ('' when only a quote)
  contactEmail: string;
  customerName: string | null;
}

/** Deterministic grounding result. Never thrown; a miss is { confident:false }. */
export interface Grounding {
  confident: boolean;      // real, fresh data found? false => the prompt hedges
  facts: string;           // human-readable facts injected into the system prompt
  quotesFigure: boolean;   // does the appendix introduce a trusted number/date?
  data?: unknown;          // structured payload for the appendix (audit/repro)
}

/** One dedicated agent per category. A small handler object, not an autonomous loop. */
export interface CategoryAgent {
  category: InboxLabel;
  displayName: string;     // e.g. "Shipping & Returns" (console)
  description: string;     // one-line "grounds in ..." (console)
  commercial: boolean;     // carries a bounded commercial objective?
  ground(ctx: AgentContext): Promise<Grounding>;
  promptFragment(g: Grounding): string;            // category-specific instructions
  deterministicAppendix(g: Grounding): string | null; // verbatim trusted line, or null
}
