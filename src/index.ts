import { Hono } from 'hono';
import type { Context } from 'hono';
import { RequestedTokenType } from '@shopify/shopify-api';
import type { Env, TenantConfig, TenantRow } from './types';
import { makeShopify } from './shopify';
import { Vault } from './vault';
import { TenantStore, listActiveShops } from './tenant-store';
import { getModelCatalog, type CatalogModel } from './models-catalog';
import { processInbound } from './inbox/ingest';
import { runInboxClassifySweep } from './inbox/sweep';
import { beginAuth } from './auth/install';
import { handleCallback } from './auth/callback';
import { ensureInstalled } from './auth/ensure-installed';
import { handleUninstall } from './auth/uninstall';
import { resolveShopFromToken } from './console/session';
import { connectCj, saveGates, savePricing, saveLlm, saveAddons, saveCollectionMap, getStatus, getInsights, getGlance, getAudit, getAuditConversation, saveGbFreeUk, getPartners, createPartner, partnerVoucherAction, getPartnerOrders } from './console/routes';
import { listInboxThreads, getInboxThread, setInboxStatus, setInboxLabels, getInboxConfig, saveInboxConfig, approveDraft, regenerateDraft } from './inbox/routes';
import { buildInvoiceForThread, discardInvoice, searchCatalog, adminForShop } from './inbox/invoice-routes';
import { validateCampaignPayload, resolveCampaignAudience, sendCampaignBatch, sendCampaignTest, campaignForUi, ownerTestAddress, type CampaignAudience } from './campaigns';
import { issueVoucher, fetchActiveOrderPromos, voucherDateLabel } from './affiliate-discounts';
import { buildVoucherInviteWithCode } from './inbox/partnership';
import { renderReplyHtml } from './inbox/draft';
import { consolePage } from './console/page';
import { validateCjKey, CjClient, CjTokenManager, cjFetchFromEnv, chooseOrigin } from './cj';
import { registerWebhooks, type RegisterWebhook } from './webhooks';
import { validateGatesPayload, validatePricingPayload, validateLlmPayload, validateAddonsPayload, validateCollectionMap, validatePartnerPayload } from './validate';
import { sendEmail } from './email';
import { verifyAppProxy } from './proxy/verify';
import { verifyUnsubToken } from './retention';
import { searchBackfill, normalizeKeyword } from './proxy/search';
import { LlmClient, classifyKeyword, curateProduct, pickHeroImage, rewriteDescription } from './llm';
import { buildPreview, getDetailPreferWarehouse, curateDetailImages, confirmAndImport, reconcileAddonVisibility, reconcileHeroImages, reconcileDescriptions, reconcileCategories } from './proxy/import';
import { makeAdminGraphql } from './shopify-admin';
import { readDeliveryConfig, syncSignatureProfiles } from './shipping/delivery-profile';
import { resolveShipConfig } from './shipping/ship-config';
import { resolveLogistics } from './logistics';
import { runDailyMaintenance, resumeDailyMaintenance, runMarketVisibilityReconcile, syncStoreInventory, refillCollections } from './jobs';
import { runOrderPipeline, runOrderPipelineForShop } from './fulfil-run';
import { parseOrderWebhook, validateOrder, FULFIL_GRACE_MINUTES } from './fulfil';
import { attributePaidOrder } from './inbox/attribution';
import { firecrawlCjSearch } from './firecrawl';

export const app = new Hono<{ Bindings: Env }>();

function makeRegistrar(env: Env): RegisterWebhook {
  return (shop, accessToken) => registerWebhooks(shop, accessToken, env.SHOPIFY_APP_URL);
}

app.get('/auth', (c) => beginAuth(makeShopify(c.env), c.req.raw));

app.get('/auth/callback', async (c) => {
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return handleCallback(makeShopify(c.env), c.env.DB, vault, c.req.raw, makeRegistrar(c.env));
});

app.get('/app', (c) => consolePage(c.env.SHOPIFY_API_KEY));

// Public one-click unsubscribe for ALL marketing email (reorder reminders and
// campaigns share one suppression list - opting out once covers both). The
// token is an HMAC over (shop, email) - unforgeable without SHOPIFY_API_SECRET.
// Handles GET (link click) and POST (RFC 8058 List-Unsubscribe-Post one-click).
const handleUnsubscribe = async (c: Context<{ Bindings: Env }>) => {
  const url = new URL(c.req.url);
  const shop = url.searchParams.get('shop') ?? '';
  const email = (url.searchParams.get('email') ?? '').toLowerCase();
  const token = url.searchParams.get('token') ?? '';
  if (!(await verifyUnsubToken(shop, email, token, c.env.SHOPIFY_API_SECRET))) {
    return c.html('<p>This unsubscribe link is invalid.</p>', 400);
  }
  await new TenantStore(c.env.DB, shop).recordUnsubscribe(email, new Date().toISOString());
  return c.html('<p>You have been unsubscribed from Active Paw marketing emails (reminders, news and offers). Sorry to see you go! Emails about orders you place are not affected.</p>');
};
app.get('/unsubscribe', handleUnsubscribe);
app.post('/unsubscribe', handleUnsubscribe);

// --- /api/* : session-token authed (embedded console) ---
// Resolves the shop from the App Bridge session token and, on a managed install,
// lazily mints + persists an offline access token via token exchange (first call only).
// Defense-in-depth for the image (vision) model setting: reject only a slug the
// catalog positively marks text-only. Unknown/unset → allow (the UI already
// constrains the picker to vision models; the catalog may have gaps).
export function visionModelRejected(slug: string | undefined, catalog: CatalogModel[]): boolean {
  if (!slug) return false;
  const m = catalog.find((cm) => cm.slug === slug);
  return m ? m.vision === false : false;
}

