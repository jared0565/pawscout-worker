import { Hono } from 'hono';
import { RequestedTokenType } from '@shopify/shopify-api';
import type { Env } from './types';
import { makeShopify } from './shopify';
import { Vault } from './vault';
import { beginAuth } from './auth/install';
import { handleCallback } from './auth/callback';
import { ensureInstalled } from './auth/ensure-installed';
import { handleUninstall } from './auth/uninstall';
import { resolveShopFromToken } from './console/session';
import { connectCj, saveGates, saveCollectionMap, getStatus } from './console/routes';
import { consolePage } from './console/page';
import { validateCjKey } from './cj';
import { registerUninstallWebhook, type RegisterWebhook } from './webhooks';
import { validateGatesPayload, validateCollectionMap } from './validate';

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

// --- /api/* : session-token authed ---
// Resolves the shop from the App Bridge session token and, on a managed install,
// lazily mints + persists an offline access token via token exchange (first call only).
async function shopOf(c: any): Promise<string | Response> {
  const shopify = makeShopify(c.env);
  const authHeader = c.req.header('Authorization') ?? null;
  const r = await resolveShopFromToken(authHeader, c.env.SHOPIFY_API_KEY, (t) => shopify.session.decodeSessionToken(t));
  if (!r.ok) return c.json({ ok: false, error: r.error }, r.status);

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
app.post('/api/connect-cj', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const { apiKey } = await c.req.json<{ apiKey: string }>();
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return c.json(await connectCj(c.env.DB, vault, s, apiKey, (k) => validateCjKey(k)));
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
app.post('/api/collections', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const v = validateCollectionMap(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  await saveCollectionMap(c.env.DB, s, v.value);
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

export default app;
