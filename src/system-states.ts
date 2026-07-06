import type { Env } from './types';
import { DEFAULT_LOGISTICS, DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_ADDONS, DEFAULT_SEMANTIC } from './types';
import type { TenantStore } from './tenant-store';
import { DEFAULT_INBOX, INBOX_LABELS } from './inbox/types';
import { resolveAgents } from './inbox/agents/config';
import { getTrackingStatus } from './resend-events';
import { SENDING_DOMAIN } from './email';
import { JOB_STAMP_DAILY, JOB_STAMP_PIPELINE, JOB_STAMP_MARKETS } from './jobs';
import { defaultFetch } from './safe-fetch';

/**
 * System states register (2026-07-06, owner request after the stale
 * "Turn on tracking" nagging): ONE live table of every switch and enforcement
 * setting in the system, so "is this toggle on?" has a single quick answer.
 *
 * Design rule: this register READS, it never stores. Every value is resolved
 * at request time from the exact store the enforcing code reads (tenant_config
 * columns, credential vault presence, event tables, job stamps, live Resend
 * probe). A materialised copy would go stale the moment the owner acted - the
 * precise failure this register exists to end. docs/STATES.md carries the
 * same map as a quick reference for direct D1 checks; a test pins the two
 * together so a state cannot be added without documenting where it lives.
 */

export interface SystemState {
  key: string;            // stable slug, e.g. 'inbox.autosend'
  label: string;          // owner-readable name
  value: string;          // rendered current value ('On', 'Manual (HITL)', '80', ...)
  on: boolean | null;     // chip colour: true=active, false=off/missing, null=informational
  detail?: string;        // context ('effective only with the master on', last-event time, ...)
  source: string;         // the authoritative store this value was read from
}

export interface SystemStatesReport {
  ok: true;
  checkedAt: string;
  groups: { title: string; states: SystemState[] }[];
}

const onOff = (b: boolean) => (b ? 'On' : 'Off');

function marketsStampSummary(raw: string | null): { value: string; on: boolean | null; detail?: string } {
  if (!raw) return { value: 'never', on: false };
  try {
    const j = JSON.parse(raw) as { at?: string };
    if (j.at) return { value: j.at, on: null, detail: raw.length > 140 ? raw.slice(0, 140) + '…' : raw };
  } catch { /* plain-string stamp */ }
  return { value: raw.length > 40 ? 'recorded' : raw, on: null, detail: raw.length > 140 ? raw.slice(0, 140) + '…' : raw };
}