async function shopOf(c: Context<{ Bindings: Env }>): Promise<string | Response> {
  const shopify = makeShopify(c.env);
  const authHeader = c.req.header('Authorization') ?? null;
  const r = await resolveShopFromToken(authHeader, c.env.SHOPIFY_API_KEY, (t) => shopify.session.decodeSessionToken(t));
  if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 401);

  const sessionToken = authHeader!.slice('Bearer '.length); // authHeader is non-null once resolve succeeds
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  try {
    await ensureInstalled(c.env.DB, vault, r.shop, sessionToken, async (shop, token) => {
      const { session } = await shopify.auth.tokenExchange({
        shop,
        sessionToken: token,
        requestedTokenType: RequestedTokenType.OfflineAccessToken
      });
      return { accessToken: session.accessToken ?? '', scope: session.scope ?? '' };
    }, makeRegistrar(c.env));
  } catch {
    // Never surface token-exchange internals (which can echo the grant) to the browser.
    return c.json({ ok: false, error: 'Install handshake failed' }, 401);
  }
  return r.shop;
}

app.post('/api/status', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; return c.json(await getStatus(c.env.DB, s)); });
app.post('/api/insights', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; return c.json(await getInsights(c.env.DB, s)); });
// Glance (Phase 3): the landing view's aggregate - counts, attention queue,
// activity and cron-health stamps in one call. Read-only.
app.post('/api/glance', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; return c.json(await getGlance(c.env.DB, s)); });
// Audit (2026-07-04): read-only contact roll-up + per-contact conversation.
app.post('/api/audit', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { category?: string; before?: string } = {};
  try { body = await c.req.json(); } catch {}
  return c.json(await getAudit(c.env.DB, s, { category: body.category, before: body.before }));
});
app.post('/api/audit/conversation', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { email?: string } = {};
  try { body = await c.req.json(); } catch {}
  return c.json(await getAuditConversation(c.env.DB, s, body.email));
});
// Partners (2026-07-04): affiliate voucher trials - register a collaborator's
// code, watch its attributed sales/commission, revoke it, stamp payouts.
app.post('/api/partners', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; return c.json(await getPartners(c.env.DB, s)); });
app.post('/api/partners/create', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validatePartnerPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  return c.json(await createPartner(c.env.DB, s, v.value));
});
app.post('/api/partners/voucher', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { voucherId?: string; action?: string } = {};
  try { body = await c.req.json(); } catch {}
  return c.json(await partnerVoucherAction(c.env.DB, s, body.voucherId, body.action));
});
app.post('/api/partners/orders', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { voucherId?: string } = {};
  try { body = await c.req.json(); } catch {}
  return c.json(await getPartnerOrders(c.env.DB, s, body.voucherId));
});
// One-click voucher issue (2026-07-05, performance-test policy): conflict-aware
// window (never launches into a running storewide event) -> Shopify code ->
// ledger row -> if the email has an applicant thread, the code invite is staged
// there as a pending draft for the owner to approve (HITL send).
app.post('/api/partners/issue', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { email?: unknown; name?: unknown; pctOff?: unknown; commissionPct?: unknown; trialDays?: unknown; usageLimit?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const email = typeof body.email === 'string' && body.email.includes('@') ? body.email.trim().toLowerCase() : '';
  if (!email) return c.json({ ok: false, error: 'email required' }, 400);
  const pctOff = typeof body.pctOff === 'number' && body.pctOff >= 1 && body.pctOff <= 50 ? body.pctOff : NaN;
  const commissionPct = typeof body.commissionPct === 'number' && body.commissionPct >= 0 && body.commissionPct <= 20 ? body.commissionPct : NaN;
  if (!Number.isFinite(pctOff) || !Number.isFinite(commissionPct)) return c.json({ ok: false, error: 'pctOff must be 1-50 and commissionPct 0-20' }, 400);
  const trialDays = typeof body.trialDays === 'number' && body.trialDays >= 7 && body.trialDays <= 90 ? Math.round(body.trialDays) : undefined;
  const usageLimit = typeof body.usageLimit === 'number' && body.usageLimit >= 1 && body.usageLimit <= 1000 ? Math.round(body.usageLimit) : undefined;
  const store = new TenantStore(c.env.DB, s);
  const admin = await adminForShop(c.env, store);
  if (!admin) return c.json({ ok: false, error: 'Shopify connection unavailable' });
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const r = await issueVoucher(store, admin, { email, name, pctOff, commissionPct, trialDays, usageLimit });
  if (!r.ok) return c.json(r);
  let invitedThreadId: string | null = null;
  const appl = await store.getApplicantByEmail(email);
  if (appl) {
    const bodyText = buildVoucherInviteWithCode(name, {
      code: r.code, pctOff: r.pctOff, commissionPct: r.commissionPct,
      startsAtLabel: voucherDateLabel(r.startsAt), endsAtLabel: voucherDateLabel(r.endsAt),
      deferred: r.deferredBehind !== null
    });
    await store.supersedePendingDrafts(appl.thread_id);
    await store.insertDraft({
      threadId: appl.thread_id, bodyText, bodyHtml: renderReplyHtml(bodyText),
      confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'partnership-screen', status: 'pending'
    });
    await store.setThreadStatus(appl.thread_id, 'needs_reply');
    await store.setApplicantStage(appl.thread_id, 'passed_to_form', null);
    invitedThreadId = appl.thread_id;
  }
  return c.json({ ...r, invitedThreadId });
});
// Promo/scope probe for the Partners view: lists running + scheduled storewide
// promotions (what voucher timing schedules around) and doubles as the
// write_discounts grant check.
app.post('/api/partners/discount-status', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const admin = await adminForShop(c.env, store);
  if (!admin) return c.json({ ok: true, scope: false, promos: [], note: 'Shopify connection unavailable' });
  const r = await fetchActiveOrderPromos(admin);
  if (!r.ok) return c.json({ ok: true, scope: false, promos: [], note: r.reconnectRequired ? 'reconnect_required' : r.error });
  return c.json({ ok: true, scope: true, promos: r.promos });
});
// Marketing opt-in for one partner (owner flips it when the partner says yes -
// partnership correspondence alone never puts anyone on the campaign list).
app.post('/api/partners/consent', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { partnerId?: unknown; on?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  if (typeof body.partnerId !== 'string' || !body.partnerId) return c.json({ ok: false, error: 'partnerId required' }, 400);
  const changed = await new TenantStore(c.env.DB, s).setPartnerMarketingConsent(body.partnerId, body.on === true);
  return c.json(changed ? { ok: true } : { ok: false, error: 'Partner not found' });
});

