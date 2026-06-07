import '@shopify/shopify-api/adapters/cf-worker';
import { shopifyApi, LATEST_API_VERSION, LogSeverity } from '@shopify/shopify-api';
import type { Env } from './types';

export function makeShopify(env: Env) {
  const appUrl = new URL(env.SHOPIFY_APP_URL);
  return shopifyApi({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET,
    scopes: env.SHOPIFY_SCOPES.split(','),
    hostName: appUrl.host,
    hostScheme: 'https',
    apiVersion: LATEST_API_VERSION,
    isEmbeddedApp: true,
    logger: { level: LogSeverity.Warning }
  });
}

export type ShopifyApp = ReturnType<typeof makeShopify>;
