import type { TenantStore, TrafficChannelRow } from './tenant-store';

// Traffic strategy board (2026-07-05): the Traffic view's engine. The board is
// a persistent list of acquisition channels, each with a working state and ONE
// next action, so strategy sessions land somewhere durable instead of a chat
// scrollback. The starter set below is grounded in what the store actually has
// today (live campaigns + engagement tracking, a tracked partner funnel, a
// CJ-sourced catalog under a competition-aware margin policy) - it seeds once
// per shop on first read and is fully editable from then on.

export const TRAFFIC_STATUSES = ['idea', 'testing', 'active', 'paused'] as const;
export type TrafficStatus = (typeof TRAFFIC_STATUSES)[number];

export interface TrafficChannelInput {
  id?: string;
  name: string;
  status: TrafficStatus;
  priority: number; // 1 (now) .. 5 (someday)
  rationale: string;
  nextAction: string;
  notes: string;
}

/** Starter strategy: what this store can realistically work, in priority order. */
export const STARTER_CHANNELS: Omit<TrafficChannelInput, 'id'>[] = [
  {
    name: 'Google free product listings (Merchant Center)',
    status: 'idea', priority: 1,
    rationale: 'Free placement in the Google Shopping tab and image search for every product in the catalog. Pet supplies get heavy product-search volume and this costs nothing but feed setup.',
    nextAction: 'Install and connect the Google and YouTube sales channel in Shopify admin, verify the product feed syncs clean (titles, images, GTIN gaps).',
    notes: ''
  },
  {
    name: 'Email marketing (campaigns)',
    status: 'active', priority: 1,
    rationale: 'Fully built: consented buyers audience read live from Shopify, compliance footer, one-click unsubscribe, engagement tracking. Owned channel with zero acquisition cost per send.',
    nextAction: 'Send the first real buyers campaign (welcome event is live until 3 August, a natural hook), then read the delivered/opened/clicked numbers.',
    notes: ''
  },
  {
    name: 'Partner and affiliate program',
    status: 'testing', priority: 1,
    rationale: 'The tracked voucher trial is running: every applicant gets a performance test, orders attribute to their code, and the funnel screens itself. Partners bring their own audiences.',
    nextAction: 'Watch the first trial cohort (recall replies are landing this week); measure orders per issued code before widening outreach.',
    notes: ''
  },
  {
    name: 'Search engine optimisation (collections and products)',
    status: 'idea', priority: 2,
    rationale: 'The catalog already exists; titles, meta descriptions and collection copy are the cheapest compounding traffic asset. UK pet-niche long-tail terms are winnable for a small store.',
    nextAction: 'Audit the five home collections and top 20 products for missing or duplicated titles and meta descriptions; fix the worst offenders first.',
    notes: ''
  },
  {
    name: 'Short-video social (TikTok and Instagram Reels)',
    status: 'idea', priority: 2,
    rationale: 'Pet content is the most forgiving organic niche on short video; product-in-use clips need no budget and feed the same audience the affiliates reach.',
    nextAction: 'Pick three hero products with visual payoff and script the first batch of clips.',
    notes: ''
  },
  {
    name: 'Reorder and retention email',
    status: 'paused', priority: 3,
    rationale: 'Built and dormant behind a flag: reorder reminders for consumables with the shared unsubscribe list. Cheapest revenue in the stack once order volume exists to remind.',
    nextAction: 'Flip RETENTION_REORDER_ENABLED once weekly order volume makes reminder cohorts non-trivial.',
    notes: ''
  },
  {
    name: 'Paid ads (Google Shopping and Meta)',
    status: 'idea', priority: 4,
    rationale: 'Only viable where a product has street-parity margin under competition (the standing catalog policy). Burning spend before unit economics are proven is the classic dropship failure.',
    nextAction: 'Compute breakeven cost per acquisition for the three best-margin hero products; no spend until a product passes.',
    notes: ''
  }
];

export function validateTrafficPayload(body: unknown): { ok: true; value: TrafficChannelInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) return { ok: false, error: 'name required (up to 120 chars)' };
  const status = typeof b.status === 'string' && (TRAFFIC_STATUSES as readonly string[]).includes(b.status) ? (b.status as TrafficStatus) : null;
  if (!status) return { ok: false, error: 'status must be idea, testing, active or paused' };
  const priority = typeof b.priority === 'number' && b.priority >= 1 && b.priority <= 5 ? Math.round(b.priority) : NaN;
  if (!Number.isFinite(priority)) return { ok: false, error: 'priority must be 1 to 5' };
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    ok: true,
    value: {
      ...(typeof b.id === 'string' && b.id ? { id: b.id } : {}),
      name, status, priority,
      rationale: text(b.rationale, 600),
      nextAction: text(b.nextAction, 400),
      notes: text(b.notes, 1000)
    }
  };
}

/** List the board, seeding the starter strategy on a shop's first read. */
export async function listTrafficBoard(store: TenantStore): Promise<TrafficChannelRow[]> {
  let rows = await store.listTrafficChannels();
  if (rows.length === 0) {
    for (const c of STARTER_CHANNELS) await store.upsertTrafficChannel(c);
    rows = await store.listTrafficChannels();
  }
  return rows;
}

export function trafficChannelForUi(r: TrafficChannelRow) {
  return {
    id: r.id, name: r.name, status: r.status, priority: r.priority,
    rationale: r.rationale, nextAction: r.next_action, notes: r.notes,
    updatedAt: r.updated_at
  };
}