// --- Campaigns (2026-07-05): owner-composed marketing broadcasts. HITL only -
// nothing here runs from a cron; every send is an owner click. Consent gates
// live in the engine (src/campaigns.ts): buyers = Shopify SUBSCRIBED at send
// time, partners = explicit opt-in, suppression list + send ledger per email.
app.post('/api/campaigns', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  return c.json({
    ok: true,
    campaigns: (await store.listCampaigns()).map(campaignForUi),
    postalAddress: cfg?.inbox.postalAddress ?? '',
    testAddress: cfg ? ownerTestAddress(cfg) : null
  });
});
app.post('/api/campaigns/create', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateCampaignPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  const id = await new TenantStore(c.env.DB, s).insertCampaign(v.value);
  return c.json({ ok: true, id });
});
app.post('/api/campaigns/discard', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  if (typeof body.id !== 'string' || !body.id) return c.json({ ok: false, error: 'id required' }, 400);
  const gone = await new TenantStore(c.env.DB, s).discardCampaign(body.id);
  return c.json(gone ? { ok: true } : { ok: false, error: 'Only unsent drafts can be discarded' });
});
// Live audience sizes so the owner sees who a campaign would reach BEFORE
// sending. Buyer consent is read from Shopify at this moment, never cached.
app.post('/api/campaigns/audiences', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const partners = (await store.listConsentingPartnerEmails()).length;
  let buyers: number | null = null;
  let buyersError: string | undefined;
  try {
    const admin = await adminForShop(c.env, store);
    const aud = await resolveCampaignAudience(store, admin, 'buyers');
    if (aud.ok) buyers = aud.emails.length; else buyersError = aud.error;
  } catch (e) { buyersError = (e as Error).message; }
  return c.json({ ok: true, buyers, partners, ...(buyersError ? { buyersError } : {}) });
});
app.post('/api/campaigns/test', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: unknown; to?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  if (typeof body.id !== 'string' || !body.id) return c.json({ ok: false, error: 'id required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Config unavailable' }, 400);
  const to = typeof body.to === 'string' && body.to.includes('@') ? body.to.trim() : ownerTestAddress(cfg);
  if (!to) return c.json({ ok: false, error: 'Provide a test recipient (or set an alert email in Settings)' });
  const campaign = await store.getCampaign(body.id);
  if (!campaign) return c.json({ ok: false, error: 'Campaign not found' });
  const r = await sendCampaignTest(c.env, store, campaign, to, cfg.inbox.postalAddress ?? '');
  return c.json(r.ok ? { ok: true, to } : r);
});
app.post('/api/campaigns/send', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  if (typeof body.id !== 'string' || !body.id) return c.json({ ok: false, error: 'id required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Config unavailable' }, 400);
  const postal = (cfg.inbox.postalAddress ?? '').trim();
  if (!postal) return c.json({ ok: false, error: 'Add your business postal address under Sender details first - marketing email must carry it' });
  const campaign = await store.getCampaign(body.id);
  if (!campaign) return c.json({ ok: false, error: 'Campaign not found' });
  if (campaign.status === 'sent') return c.json({ ok: false, error: 'This campaign has already been sent' });
  const admin = campaign.audience === 'buyers' ? await adminForShop(c.env, store) : null;
  const aud = await resolveCampaignAudience(store, admin, campaign.audience as CampaignAudience);
  if (!aud.ok) return c.json({ ok: false, error: aud.error });
  if (!aud.emails.length) return c.json({ ok: false, error: 'No eligible recipients in this audience yet' });
  return c.json(await sendCampaignBatch(c.env, store, campaign, aud.emails, postal));
});
app.post('/api/gb-free-uk', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { on?: boolean } = {};
  try { body = await c.req.json(); } catch {}
  await saveGbFreeUk(c.env.DB, s, body.on === true);
  return c.json({ ok: true });
});
// On-demand GB Local profile create/reconcile (the daily cron also runs this). Reports the
// live zone-isolation check + the sync result so the owner can verify before relying on it.
app.post('/api/gb-sync', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  if (!tenant?.access_token_enc) return c.json({ ok: false, error: 'reconnect_required' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(s, accessToken);
  try {
    const cfg = await readDeliveryConfig(admin);
    const allZones = cfg.locationGroups.flatMap((g) => g.zones);
    const gbZones = allZones.filter((z) => z.countryCodes.includes('GB'));
    const gbIsolated = gbZones.length > 0 && gbZones.every((z) => z.countryCodes.length === 1 && z.countryCodes[0] === 'GB');
    const tcfg = await store.getConfig();
    const sc = resolveShipConfig(tcfg?.fulfil);
    const l = resolveLogistics(tcfg?.fulfil);
    const result = await syncSignatureProfiles(admin, store, { servedCountries: sc.servedCountries, fx: sc.fx, handlingGbp: sc.handlingGbp, stalenessHours: l.stalenessHours });
    return c.json({ ok: true, gbIsolated, gbZones: gbZones.map((z) => ({ name: z.name, countries: z.countryCodes })), zoneNames: allZones.map((z) => z.name), defaultProfileId: cfg.defaultProfileId, result });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
app.post('/api/connect-cj', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const { apiKey } = await c.req.json<{ apiKey: string }>();
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return c.json(await connectCj(c.env.DB, vault, s, apiKey, (k) => validateCjKey(k, cjFetchFromEnv(c.env))));
});
app.post('/api/gates', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateGatesPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  await saveGates(c.env.DB, s, v.value.gates, v.value.target);
  return c.json({ ok: true });
});
app.post('/api/pricing', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validatePricingPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  await savePricing(c.env.DB, s, v.value);
  return c.json({ ok: true });
});
app.post('/api/llm', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateLlmPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  const store = new TenantStore(c.env.DB, s);
  const catalog = await getModelCatalog(store);
  const inCatalog = (slug?: string) => !slug || catalog.some((m) => m.slug === slug);
  const { image, text, fallback } = v.value.models;
  for (const [label, slug] of [['image', image], ['text', text], ['fallback', fallback]] as const) {
    if (slug && !inCatalog(slug)) return c.json({ ok: false, error: `${label} model is not in the catalog` }, 400);
  }
  if (visionModelRejected(image, catalog) || visionModelRejected(fallback, catalog)) {
    return c.json({ ok: false, error: 'Image and Fallback must be vision-capable models' }, 400);
  }
  await saveLlm(c.env.DB, s, v.value);
  return c.json({ ok: true });
});
app.get('/api/models', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  return c.json({ ok: true, models: await getModelCatalog(store) });
});
// W-FULFIL Stage B: set the fulfilment mode (manual | pawscout | cj).
// 'pawscout' is the money leg - only choose it once the CJ wallet is funded
// AND CJ's native order-import is off (else duplicate CJ orders).
app.post('/api/fulfil', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { mode?: unknown; createOnly?: unknown; alertEmail?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const mode = body.mode;
  if (mode !== 'manual' && mode !== 'pawscout' && mode !== 'cj') return c.json({ ok: false, error: 'Bad mode' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  // createOnly / alertEmail: omitted → keep the current value; present → set it.
  const createOnly = body.createOnly === undefined ? (cfg.fulfil.createOnly === true) : body.createOnly === true;
  let alertEmail = cfg.fulfil.alertEmail;
  if (body.alertEmail !== undefined) {
    const v = typeof body.alertEmail === 'string' ? body.alertEmail.trim() : '';
    if (v && !v.includes('@')) return c.json({ ok: false, error: 'Invalid alert email' }, 400);
    alertEmail = v || undefined;
  }
  await store.saveFulfil({ mode, createOnly, ...(alertEmail ? { alertEmail } : {}) });
  return c.json({ ok: true, mode, createOnly, alertEmail: alertEmail ?? '' });
});
// Resend connectivity test: sends a one-off email using the RESEND_API_KEY
// secret, from inside the Worker (the secret is never exposed outside). Proves
// the key + send path before the awaiting-payment owner alert (W5) is wired in.
app.post('/api/test-email', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  if (!c.env.RESEND_API_KEY) return c.json({ ok: false, error: 'RESEND_API_KEY secret not set on the Worker' }, 200);
  let body: { to?: unknown } = {};
  try { body = await c.req.json(); } catch { /* default recipient */ }
  const to = typeof body.to === 'string' && body.to.includes('@') ? body.to : '';
  if (!to) return c.json({ ok: false, error: 'Provide a recipient email' }, 200);
  const r = await sendEmail(c.env.RESEND_API_KEY, {
    to,
    subject: 'Active Paw - PawScout test email',
    text: `This is a test email from PawScout for ${s}. If you received it, Resend is wired up correctly.`,
    html: `<p>This is a test email from <strong>PawScout</strong> for ${s}.</p><p>If you received it, Resend is wired up correctly - owner alerts (e.g. "order awaiting payment in CJ") can now go to your inbox.</p>`
  });
  return c.json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error }, 200);
});
// On-demand order pipeline: same work as the every-15-min cron (create due CJ
// orders + poll tracking), runnable from the console so the owner can force a
// fulfilment run without waiting for the next tick.
app.post('/api/fulfil-run', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  try {
    const r = await runOrderPipelineForShop(c.env, vault, s);
    if (!r) return c.json({ ok: false, error: 'Not configured / CJ not connected' }, 200);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});
