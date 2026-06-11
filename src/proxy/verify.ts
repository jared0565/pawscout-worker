export type ProxyAuth = { ok: true; shop: string } | { ok: false; status: number; error: string };

const MAX_SKEW_MS = 300_000;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Shopify App Proxy request: `signature` is hex HMAC-SHA256 over the
 * sorted query params (sans signature) joined as `key=value` with no separator,
 * array values comma-joined. Timestamp freshness bounds replay.
 */
export async function verifyAppProxy(url: URL, secret: string, nowMs = Date.now()): Promise<ProxyAuth> {
  const sig = url.searchParams.get('signature');
  if (!sig) return { ok: false, status: 401, error: 'Missing signature' };

  const pairs = new Map<string, string[]>();
  url.searchParams.forEach((v, k) => {
    if (k === 'signature') return;
    const arr = pairs.get(k) ?? [];
    arr.push(v);
    pairs.set(k, arr);
  });
  const message = [...pairs.keys()].sort().map((k) => `${k}=${pairs.get(k)!.join(',')}`).join('');

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  if (!timingSafeEqual(expected, sig)) return { ok: false, status: 401, error: 'Bad signature' };

  const ts = Number(url.searchParams.get('timestamp') ?? 0) * 1000;
  if (!ts || Math.abs(nowMs - ts) > MAX_SKEW_MS) return { ok: false, status: 401, error: 'Stale timestamp' };

  const shop = url.searchParams.get('shop') ?? '';
  if (!shop.endsWith('.myshopify.com')) return { ok: false, status: 401, error: 'Bad shop' };
  return { ok: true, shop };
}

/** Test helper / signer (also used by docs examples): builds the signature CJ-side verification expects. */
export async function signAppProxy(params: Record<string, string>, secret: string): Promise<string> {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}
