import { Hono } from 'hono';
import type { Context } from 'hono';
import { RequestedTokenType } from '@shopify/shopify-api';
import type { Env, TenantConfig, TenantRow } from './types';
import { makeShopify } from './shopify';
import { Vault } from './vault';
import { TenantStore } from './tenant-store';
import { beginAuth } from './auth/install';
import { handleCallback } from './auth/callback';
import { ensureInstalled } from './auth/ensure-installed';
import { handleUninstall } from './auth/uninstall';
import { resolveShopFromToken } from './console/session';
import { connectCj, saveGates, savePricing, saveLlm, saveAddons, saveCollectionMap, getStatus, getInsights } from './console/routes';
import { consolePage } from './console/page';
import { validateCjKey, CjClient, CjTokenManager, cjFetchFromEnv } from './cj';
import { registerWebhooks, type RegisterWebhook } from './webhooks';
import { validateGatesPayload, validatePricingPayload, validateLlmPayload, validateAddonsPayload, validateCollectionMap } from './validate';
import { verifyAppProxy } from './proxy/verify';
import { searchBackfill, normalizeKeyword } from './proxy/search';
import { LlmClient, classifyKeyword, curateProduct, pickHeroImage, rewriteDescription } from './llm';
import { buildPreview, getDetailPreferWarehouse, confirmAndImport, reconcileAddonVisibility, reconcileHeroImages, reconcileDescriptions, reconcileCategories } from './proxy/import';
import { makeAdminGraphql } from './shopify-admin';
import { runDailyMaintenance, syncStoreInventory, refillCollections } from './jobs';
import { runOrderPipeline } from './fulfil-run';
import { parseOrderWebhook, validateOrder, FULFIL_GRACE_MINUTES } from './fulfil';
import { firecrawlCjSearch } from './firecrawl';

const app = new Hono<{ Bindings: Env }>();

function makeRegistrar(env: Env): RegisterWebhook {
  return (shop, accessToken) => registerWebhooks(shop, accessToken, env.SHOPIFY_APP_URL);
}

app.get('/auth', (c) => beginAuth(makeShopify(c.env), c.req.raw));

app.get('/auth/callback', async (c) => {
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return handleCallback(makeShopify(c.env), c.env.DB, vault, c.req.raw, makeRegistrar(c.env));
});

app.get('/app', (c) => consolePage(c.env.SHOPIFY_API_KEY));

// --- /api/* : session-token authed (embedded console) ---
// Resolves the shop from the App Bridge session token and, on a managed install,
// lazily mints + persists an offline access token via token exchange (first call only).
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
  await saveLlm(c.env.DB, s, v.value);
  return c.json({ ok: true });
});
// W-FULFIL Stage B: toggle auto-fulfilment (the money leg). OFF by default;
// only flip ON once the CJ wallet is funded.
app.post('/api/fulfil', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { autopay?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const store = new TenantStore(c.env.DB, s);
  if (!(await store.getConfig())) return c.json({ ok: false, error: 'Not configured' }, 400);
  const autopay = body.autopay === true;
  await store.saveFulfil({ autopay });
  return c.json({ ok: true, autopay });
});
// Manual "Sync now": the nightly maintenance pieces, runnable on demand from
// the console. Batched — each call does a slice of the work and tells the
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
      const syncLlm = new LlmClient(c.env.OPENROUTER_API_KEY);
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
  const llm = new LlmClient(c.env.OPENROUTER_API_KEY);
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
  const llm = new LlmClient(c.env.OPENROUTER_API_KEY);
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
  return c.json({ ok: true, orders, autopay: cfg?.fulfil.autopay ?? false });
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
  // CJ pids already rendered on the search page — excluded so a ghost never
  // duplicates a card the visitor can already see.
  const exclude = (c.req.query('exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
  try {
    const products = await searchBackfill(p.store, cjFor(c.env, p), p.cfg, q, have, limit, { exclude });
    // W3: classify new keywords in the background (cached 30d) — the NEXT
    // search for this term benefits from category + synonyms. Never hot-path.
    const llm = new LlmClient(c.env.OPENROUTER_API_KEY);
    if (llm.available && p.cfg.llm.enabled) {
      c.executionCtx.waitUntil(classifyKeyword(llm, p.store, p.cfg, normalizeKeyword(q)));
    }
    return c.json({ ok: true, products });
  } catch (e) {
    const detail = (e as Error).message; // CJ/auth failure reasons — never secret-bearing
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
    const detail = await getDetailPreferWarehouse(p.store, cj, pid);
    if (!detail) return c.json({ ok: false, error: 'Product unavailable' });

    let link = await p.store.getLink(pid);
    if (!link || link.state === 'ghost' || link.state === 'failed' || link.state === 'archived') {
      await p.store.putLink({ cjPid: pid, state: 'importing' });
      const accessToken = await p.vault.open(p.tenant.dek_wrapped, p.tenant.access_token_enc);
      const admin = makeAdminGraphql(p.store.shop, accessToken);
      // Background: curation gate + live stock confirm, then import.
      const importLlm = new LlmClient(c.env.OPENROUTER_API_KEY);
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
// drawer's free-delivery nudge. Returns handles only — the theme fetches
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
    if (!cfg) return c.text('ok'); // not configured — ack so Shopify stops retrying
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
  } catch (e) {
    console.warn(`orders-paid handler failed for ${shop}: ${(e as Error).message}`);
  }
  return c.text('ok'); // always 200 — a non-2xx makes Shopify retry the webhook
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
  gdprWebhook(c, async (_store, p) => {
    const ids = Array.isArray(p.orders_requested) ? p.orders_requested.map(String) : [];
    console.log(`customers/data_request: shop holds order shipping data for orders [${ids.join(',')}] — operator to provide to the data subject`);
  }));
// Erase the PII we hold for the named orders.
app.post('/webhooks/customers-redact', (c) =>
  gdprWebhook(c, async (store, p) => {
    const ids = Array.isArray(p.orders_to_redact) ? p.orders_to_redact.map(String) : [];
    const n = await store.redactOrders(ids);
    console.log(`customers/redact: erased ${n} order row(s)`);
  }));
// Purge ALL data for the shop (~48h after uninstall).
app.post('/webhooks/shop-redact', (c) =>
  gdprWebhook(c, async (store) => {
    await store.redactShop();
    console.log('shop/redact: shop data purged');
  }));

const DAILY_CRON = '17 4 * * *';
const worker: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (controller, env, ctx) => {
    // Daily cron → full maintenance; the frequent cron → order pipeline (submit + track).
    ctx.waitUntil(controller.cron === DAILY_CRON ? runDailyMaintenance(env) : runOrderPipeline(env));
  }
};

export default worker;