// Manual "Sync now": the nightly maintenance pieces, runnable on demand from
// the console. Batched - each call does a slice of the work and tells the
// caller where to resume, so no single request outlives proxy/browser limits.
const SYNC_BATCH = 8; // ~2 paced CJ calls/product ≈ 20s/batch
const REFILL_BATCH = 5;
app.post('/api/sync', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { phase?: string; offset?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  if (!(await store.getSupplierCredential('cj'))) return c.json({ ok: false, error: 'Connect CJ first' }, 400);

  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(s, accessToken);
  const f = cjFetchFromEnv(c.env);
  const tokens = new CjTokenManager(store, vault, f);
  const cj = new CjClient(() => tokens.getToken(), f);

  try {
    if (body.phase === 'refill') {
      const syncLlm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
      const curate = syncLlm.available && cfg.llm.enabled
        ? (d: Parameters<typeof curateProduct>[3], ctx: string) => curateProduct(syncLlm, store, cfg, d, ctx)
        : undefined;
      const pickHero = syncLlm.available && cfg.llm.enabled
        ? (title: string, urls: string[]) => pickHeroImage(syncLlm, store, cfg, title, urls)
        : undefined;
      const imported = await refillCollections(store, cj, admin, cfg, { maxImports: REFILL_BATCH, curate, pickHero });
      return c.json({ ok: true, phase: 'refill', imported, next: imported >= REFILL_BATCH ? 0 : null });
    }
    const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
    const total = (await store.listImportedLinks()).length;
    const errors: string[] = [];
    const synced = await syncStoreInventory(store, cj, admin, cfg, { maxProducts: SYNC_BATCH, offset, errors });
    const next = offset + SYNC_BATCH;
    // Surface a few per-product failures so the console isn't a black box.
    return c.json({ ok: true, phase: 'inventory', synced, total, errors: errors.slice(0, 3), next: next < total ? next : null });
  } catch (e) {
    console.warn(`manual sync failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: `Sync failed: ${(e as Error).message}` }, 500);
  }
});

app.post('/api/addons', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateAddonsPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  await saveAddons(c.env.DB, s, v.value);
  // Apply the visibility toggle to existing add-ons immediately (best-effort;
  // the config is already saved and the nightly cron also reconciles).
  try {
    const store = new TenantStore(c.env.DB, s);
    const tenant = await store.getTenant();
    const cfg = await store.getConfig();
    if (tenant?.access_token_enc && cfg) {
      const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      c.executionCtx.waitUntil(reconcileAddonVisibility(store, makeAdminGraphql(s, accessToken), cfg));
    }
  } catch (e) {
    console.warn(`addon reconcile (post-save) failed: ${(e as Error).message}`);
  }
  return c.json({ ok: true });
});
// Search diagnostic: compare our CJ listV2 results against CJ's own website
// search (scraped via Firecrawl, which renders from its servers and gets past
// CJ's bot protection). Stores both lists to D1 (diag:* keys) for offline
// comparison. Session-token authed.
app.post('/api/search-diag', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { q?: string } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const q = (body.q || 'dog toy').trim().slice(0, 60);
  const store = new TenantStore(c.env.DB, s);
  if (!(await store.getTenant())) return c.json({ ok: false, error: 'No tenant' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);

  let ours: { title: string; price: number }[] = [];
  try {
    ours = (await cj.search(q)).slice(0, 25).map((i) => ({ title: i.nameEn, price: i.sellPriceUsd }));
  } catch (e) { ours = [{ title: `ERROR: ${(e as Error).message}`, price: 0 }]; }

  let web: { title: string; price?: string }[] = [];
  if (c.env.FIRECRAWL_API_KEY) {
    try { web = (await firecrawlCjSearch(c.env.FIRECRAWL_API_KEY, q)).slice(0, 25); }
    catch (e) { web = [{ title: `ERROR: ${(e as Error).message}` }]; }
  } else {
    web = [{ title: 'FIRECRAWL_API_KEY not set' }];
  }

  await store.putSearchCache(`diag:ours:${q}`, JSON.stringify(ours), 1);
  await store.putSearchCache(`diag:web:${q}`, JSON.stringify(web), 1);
  return c.json({ ok: true, q, oursCount: ours.length, webCount: web.length, ours, web });
});

const SWEEP_BATCH = 6; // LLM/vision sweeps: small batch keeps each call inside the request budget
// Vision hero-image QA, on demand: re-pick the default image for already-listed
// products and promote the best representative shot (fixes "set" listings whose
// default image is a single component). One batch per call (offset cursor) so
// the console can loop with progress; returns counts + `next`.
app.post('/api/hero-images', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { offset?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const llm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
  if (!llm.available || !cfg.llm.enabled) return c.json({ ok: false, error: 'LLM not configured' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(s, accessToken);
  const pickHero = (title: string, urls: string[]) => pickHeroImage(llm, store, cfg, title, urls);
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  try {
    const r = await reconcileHeroImages(store, admin, cfg, pickHero, { offset, limit: SWEEP_BATCH });
    return c.json({ ok: true, ...r });
  } catch (e) {
    console.warn(`hero-image sweep failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: `Sweep failed: ${(e as Error).message}` }, 500);
  }
});
// Clean raw/legacy supplier descriptions on demand: rewrite any listing whose
// description still carries CJ copy (claims, supplier policy, hotlinked images)
// into clean, claim-safe HTML. One batch per call (offset cursor); LLM-gated.
app.post('/api/descriptions', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { offset?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const llm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
  if (!llm.available || !cfg.llm.enabled) return c.json({ ok: false, error: 'LLM not configured' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(s, accessToken);
  const rewrite = (title: string, raw: string) => rewriteDescription(llm, store, cfg, title, raw);
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  try {
    const r = await reconcileDescriptions(store, admin, cfg, rewrite, { offset, limit: SWEEP_BATCH });
    return c.json({ ok: true, ...r });
  } catch (e) {
    console.warn(`description sweep failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: `Sweep failed: ${(e as Error).message}` }, 500);
  }
});
// Category re-audit (LLM-free): re-file products whose title unambiguously
// points at a different collection. One batch per call (offset cursor).
app.post('/api/categories', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { offset?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(s, accessToken);
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  try {
    const r = await reconcileCategories(store, admin, cfg, { offset, limit: SWEEP_BATCH });
    return c.json({ ok: true, ...r });
  } catch (e) {
    console.warn(`category sweep failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: `Sweep failed: ${(e as Error).message}` }, 500);
  }
});
// W-FULFIL Stage A: the order queue (received / held / queued / submitted).
app.post('/api/orders', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  const orders = (await store.listOrders(null, 50)).map((o) => ({
    id: o.shopify_order_id, name: o.order_name, total: o.total_price, currency: o.currency,
    status: o.status, holds: o.hold_reasons ? JSON.parse(o.hold_reasons) : [], cj: o.cj_order_id, tracking: o.tracking_number
  }));
  return c.json({ ok: true, orders, mode: cfg?.fulfil.mode ?? 'manual', createOnly: cfg?.fulfil.createOnly === true, alertEmail: cfg?.fulfil.alertEmail ?? '' });
});
// Read-only CJ order-API check: lists recent CJ orders to verify the order
// endpoints + field names work, WITHOUT creating or paying anything.
app.post('/api/cj-order-diag', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  if (!(await store.getSupplierCredential('cj'))) return c.json({ ok: false, error: 'CJ not connected' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  try {
    const data = await cj.getOrderList(5);
    await store.putSearchCache('diag:cj-orders', JSON.stringify(data).slice(0, 4000), 1);
    return c.json({ ok: true, sample: data });
  } catch (e) {
    return c.json({ ok: false, error: `CJ order API: ${(e as Error).message}` }, 200);
  }
});
// Read-only freight quote: what CJ actually charges to ship ONE unit of a
// product to a destination country, cheapest line first. Resolves a
// representative variant + dispatch origin the same way the fulfilment pipeline
// would, so the number reflects a real order. Creates/pays nothing.
app.post('/api/freight-quote', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { pid?: unknown; country?: unknown; qty?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 200); }
  const pid = typeof body.pid === 'string' ? body.pid.trim() : '';
  const country = (typeof body.country === 'string' ? body.country.trim().toUpperCase() : 'GB') || 'GB';
  const qtyRaw = typeof body.qty === 'number' ? body.qty : Number(body.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.min(100, Math.max(1, Math.trunc(qtyRaw))) : 1;
  if (!PID_RE.test(pid)) return c.json({ ok: false, error: 'Enter a CJ product id (the cj-pid-… tag on the product)' }, 200);
  if (!/^[A-Z]{2}$/.test(country)) return c.json({ ok: false, error: 'Country must be a 2-letter code, e.g. ES, US, GB' }, 200);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Not configured' }, 200);
  if (!(await store.getSupplierCredential('cj'))) return c.json({ ok: false, error: 'CJ not connected' }, 200);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  try {
    const detail = await getDetailPreferWarehouse(store, cj, pid);
    if (!detail || !detail.variants.length) return c.json({ ok: false, error: 'Product not found at CJ' }, 200);
    const vid = detail.variants[0].vid;
    const origin = detail.origin ?? chooseOrigin(detail, cfg.floors.stockFloor);
    const options = await cj.freightQuote(vid, origin, country, qty);
    // GBP conversion mirrors the pricing rule's landed-cost FX (rate + buffer).
    const fx = cfg.pricing.fxUsdToGbp * (1 + cfg.pricing.fxBufferPct / 100);
    const out = options.slice(0, 8).map((o) => ({ name: o.name, days: o.days, usd: o.priceUsd, gbp: Math.round(o.priceUsd * fx * 100) / 100 }));
    return c.json({ ok: true, product: detail.nameEn, origin, country, qty, options: out });
  } catch (e) {
    return c.json({ ok: false, error: `CJ freight: ${(e as Error).message}` }, 200);
  }
});
// Operator override on a held/queued order (release to auto-fulfil, hold, cancel).
app.post('/api/order-action', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string; action?: string } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const map: Record<string, 'queued' | 'held' | 'cancelled'> = { release: 'queued', hold: 'held', cancel: 'cancelled' };
  const status = map[body.action ?? ''];
  if (!body.id || !status) return c.json({ ok: false, error: 'Bad request' }, 400);
  const store = new TenantStore(c.env.DB, s);
  if (!(await store.getOrder(body.id))) return c.json({ ok: false, error: 'Order not found' }, 404);
  await store.updateOrder(body.id, { status });
  return c.json({ ok: true, status });
});
app.post('/api/collections', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateCollectionMap(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  await saveCollectionMap(c.env.DB, s, v.value);
  return c.json({ ok: true });
});
app.post('/api/inbox/threads', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { status?: string } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  return c.json(await listInboxThreads(c.env.DB, s, body.status ?? null));
});
app.post('/api/inbox/thread', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.id) return c.json({ ok: false, error: 'id required' }, 400);
  return c.json(await getInboxThread(c.env.DB, s, body.id));
});
app.post('/api/inbox/status', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string; status?: string } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.id) return c.json({ ok: false, error: 'id required' }, 400);
  return c.json(await setInboxStatus(c.env.DB, s, body.id, body.status));
});
app.post('/api/inbox/labels', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string; labels?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.id) return c.json({ ok: false, error: 'id required' }, 400);
  return c.json(await setInboxLabels(c.env.DB, s, body.id, body.labels));
});
app.post('/api/inbox/config', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (body && Object.keys(body as object).length) return c.json(await saveInboxConfig(c.env.DB, s, body));
  return c.json({ ok: true, inbox: await getInboxConfig(c.env.DB, s) });
});
app.post('/api/inbox/approve', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string; body?: string } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.id) return c.json({ ok: false, error: 'id required' }, 400);
  return c.json(await approveDraft(c.env.DB, s, c.env, body.id, body.body));
});
app.post('/api/inbox/regenerate', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { id?: string } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.id) return c.json({ ok: false, error: 'id required' }, 400);
  return c.json(await regenerateDraft(c.env.DB, c.env, s, body.id));
});
// W-INBOX-3: invoice build - creates draft order + sends invoice email
app.post('/api/inbox/invoice/build', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { threadId?: unknown; items?: unknown; coverText?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (typeof body.threadId !== 'string' || !body.threadId) return c.json({ ok: false, error: 'threadId required' }, 400);
  if (!Array.isArray(body.items) || !body.items.length) return c.json({ ok: false, error: 'items must be a non-empty array' }, 400);
  for (const item of body.items as unknown[]) {
    if (typeof (item as { variantId?: unknown }).variantId !== 'string' || typeof (item as { qty?: unknown }).qty !== 'number') {
      return c.json({ ok: false, error: 'Each item must have variantId (string) and qty (number)' }, 400);
    }
  }
  const store = new TenantStore(c.env.DB, s);
  const coverText = typeof body.coverText === 'string' ? body.coverText : '';
  return c.json(await buildInvoiceForThread(c.env, store, body.threadId, body.items as { variantId: string; qty: number }[], coverText));
});
// W-INBOX-3: invoice discard - marks invoice discarded
app.post('/api/inbox/invoice/discard', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { invoiceId?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (typeof body.invoiceId !== 'string' || !body.invoiceId) return c.json({ ok: false, error: 'invoiceId required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  return c.json(await discardInvoice(c.env, store, body.invoiceId));
});
// W-INBOX-3: catalog search - searches Shopify products for the invoice builder
app.post('/api/inbox/catalog', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { q?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 120) : '';
  if (!q) return c.json({ ok: false, error: 'q required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  return c.json(await searchCatalog(c.env, store, q));
});

// --- /proxy/* : storefront-facing via Shopify App Proxy (HMAC-signed) ---
//
// IMPORTANT: every /proxy/* response is HTTP 200 with an `ok` flag. Shopify's
// App Proxy replaces non-2xx responses with a generic "There was an error in
// the third-party application" page, which hides the JSON from both the theme
// and anyone debugging. The theme checks the `ok` field, never the status.

interface ProxyCtx { store: TenantStore; cfg: TenantConfig; tenant: TenantRow; vault: Vault }

async function proxyCtx(c: Context<{ Bindings: Env }>): Promise<ProxyCtx | Response> {
  const auth = await verifyAppProxy(new URL(c.req.url), c.env.SHOPIFY_API_SECRET);
  if (!auth.ok) return c.json({ ok: false, error: auth.error });
  const store = new TenantStore(c.env.DB, auth.shop);
  const tenant = await store.getTenant();
  if (!tenant || tenant.status !== 'active' || !tenant.access_token_enc) {
    return c.json({ ok: false, error: 'App not installed' });
  }
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Not configured' });
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return { store, cfg, tenant, vault };
}

function cjFor(env: Env, p: ProxyCtx): CjClient {
  const f = cjFetchFromEnv(env);
  const tokens = new CjTokenManager(p.store, p.vault, f);
  return new CjClient(() => tokens.getToken(), f);
}

const PID_RE = /^[\w-]{1,64}$/;

app.get('/proxy/search', async (c) => {
  const p = await proxyCtx(c); if (p instanceof Response) return p;
  const q = c.req.query('q') ?? '';
  const have = Math.max(0, Number(c.req.query('have')) || 0);
  const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 12), 12);
  // CJ pids already rendered on the search page - excluded so a ghost never
  // duplicates a card the visitor can already see.
  const exclude = (c.req.query('exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
  // Buyer's storefront country (theme passes localization.country) - drives
  // the local-for-local suggestion filter. Malformed values fall back to GB.
  const ccRaw = (c.req.query('country') ?? '').trim().toUpperCase();
  const buyerCountry = /^[A-Z]{2}$/.test(ccRaw) ? ccRaw : 'GB';
  try {
    // LLM + execution ctx let searchBackfill lazy-fill a semantic-library miss
    // in the background (never the hot path); the same client classifies the keyword.
    const llm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
    const products = await searchBackfill(p.store, cjFor(c.env, p), p.cfg, q, have, limit, { exclude, llm, ctx: c.executionCtx, buyerCountry });
    // W3: classify new keywords in the background (cached 30d) - the NEXT
    // search for this term benefits from category + synonyms. Never hot-path.
    if (llm.available && p.cfg.llm.enabled) {
      c.executionCtx.waitUntil(classifyKeyword(llm, p.store, p.cfg, normalizeKeyword(q)));
    }
    return c.json({ ok: true, products });
  } catch (e) {
    const detail = (e as Error).message; // CJ/auth failure reasons - never secret-bearing
    console.warn(`search backfill failed: ${detail}`);
    return c.json({ ok: false, error: `Search backfill unavailable: ${detail}` });
  }
});

// Preview detail. Reaching this IS the qualifying signal: records a view and
// starts the background import so the real PDP exists moments later.
app.get('/proxy/product', async (c) => {
  const p = await proxyCtx(c); if (p instanceof Response) return p;
  const pid = (c.req.query('pid') ?? '').trim();
  if (!PID_RE.test(pid)) return c.json({ ok: false, error: 'Bad pid' });
  try {
    const cj = cjFor(c.env, p);
    let detail = await getDetailPreferWarehouse(p.store, cj, pid);
    if (!detail) return c.json({ ok: false, error: 'Product unavailable' });

    // Curate images for the preview (drop incongruent, hero first) + cache the
    // result so the search grid reuses it. Cached/best-effort; never blocks.
    const previewLlm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
    const previewHero = previewLlm.available && p.cfg.llm.enabled
      ? (title: string, urls: string[]) => pickHeroImage(previewLlm, p.store, p.cfg, title, urls)
      : undefined;
    detail = (await curateDetailImages(p.store, detail, previewHero)).detail;

    let link = await p.store.getLink(pid);
    if (!link || link.state === 'ghost' || link.state === 'failed' || link.state === 'archived') {
      await p.store.putLink({ cjPid: pid, state: 'importing' });
      const accessToken = await p.vault.open(p.tenant.dek_wrapped, p.tenant.access_token_enc);
      const admin = makeAdminGraphql(p.store.shop, accessToken);
      // Background: curation gate + live stock confirm, then import.
      const importLlm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
      const curate = importLlm.available && p.cfg.llm.enabled
        ? (d: typeof detail, ctx: string) => curateProduct(importLlm, p.store, p.cfg, d, ctx)
        : undefined;
      const pickHero = importLlm.available && p.cfg.llm.enabled
        ? (title: string, urls: string[]) => pickHeroImage(importLlm, p.store, p.cfg, title, urls)
        : undefined;
      c.executionCtx.waitUntil(confirmAndImport(p.store, cj, admin, p.cfg, detail, undefined, curate, pickHero));
      link = await p.store.getLink(pid);
    }
    await p.store.recordEvent(pid, 'view');
    const handle = link?.state === 'imported' ? link.handle : null;
    return c.json({ ok: true, product: buildPreview(detail, p.cfg, link?.state ?? 'importing', handle) });
  } catch (e) {
    console.warn(`product preview failed for ${pid}: ${(e as Error).message}`);
    return c.json({ ok: false, error: 'Product unavailable' });
  }
});

app.get('/proxy/import-status', async (c) => {
  const p = await proxyCtx(c); if (p instanceof Response) return p;
  const pid = (c.req.query('pid') ?? '').trim();
  if (!PID_RE.test(pid)) return c.json({ ok: false, error: 'Bad pid' });
  const link = await p.store.getLink(pid);
  const url = link?.state === 'imported' && link.handle ? `/products/${link.handle}` : null;
  return c.json({ ok: true, state: link?.state ?? 'unknown', url });
});

// W-ADDON: hidden basket-filler handles for the PDP add-on row and the cart
// drawer's free-delivery nudge. Returns handles only - the theme fetches
// /products/{handle}.js itself (price/image/variant stay Shopify-fresh).
app.get('/proxy/addons', async (c) => {
  const p = await proxyCtx(c); if (p instanceof Response) return p;
  if (!p.cfg.addons.enabled) return c.json({ ok: true, addons: [] });
  const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 3), 6);
  const addons = await p.store.listAddonHandles(limit);
  return c.json({ ok: true, addons });
});

// Performance beacons from the theme (JS-only, which filters most crawlers).
app.post('/proxy/event', async (c) => {
  const p = await proxyCtx(c); if (p instanceof Response) return p;
  let body: { pid?: string; event?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }); }
  const pid = (body.pid ?? '').trim();
  const event = body.event ?? '';
  if (!PID_RE.test(pid) || (event !== 'view' && event !== 'atc')) {
    return c.json({ ok: false, error: 'Bad event' });
  }
  if (!(await p.store.getLink(pid))) return c.json({ ok: false, error: 'Unknown product' });
  await p.store.recordEvent(pid, event);
  return c.json({ ok: true });
});

