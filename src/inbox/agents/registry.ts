// src/inbox/agents/registry.ts
import type { CategoryAgent } from './types';
import type { InboxLabel } from '../types';
import { shippingAgent } from './shipping';
import { productAgent } from './product';
import { affiliateAgent } from './affiliate';
import { leadAgent } from './lead';
import { wholesaleAgent } from './wholesale';
import { complaintAgent } from './complaint';
import { otherAgent } from './other';
import { orderStatusAgent } from './order-status'; // Phase 2; Phase 1 ships a hedging stub

export const AGENTS: Record<InboxLabel, CategoryAgent> = {
  'shipping-returns': shippingAgent,
  'order-status': orderStatusAgent,
  'product-question': productAgent,
  'affiliate': affiliateAgent,
  'lead': leadAgent,
  'wholesale-b2b': wholesaleAgent,
  'complaint': complaintAgent,
  'other': otherAgent,
  'spam': otherAgent,      // never dispatched (spam gets no reply); present for totality
  'automated': otherAgent  // never dispatched (closed); present for totality
};

export function agentFor(category: string | null): CategoryAgent {
  return (category && AGENTS[category as InboxLabel]) || AGENTS['other'];
}
