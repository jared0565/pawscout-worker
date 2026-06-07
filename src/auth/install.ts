import type { ShopifyApp } from '../shopify';

/** GET /auth?shop=foo.myshopify.com → 302 to Shopify OAuth consent. Returns a Response. */
export async function beginAuth(shopify: ShopifyApp, request: Request): Promise<Response> {
  const shop = shopify.utils.sanitizeShop(new URL(request.url).searchParams.get('shop') ?? '', true);
  if (!shop) return new Response('Missing or invalid ?shop', { status: 400 });
  return shopify.auth.begin({ shop, callbackPath: '/auth/callback', isOnline: false, rawRequest: request });
}