// --- uninstall webhook ---
app.post('/webhooks/uninstall', async (c) => {
  const shopify = makeShopify(c.env);
  const body = await c.req.text();
  const valid = await shopify.webhooks.validate({ rawBody: body, rawRequest: c.req.raw });
  if (!valid.valid) return c.text('invalid', 401);
  const shop = c.req.header('X-Shopify-Shop-Domain') ?? '';
  await handleUninstall(c.env.DB, shop);
  return c.text('ok');
});

// --- orders/paid webhook (W-FULFIL Stage A: receive + validate, no money leg) ---
app.post('/webhooks/orders-paid', async (c) => {
  const shopify = makeShopify(c.env);
  const body = await c.req.text();
  const valid = await shopify.webhooks.validate({ rawBody: body, rawRequest: c.req.raw });
  if (!valid.valid) return c.text('invalid', 401);
  const shop = c.req.header('X-Shopify-Shop-Domain') ?? '';
  try {
    const store = new TenantStore(c.env.DB, shop);
    const cfg = await store.getConfig();
    if (!cfg) return c.text('ok'); // not configured - ack so Shopify stops retrying
    const order = parseOrderWebhook(JSON.parse(body));
    if (!order.shopifyOrderId) return c.text('ok');
    const { holds, lineItems } = await validateOrder(order, store, cfg);
    const fulfilAfter = new Date(Date.now() + FULFIL_GRACE_MINUTES * 60_000).toISOString();
    const isNew = await store.insertOrderIfNew({
      shopifyOrderId: order.shopifyOrderId,
      orderName: order.orderName || null,
      totalPrice: order.totalPrice,
      currency: order.currency,
      financialStatus: order.financialStatus || null,
      riskLevel: order.riskLevel,
      status: holds.length ? 'held' : 'queued',
      holdReasons: holds,
      addressJson: order.address ? JSON.stringify(order.address) : null,
      lineItemsJson: JSON.stringify(lineItems),
      fulfilAfter: holds.length ? null : fulfilAfter
    });
    if (isNew) console.log(`order ${order.orderName} ${holds.length ? 'HELD (' + holds.join(',') + ')' : 'queued'}`);
    // Real ORDER events feed the deterministic "Selling fast" badge and the 30-day
    // cull. Recorded only on first receipt (isNew) so webhook retries never double
    // count; best-effort, never blocks the ack.
    if (isNew) {
      for (const li of lineItems) {
        if (li.cjPid) c.executionCtx.waitUntil(store.recordEvent(li.cjPid, 'order').catch(() => undefined));
      }
    }
    c.executionCtx.waitUntil(attributePaidOrder(store, order).then(() => undefined));
  } catch (e) {
    console.warn(`orders-paid handler failed for ${shop}: ${(e as Error).message}`);
  }
  return c.text('ok'); // always 200 - a non-2xx makes Shopify retry the webhook
});

