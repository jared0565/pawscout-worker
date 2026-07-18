// Thin Blotato REST client (blog distribution phase 1). Blotato is the social
// posting RAIL only: account OAuth lives in their dashboard, this client just
// mirrors media and submits posts with the vault-external worker secret
// BLOTATO_API_KEY. Deliberately swappable: everything upstream (pack, ledger,
// console) is rail-agnostic, per the spec's 90-day earn-it review exit path.
// API shapes verified against help.blotato.com 2026-07-11: POST /v2/media
// {url} -> {url}; POST /v2/posts -> 201 {postSubmissionId} (async);
// GET /v2/posts/:id -> {status: in-progress|published|failed, errorMessage?,
// publicUrl?}; account/board lists return {items: [...]}. Post creation is
// rate-limited 30/min (far above our few posts a week).
// Idempotency: VERIFIED ABSENT (help.blotato.com/api/publish-post, checked
// 2026-07-18) - createPost accepts no Idempotency-Key header or dedupe field
// (body is only {post, scheduledTime?, useNextFreeSlot?}). The ledger's CAS
// attempts-claim is therefore the ONLY double-post fence; a createPost whose
// response is lost after server-side acceptance remains an accepted
// at-least-once tail (retry may double-post). Re-check if Blotato adds one.
import { defaultFetch } from '../safe-fetch';
import type { Env } from '../types';

const BASE = 'https://backend.blotato.com/v2';

export interface BlotatoPostInput {
  accountId: string;
  text: string;
  mediaUrls: string[];
  platform: 'pinterest' | 'facebook' | 'instagram';
  target: Record<string, unknown>;
}
export type BlotatoSendResult = { ok: true; submissionId: string } | { ok: false; error: string; permanent: boolean };
export interface BlotatoStatus { status: 'in-progress' | 'published' | 'failed'; errorMessage?: string; publicUrl?: string }
export interface BlotatoAccount { id: string; platform?: string; name?: string; username?: string }

export class Blotato {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = defaultFetch) {}

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'blotato-api-key': this.apiKey };
  }

  /** Mirror a public image onto Blotato hosting (their media pipeline wants
   * media served from their domain). Null on any failure. */
  async mirrorMedia(url: string): Promise<string | null> {
    try {
      const r = await this.fetchImpl(`${BASE}/media`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ url }) });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { url?: string } | null;
      return j?.url ?? null;
    } catch { return null; }
  }

  /** Submit a post. Blotato queues it (async): a true result means ACCEPTED,
   * not live - pollStatus confirms. permanent=true (4xx except 429) tells the
   * sweep a retry with the same payload cannot succeed. */
  async createPost(p: BlotatoPostInput): Promise<BlotatoSendResult> {
    let r: Response;
    try {
      r = await this.fetchImpl(`${BASE}/posts`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ post: { accountId: p.accountId, content: { text: p.text, mediaUrls: p.mediaUrls, platform: p.platform }, target: p.target } })
      });
    } catch (e) { return { ok: false, error: (e as Error).message, permanent: false }; }
    const j = (await r.json().catch(() => null)) as { postSubmissionId?: string; message?: string; error?: string } | null;
    if (!r.ok) {
      return { ok: false, error: j?.message ?? j?.error ?? `HTTP ${r.status}`, permanent: r.status >= 400 && r.status < 500 && r.status !== 429 };
    }
    if (!j?.postSubmissionId) return { ok: false, error: 'no postSubmissionId in response', permanent: false };
    return { ok: true, submissionId: j.postSubmissionId };
  }

  async pollStatus(submissionId: string): Promise<BlotatoStatus | null> {
    try {
      const r = await this.fetchImpl(`${BASE}/posts/${encodeURIComponent(submissionId)}`, { headers: this.headers() });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { status?: string; errorMessage?: string; publicUrl?: string } | null;
      if (j?.status !== 'in-progress' && j?.status !== 'published' && j?.status !== 'failed') return null;
      return { status: j.status, errorMessage: j.errorMessage, publicUrl: j.publicUrl };
    } catch { return null; }
  }

  private async listItems(path: string): Promise<BlotatoAccount[] | null> {
    try {
      const r = await this.fetchImpl(`${BASE}${path}`, { headers: this.headers() });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { items?: BlotatoAccount[] } | null;
      return j?.items ?? null;
    } catch { return null; }
  }

  listAccounts(): Promise<BlotatoAccount[] | null> { return this.listItems('/users/me/accounts'); }
  listSubaccounts(accountId: string): Promise<BlotatoAccount[] | null> { return this.listItems(`/users/me/accounts/${encodeURIComponent(accountId)}/subaccounts`); }
  listPinterestBoards(accountId: string): Promise<BlotatoAccount[] | null> { return this.listItems(`/social/pinterest/boards?accountId=${encodeURIComponent(accountId)}`); }
}

/** Dormancy switch (mirrors ebayFromEnv): no BLOTATO_API_KEY secret = no rail,
 * queued rows wait and the console shows "not connected". */
export function blotatoFromEnv(env: Env, fetchImpl: typeof fetch = defaultFetch): Blotato | null {
  return env.BLOTATO_API_KEY ? new Blotato(env.BLOTATO_API_KEY, fetchImpl) : null;
}
