import { Hono } from 'hono';
import type { Env } from './types';
import { makeShopify } from './shopify';
import { Vault } from './vault';
import { beginAuth } from './auth/install';
import { handleCallback } from './auth/callback';
import { handleUninstall } from './auth/uninstall';
import { resolveShopFromToken } from './console/session';
import { connectCj, saveGates, saveCollectionMap, getStatus } from './console/routes';
import { consolePage } from './console/page';
import { validateCjKey } from './cj';

const app = new Hono<{ Bindings: Env }>();

app.get('/auth', (c) => beginAuth(makeShopify(c.env), c.req.raw));

app.get('/auth/callback', async (c) => {
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return handleCallback(makeShopify(c.env), c.env.DB, vault, c.req.raw);
});

app.get('/app', (c) => consolePage(c.env.SHOPIFY_API_KEY, c.req.query('host') ?? ''));

// --- /api/* : session-token authed ---
async function shopOf(c: any): Promise<string | Response> {
  const shopify = makeShopify(c.env);
  const r = await resolveShopFromToken(c.req.header('Authorization') ?? null, c.env.SHOPIFY_API_KEY, (t) => shopify.session.decodeSessionToken(t));
  if (!r.ok) return c.json({ ok: false, error: r.error }, r.status);
  return r.shop;
}

app.post('/api/status', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; return c.json(await getStatus(c.env.DB, s)); });
app.post('/api/connect-cj', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const { apiKey } = await c.req.json<{ apiKey: string }>();
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  return c.json(await connectCj(c.env.DB, vault, s, apiKey, (k) => validateCjKey(k)));
});
app.post('/api/gates', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; await saveGates(c.env.DB, s, await c.req.json()); return c.json({ ok: true }); });
app.post('/api/collections', async (c) => { const s = await shopOf(c); if (typeof s !== 'string') return s; await saveCollectionMap(c.env.DB, s, await c.req.json()); return c.json({ ok: true }); });

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