// --- GDPR mandatory webhooks (HMAC-verified; all return 200) ---
async function gdprWebhook(c: Context<{ Bindings: Env }>, handle: (store: TenantStore, payload: Record<string, unknown>) => Promise<void>): Promise<Response> {
  const shopify = makeShopify(c.env);
  const body = await c.req.text();
  const valid = await shopify.webhooks.validate({ rawBody: body, rawRequest: c.req.raw });
  if (!valid.valid) return c.text('invalid', 401);
  const shop = c.req.header('X-Shopify-Shop-Domain') ?? '';
  try {
    await handle(new TenantStore(c.env.DB, shop), JSON.parse(body) as Record<string, unknown>);
  } catch (e) {
    console.warn(`gdpr webhook failed for ${shop}: ${(e as Error).message}`);
  }
  return c.text('ok');
}
// What personal data we hold for a customer = the shipping address on their orders.
app.post('/webhooks/customers-data-request', (c) =>
  gdprWebhook(c, async (store, p) => {
    const ids = Array.isArray(p.orders_requested) ? p.orders_requested.map(String) : [];
    console.log(`customers/data_request: shop holds order shipping data for orders [${ids.join(',')}] - operator to provide to the data subject`);
    const email = ((p.customer as { email?: string } | undefined)?.email ?? '').toString();
    if (email) {
      const s = await store.inboxDataSummary(email);
      console.log(`customers/data_request: shop also holds ${s.threads} inbox thread(s) / ${s.messages} message(s) for ${email} - operator to provide to the data subject`);
    }
  }));
