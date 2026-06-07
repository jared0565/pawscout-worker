type Decoded = { dest?: string; aud?: string };
export type ResolveResult = { ok: true; shop: string } | { ok: false; status: number; error: string };

/** Verify+decode handled by the injected `decode` (shopify.session.decodeSessionToken in prod). */
export async function resolveShopFromToken(
  authHeader: string | null,
  apiKey: string,
  decode: (token: string) => Promise<Decoded>
): Promise<ResolveResult> {
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, status: 401, error: 'Missing bearer token' };
  let payload: Decoded;
  try {
    payload = await decode(authHeader.slice('Bearer '.length));
  } catch (e) {
    return { ok: false, status: 401, error: `Invalid session token: ${(e as Error).message}` };
  }
  if (payload.aud && payload.aud !== apiKey) return { ok: false, status: 401, error: 'Audience mismatch' };
  const dest = payload.dest ?? '';
  const shop = dest.replace(/^https?:\/\//, '');
  if (!shop.endsWith('.myshopify.com')) return { ok: false, status: 401, error: 'Bad shop in token' };
  return { ok: true, shop };
}
