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
import { connectCj, saveGates, savePricing, saveLlm, saveCollectionMap, getStatus, getInsights } from './console/routes';
import { consolePage } from './console/page';
import { validateCjKey, CjClient, CjTokenManager, cjFetchFromEnv } from './cj';
import { registerUninstallWebhook, type RegisterWebhook } from './webhooks';
import { validateGatesPayload, validatePricingPayload, validateLlmPayload, validateCollectionMap } from './validate';
import { verifyAppProxy } from './proxy/verify';
import { searchBackfill, normalizeKeyword } from './proxy/search';
import { LlmClient, classifyKeyword, curateProduct } from './llm';
import { buildPreview, getDetailPreferWarehouse, confirmAndImport } from './proxy/import';
import { makeAdminGraphql } from './shopify-admin';
import { runDailyMaintenance, syncStoreInventory, refillCollections } from './jobs';

const app = new Hono<{ Bindings: Env }>();

function makeRegistrar(env: Env): RegisterWebhook {
  return (shop, accessToken) => registerUninstallWebhook(shop, accessToken, env.SHOPIFY_APP_URL);
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
      const imported = await refillCollections(store, cj, admin, cfg, { maxImports: REFILL_BATCH, curate });
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
  try {
    const products = await searchBackfill(p.store, cjFor(c.env, p), p.cfg, q, have, limit);
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
      c.executionCtx.waitUntil(confirmAndImport(p.store, cj, admin, p.cfg, detail, undefined, curate));
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

const worker: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runDailyMaintenance(env));
  }
};

export default worker;