// Erase the PII we hold for the named orders.
app.post('/webhooks/customers-redact', (c) =>
  gdprWebhook(c, async (store, p) => {
    const ids = Array.isArray(p.orders_to_redact) ? p.orders_to_redact.map(String) : [];
    const n = await store.redactOrders(ids);
    const email = ((p.customer as { email?: string } | undefined)?.email ?? '').toString();
    const inboxRemoved = email ? await store.redactContact(email) : 0;
    console.log(`customers/redact: erased ${n} order row(s) + ${inboxRemoved} inbox row(s)`);
  }));
// Purge ALL data for the shop (~48h after uninstall).
app.post('/webhooks/shop-redact', (c) =>
  gdprWebhook(c, async (store) => {
    await store.redactShop();
    console.log('shop/redact: shop data purged');
  }));

// --- W-INBOX: inbound email handler (Cloudflare Email Routing → Worker) ---
// Reads the raw message, parses + stores it against the (first-party) active
// shop. Classification runs later on the cron sweep, not here.
export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  try {
    const shops = await listActiveShops(env.DB);
    const shop = shops[0];
    if (!shop) { console.warn('inbound email: no active shop configured'); return; }
    const store = new TenantStore(env.DB, shop);
    const raw = await new Response(message.raw).arrayBuffer();
    const r = await processInbound(store, raw);
    console.log(`inbound email stored: thread ${r.threadId}${r.deduped ? ' (dup)' : ''}`);
    // W-INBOX-1 rollback net: also forward a copy to the owner until capture is trusted.
    if (env.INBOX_FORWARD_TO) {
      try { await message.forward(env.INBOX_FORWARD_TO); }
      catch (e) { console.warn(`inbound forward failed: ${(e as Error).message}`); }
    }
  } catch (e) {
    console.warn(`inbound email handler failed: ${(e as Error).message}`);
  }
}

const DAILY_CRON = '17 4 * * *';
const worker: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (controller, env, ctx) => {
    // Daily cron → start the staged maintenance chain; the 15-min cron → order
    // pipeline + inbox classify sweep + market-visibility reconcile (pulls a
    // freshly published cross-lane product out of the wrong markets within one
    // sweep) + resume of any in-flight daily chain (the nightly outgrew one
    // 15-minute invocation, so it completes across ticks).
    ctx.waitUntil(
      controller.cron === DAILY_CRON
        ? runDailyMaintenance(env)
        : Promise.all([runOrderPipeline(env), runInboxClassifySweep(env), runMarketVisibilityReconcile(env), resumeDailyMaintenance(env)]).then(() => undefined)
    );
  },
  email: (message, env, ctx) => handleInboundEmail(message, env, ctx)
};

export default worker;