export async function collectSystemStates(
  env: Env, store: TenantStore, fetchImpl: typeof fetch = defaultFetch
): Promise<SystemStatesReport | { ok: false; error: string }> {
  const cfg = await store.getConfig();
  if (!cfg) return { ok: false, error: 'Tenant not found' };
  const inbox = { ...DEFAULT_INBOX, ...cfg.inbox };
  const agents = resolveAgents(inbox);
  const fulfil = cfg.fulfil ?? { mode: 'manual' as const };
  const logistics = { ...DEFAULT_LOGISTICS, ...(fulfil.logistics ?? {}) };
  const gates = { ...DEFAULT_GATES, ...cfg.gates };
  const pricing = { ...DEFAULT_PRICING, ...cfg.pricing };
  const addons = { ...DEFAULT_ADDONS, ...cfg.addons };
  const semantic = { ...DEFAULT_SEMANTIC, ...(cfg.semantic ?? {}) };

  const tenant = await store.getTenant();
  const cjCred = await store.getSupplierCredential('cj');
  const webhookCred = await store.getSupplierCredential('resend-webhook');
  const pulse = await store.emailEventPulse();
  const suppressed = await store.countUnsubscribes();
  const consentingPartners = (await store.listConsentingPartnerEmails()).length;
  const dailyStamp = await store.getSearchCache(JOB_STAMP_DAILY);
  const pipelineStamp = await store.getSearchCache(JOB_STAMP_PIPELINE);
  const marketsStamp = marketsStampSummary(await store.getSearchCache(JOB_STAMP_MARKETS));

  // Email tracking: the ground truth is evidence, in two layers. The Resend
  // domain flags (live probe) say tracking WILL be measured; the sealed webhook
  // secret + stored events say the reporting pipeline HAS worked end-to-end.
  let trackingValue = 'Unknown';
  let trackingOn: boolean | null = null;
  const trackingBits: string[] = [];
  if (env.RESEND_API_KEY) {
    const probe = await getTrackingStatus(env.RESEND_API_KEY, SENDING_DOMAIN, fetchImpl);
    if (probe.ok) {
      const flagged = probe.status.openTracking && probe.status.clickTracking;
      trackingBits.push(`domain open/click: ${flagged ? 'on' : 'off'}`);
      trackingOn = flagged && !!webhookCred;
      trackingValue = trackingOn ? 'On' : 'Off';
    } else trackingBits.push(`domain probe failed: ${probe.error}`);
  } else trackingBits.push('RESEND_API_KEY not set: domain flags not probed');
  if (trackingOn === null && webhookCred && pulse.total > 0) { trackingValue = 'On (events flowing)'; trackingOn = true; }
  trackingBits.push(webhookCred ? 'webhook secret sealed' : 'webhook secret NOT stored');
  trackingBits.push(pulse.total > 0 ? `${pulse.total} events, latest ${pulse.latestAt}` : 'no events stored yet');

  const groups: SystemStatesReport['groups'] = [
    {
      title: 'Reply automation',
      states: [
        { key: 'inbox.enabled', label: 'Inbox processing', value: onOff(inbox.enabled), on: inbox.enabled, source: 'tenant_config.inbox.enabled' },
        { key: 'inbox.autosend', label: 'Reply mode master', value: inbox.autosend ? 'Automatic' : 'Manual (HITL)', on: inbox.autosend, detail: 'nothing sends alone unless this AND the lane switch are on', source: 'tenant_config.inbox.autosend' },
        ...INBOX_LABELS.map((l) => ({
          key: `inbox.agents.${l}.autosend`, label: `Auto-send: ${l}`, value: onOff(agents[l].autosend), on: agents[l].autosend,
          detail: 'effective only with the master on', source: `tenant_config.inbox.agents.${l}.autosend`
        })),
        { key: 'inbox.autoConfidenceThreshold', label: 'Auto-send confidence floor', value: String(inbox.autoConfidenceThreshold), on: null, source: 'tenant_config.inbox.autoConfidenceThreshold' },
        { key: 'inbox.intentThreshold', label: 'Hot-lead alert floor', value: String(inbox.intentThreshold), on: null, source: 'tenant_config.inbox.intentThreshold' },
        { key: 'inbox.alertEmail', label: 'Owner alert address', value: inbox.alertEmail || fulfil.alertEmail || 'not set', on: !!(inbox.alertEmail || fulfil.alertEmail), detail: 'inbox value, falling back to the fulfilment one', source: 'tenant_config.inbox.alertEmail / fulfil.alertEmail' }
      ]
    },
    {
      title: 'Invoicing',
      states: [
        { key: 'inbox.autoInvoice', label: 'Auto-invoice', value: onOff(inbox.autoInvoice), on: inbox.autoInvoice, source: 'tenant_config.inbox.autoInvoice' },
        { key: 'inbox.invoiceConfidenceThreshold', label: 'Auto-invoice confidence floor', value: String(inbox.invoiceConfidenceThreshold), on: null, source: 'tenant_config.inbox.invoiceConfidenceThreshold' },
        { key: 'inbox.invoiceValueCeiling', label: 'Auto-invoice value ceiling (GBP)', value: String(inbox.invoiceValueCeiling), on: null, source: 'tenant_config.inbox.invoiceValueCeiling' },
        { key: 'inbox.invoiceRateLimit', label: 'Invoices per contact per day', value: String(inbox.invoiceRateLimit), on: null, source: 'tenant_config.inbox.invoiceRateLimit' }
      ]
    },
    {
      title: 'Partnerships',
      states: [
        { key: 'inbox.affiliateMode', label: 'Partnership approaches', value: inbox.affiliateMode, on: null, detail: 'funnel_voucher = screen for a code trial; decline_all = the old policy', source: 'tenant_config.inbox.affiliateMode' },
        { key: 'inbox.autoIssueVoucher', label: 'Auto-issue voucher trials', value: onOff(inbox.autoIssueVoucher === true), on: inbox.autoIssueVoucher === true, detail: 'also requires the reply-mode master', source: 'tenant_config.inbox.autoIssueVoucher' },
        { key: 'partners.consenting', label: 'Partners opted in to updates', value: String(consentingPartners), on: null, detail: 'the Campaigns partner audience', source: 'affiliate_partners.marketing_consent = 1' }
      ]
    },
    {
      title: 'Marketing email',
      states: [
        { key: 'inbox.postalAddress', label: 'Business postal address', value: inbox.postalAddress ? 'Set' : 'MISSING', on: !!inbox.postalAddress, detail: inbox.postalAddress ? inbox.postalAddress : 'campaigns refuse to send without it', source: 'tenant_config.inbox.postalAddress' },
        { key: 'email.tracking', label: 'Email engagement tracking', value: trackingValue, on: trackingOn, detail: trackingBits.join('; '), source: 'Resend domain flags + supplier_credentials resend-webhook + email_events' },
        { key: 'email.suppressed', label: 'Suppression list size', value: String(suppressed), on: null, detail: 'unsubscribes, spam complaints, permanent bounces', source: 'email_unsubscribes' }
      ]
    },
    {
      title: 'Fulfilment and shipping',
      states: [
        { key: 'fulfil.mode', label: 'Fulfilment mode', value: fulfil.mode, on: null, detail: 'manual = queue only; pawscout = create+pay+track; cj = CJ app owns it', source: 'tenant_config.fulfil.mode' },
        { key: 'fulfil.createOnly', label: 'Create-only (no auto-pay)', value: onOff(fulfil.createOnly === true), on: fulfil.createOnly === true, source: 'tenant_config.fulfil.createOnly' },
        { key: 'fulfil.gbFreeUkLive', label: 'Free-UK-delivery claim live', value: onOff(fulfil.gbFreeUkLive === true), on: fulfil.gbFreeUkLive === true, detail: 'shipping agent may state free UK delivery for GB stock only when on', source: 'tenant_config.fulfil.gbFreeUkLive' },
        { key: 'fulfil.logistics', label: 'Delivery-time envelope (days)', value: `processing ${logistics.processingDaysMin}-${logistics.processingDaysMax}, customs ${logistics.customsDaysMax}, slack ${logistics.transitSlackDays}`, on: null, detail: `matrix staleness hedge ${logistics.stalenessHours}h`, source: 'tenant_config.fulfil.logistics' },
        { key: 'fulfil.shipCost', label: 'Freight conversion', value: `fx ${fulfil.shipFx ?? 0.82}, handling GBP ${fulfil.shipHandlingGbp ?? 0}`, on: null, source: 'tenant_config.fulfil.shipFx / shipHandlingGbp' },
        { key: 'fulfil.servedCountries', label: 'Served destinations', value: fulfil.servedCountries?.length ? `${fulfil.servedCountries.length} configured` : 'default set', on: null, detail: fulfil.servedCountries?.join(', '), source: 'tenant_config.fulfil.servedCountries' }
      ]
    },
    {
      title: 'Catalog gates and pricing',
      states: [
        { key: 'llm.enabled', label: 'AI curation', value: onOff(cfg.llm.enabled), on: cfg.llm.enabled, detail: `relevance floor ${cfg.llm.scoreThreshold}`, source: 'tenant_config.llm' },
        { key: 'gates', label: 'Import gates', value: `popularity ${gates.popularityFloor}, price $${gates.priceMin}-$${gates.priceMax}, ${gates.relevance}`, on: null, source: 'tenant_config.gates' },
        { key: 'pricing', label: 'Pricing chain', value: `${pricing.multiplier}x, floor ${pricing.floor}x, min margin GBP ${pricing.minMarginGbp}` + (pricing.maxMarginGbp != null ? `, cap GBP ${pricing.maxMarginGbp}` : ''), on: null, detail: `fx ${pricing.fxUsdToGbp} +${pricing.fxBufferPct}% buffer`, source: 'tenant_config.pricing' },
        { key: 'addons.enabled', label: 'Add-on lane', value: onOff(addons.enabled), on: addons.enabled, detail: `$${addons.priceMinUsd}-$${addons.priceMaxUsd}, pool ${addons.poolSize}, ${addons.suppressFromBrowse ? 'hidden from browse' : 'visible'}`, source: 'tenant_config.addons' },
        { key: 'semantic.enabled', label: 'Semantic term library', value: onOff(semantic.enabled), on: semantic.enabled, detail: `max ${semantic.maxExpansions} expansions, ttl ${semantic.ttlDays}d`, source: 'tenant_config.semantic' },
        { key: 'target', label: 'Per-collection target', value: String(cfg.target), on: null, source: 'tenant_config.target' }
      ]
    },
    {
      title: 'Connections',
      states: [
        { key: 'conn.shopify', label: 'Shopify', value: tenant ? 'Connected' : 'NOT CONNECTED', on: !!tenant, detail: tenant?.scopes ?? undefined, source: 'tenants row + scopes' },
        { key: 'conn.cj', label: 'CJ supplier key', value: cjCred ? 'Stored' : 'Not stored', on: !!cjCred, source: "supplier_credentials supplier='cj'" },
        { key: 'conn.resend', label: 'Resend API key', value: env.RESEND_API_KEY ? 'Present' : 'MISSING', on: !!env.RESEND_API_KEY, detail: 'worker secret; email cannot send without it', source: 'worker secret RESEND_API_KEY' },
        { key: 'conn.openrouter', label: 'LLM API key', value: env.OPENROUTER_API_KEY ? 'Present' : 'MISSING', on: !!env.OPENROUTER_API_KEY, detail: 'worker secret; drafting and curation need it', source: 'worker secret OPENROUTER_API_KEY' }
      ]
    },
    {
      title: 'Background jobs',
      states: [
        { key: 'job.daily', label: 'Nightly maintenance last completed', value: dailyStamp ?? 'never', on: dailyStamp ? null : false, source: `search_cache '${JOB_STAMP_DAILY}'` },
        { key: 'job.pipeline', label: 'Order pipeline last ran', value: pipelineStamp ?? 'never', on: pipelineStamp ? null : false, detail: 'runs every 15 minutes', source: `search_cache '${JOB_STAMP_PIPELINE}'` },
        { key: 'job.markets', label: 'Market exclusions last ran', value: marketsStamp.value, on: marketsStamp.on, detail: marketsStamp.detail, source: `search_cache '${JOB_STAMP_MARKETS}'` }
      ]
    }
  ];

  return { ok: true, checkedAt: new Date().toISOString(), groups };
}
