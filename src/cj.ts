const CJ_AUTH_URL = 'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken';

export type ValidateResult = { ok: true } | { ok: false; error: string };

export async function validateCjKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ValidateResult> {
  try {
    const resp = await fetchImpl(CJ_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    if (!resp.ok) return { ok: false, error: `CJ auth HTTP ${resp.status}` };
    const data = (await resp.json()) as { result?: boolean; message?: string };
    return data.result ? { ok: true } : { ok: false, error: data.message || 'CJ rejected the key' };
  } catch (e) {
    return { ok: false, error: `CJ auth failed: ${(e as Error).message}` };
  }
}
