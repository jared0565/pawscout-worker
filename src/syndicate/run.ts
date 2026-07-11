// The syndication sweep (blog distribution phase 1). Runs on the 15-minute
// cron: detect drafted-to-published transitions (reusing the same
// listPostsSynced the console list uses, so D1 status follows Shopify), ensure
// each published guide has a creative pack, enqueue one ledger row per ENABLED
// channel (the (shop, post_id, channel) PK makes this idempotent), fire the
// channels whose auto switch is on, and confirm accepted submissions by
// polling Blotato. Manual sends (console route) share ensurePack/sendChannel.
// HITL contract: every channel ships enabled=false auto=false; the owner
// clicks Send per channel in the console until a channel earns its auto flip.
import { LlmClient } from '../llm';
import { TenantStore, listActiveShops } from '../tenant-store';
import { adminForShop } from '../inbox/invoice-routes';
import { defaultFetch } from '../safe-fetch';
import type { Env, TenantConfig, SyndicateConfig, SyndicateChannelKey } from '../types';
import { SYNDICATE_CHANNEL_KEYS, mergeSyndicate } from '../types';
import { listPostsSynced } from '../blog/pipeline';
import { getArticlesForSyndication, type ArticleSyndicationInfo } from '../blog/article';
import type { AdminGraphql } from '../shopify-admin';
import { buildCopy, validateCopy, type SyndicationCopy } from './pack';
import { blotatoPostFor } from './channels';
import { Blotato, blotatoFromEnv } from './blotato';

export const SYNDICATION_MAX_AUTO_ATTEMPTS = 3;

export function anyChannelEnabled(syn: SyndicateConfig): boolean {
  return SYNDICATE_CHANNEL_KEYS.some((k) => syn.channels[k].enabled);
}

export interface PackInfo { articleHandle: string | null; copy: SyndicationCopy; pinImageUrl: string | null }

type PostRow = Awaited<ReturnType<TenantStore['listBlogPostDrafts']>>[number];

/** Test injection points (and the console list route's fire:false); production
 * cron callers pass nothing. */
export interface SyndicationDeps {
  listPosts?: (env: Env, store: TenantStore, fetchImpl?: typeof fetch) => Promise<PostRow[]>;
  articles?: (admin: AdminGraphql, ids: string[]) => Promise<Map<string, ArticleSyndicationInfo>>;
  blotato?: Blotato | null;
  copy?: typeof buildCopy;
  /** false = enqueue + pack + confirm but never auto-send. The console list
   * route uses this so opening the console cannot race the cron into a
   * double post; sends from the console are always the explicit send route. */
  fire?: boolean;
  fetchImpl?: typeof fetch;
}

function parsePack(row: { article_handle: string | null; captions_json: string; pin_image_url: string | null } | null): PackInfo | null {
  if (!row) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.captions_json); } catch { return null; }
  const copy = validateCopy(raw);
  if (!copy) return null;
  return { articleHandle: row.article_handle, copy, pinImageUrl: row.pin_image_url };
}

/** Build (or reuse) the creative pack for one published post. Live Shopify
 * article info is the source of truth (handle + CURRENT hero, so an
 * owner-swapped image is what gets pinned). Degrades to {error}. */
export async function ensurePack(
  env: Env, store: TenantStore, cfg: TenantConfig, blotato: Blotato | null,
  post: { id: string; shopifyArticleId: string; title: string; collectionHandle: string | null; relatedHandlesJson: string | null },
  opts: { force?: boolean; fetchImpl?: typeof fetch; articles?: SyndicationDeps['articles']; copy?: typeof buildCopy } = {}
): Promise<{ pack: PackInfo } | { error: string }> {
  if (!opts.force) {
    const existing = parsePack(await store.getSyndicationPack(post.id));
    if (existing) return { pack: existing };
  }
  // An injected articles fetcher (tests, console previews) replaces the live
  // lookup stage entirely, so only the production path needs an Admin client.
  const admin = opts.articles ? null : await adminForShop(env, store, opts.fetchImpl ?? defaultFetch).catch(() => null);
  if (!opts.articles && !admin) return { error: 'pack build failed: Shopify connection unavailable' };
  let info: ArticleSyndicationInfo | undefined;
  try {
    info = (await (opts.articles ?? getArticlesForSyndication)(admin as AdminGraphql, [post.shopifyArticleId])).get(post.shopifyArticleId);
  } catch (e) { return { error: `pack build failed: ${(e as Error).message}` }; }
  if (!info) return { error: 'pack build failed: article no longer exists' };

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, opts.fetchImpl ?? defaultFetch);
  let productTitles: string[] = [];
  try { productTitles = (JSON.parse(post.relatedHandlesJson ?? '[]') as string[]).map((h) => h.replace(/-/g, ' ')); } catch { /* bookkeeping only */ }
  const copy = await (opts.copy ?? buildCopy)(llm, store, cfg, {
    articleTitle: info.title || post.title, collectionHandle: post.collectionHandle, productTitles
  });
  if (!copy) return { error: 'pack build failed: copy agent produced nothing usable' };

  // Mirror the CURRENT article hero onto Blotato hosting. Best-effort: a
  // missing rail or failed mirror leaves pinImageUrl null (image-requiring
  // channels then error per-send, visibly).
  let pinImageUrl: string | null = null;
  if (info.imageUrl && blotato) pinImageUrl = await blotato.mirrorMedia(info.imageUrl);

  await store.upsertSyndicationPack({ postId: post.id, articleHandle: info.handle, captionsJson: JSON.stringify(copy), pinImageUrl });
  return { pack: { articleHandle: info.handle, copy, pinImageUrl } };
}

/** Send one queued channel row. Shared by the auto sweep and the manual
 * console route (the route bypasses the auto flag + attempt cap by calling
 * this directly). Posting is public and irreversible, so the FIRST act is an
 * optimistic claim on the attempts counter: a concurrent actor (cron tick vs
 * console click) makes the loser's claim fail, and the loser never posts. */
export async function sendChannel(
  store: TenantStore, syn: SyndicateConfig, blotato: Blotato | null,
  postId: string, channel: SyndicateChannelKey, pack: PackInfo, attempts: number
): Promise<{ ok: boolean; error?: string }> {
  if (!blotato) return { ok: false, error: 'Blotato is not connected (set BLOTATO_API_KEY)' };
  if (!(await store.claimSyndicationAttempt(postId, channel, attempts))) {
    return { ok: false, error: 'another send for this post and channel is already in flight' };
  }
  if (!pack.articleHandle) {
    await store.markSyndication(postId, channel, { status: 'failed', error: 'no article handle for the link' });
    return { ok: false, error: 'no article handle for the link' };
  }
  const payload = blotatoPostFor(channel, syn.channels[channel], { copy: pack.copy, articleHandle: pack.articleHandle, imageUrl: pack.pinImageUrl });
  if ('error' in payload) {
    await store.markSyndication(postId, channel, { status: 'failed', error: payload.error });
    return { ok: false, error: payload.error };
  }
  const r = await blotato.createPost(payload);
  if (!r.ok) {
    await store.markSyndication(postId, channel, { status: r.permanent ? 'failed' : 'queued', error: r.error });
    return { ok: false, error: r.error };
  }
  await store.markSyndication(postId, channel, {
    status: 'sent', externalId: r.submissionId, error: null, sentAt: new Date().toISOString()
  });
  return { ok: true };
}

/** One shop's sweep pass. See the file header for the five stages. */
export async function runSyndicationForShop(
  env: Env, store: TenantStore, cfg: TenantConfig, deps: SyndicationDeps = {}
): Promise<{ queued: number; posted: number; confirmed: number; failed: number }> {
  const zero = { queued: 0, posted: 0, confirmed: 0, failed: 0 };
  const syn = cfg.syndicate ?? mergeSyndicate('{}');
  if (!anyChannelEnabled(syn)) return zero;

  const posts = await (deps.listPosts ?? listPostsSynced)(env, store, deps.fetchImpl ?? defaultFetch);
  const published = posts.filter((p) => p.status === 'published' && p.shopify_article_id);
  if (!published.length) return zero;

  const out = { ...zero };
  const fire = deps.fire !== false;
  const blotato = deps.blotato !== undefined ? deps.blotato : blotatoFromEnv(env, deps.fetchImpl ?? defaultFetch);

  // 1) Enqueue: one row per published post per ENABLED channel.
  const before = await store.listSyndicationLedger();
  const have = new Set(before.map((r) => `${r.post_id}|${r.channel}`));
  for (const p of published) {
    for (const k of SYNDICATE_CHANNEL_KEYS) {
      if (!syn.channels[k].enabled || have.has(`${p.id}|${k}`)) continue;
      if (await store.enqueueSyndication(p.id, k)) out.queued++;
    }
  }

  // Detached snapshot of the ledger: the fire stage's claim fence compares the
  // attempts value READ HERE against the live row (a concurrent actor bumping
  // it must make our claim lose), and the confirm stage must see this sweep's
  // own sends only on the NEXT pass. D1 rows are already detached; the copy
  // pins that point-in-time semantics for any store implementation.
  const ledger = (await store.listSyndicationLedger()).map((r) => ({ ...r }));
  const byPost = new Map<string, typeof ledger>();
  for (const r of ledger) {
    const arr = byPost.get(r.post_id) ?? [];
    arr.push(r); byPost.set(r.post_id, arr);
  }

  for (const p of published) {
    const rows = byPost.get(p.id) ?? [];
    const queuedRows = rows.filter((r) => r.status === 'queued');

    // 2) Pack: built lazily, only when this post still has queued work.
    let pack: PackInfo | null = null;
    if (queuedRows.length) {
      const ensured = await ensurePack(env, store, cfg, blotato, {
        id: p.id, shopifyArticleId: p.shopify_article_id as string, title: p.title,
        collectionHandle: p.collection_handle, relatedHandlesJson: p.related_handles_json
      }, { fetchImpl: deps.fetchImpl, articles: deps.articles, copy: deps.copy });
      if ('error' in ensured) {
        for (const r of queuedRows) await store.markSyndication(p.id, r.channel, { error: ensured.error });
      } else {
        pack = ensured.pack;
      }
    }

    // 3) Auto-fire queued rows on auto channels (attempt-capped; manual
    //    channels wait for the console click; fire:false skips this stage).
    if (pack && blotato && fire) {
      for (const r of queuedRows) {
        const k = r.channel as SyndicateChannelKey;
        if (!syn.channels[k]?.enabled || !syn.channels[k]?.auto || r.attempts >= SYNDICATION_MAX_AUTO_ATTEMPTS) continue;
        const sent = await sendChannel(store, syn, blotato, p.id, k, pack, r.attempts);
        if (sent.ok) out.posted++; else out.failed++;
      }
    }

    // 4) Confirm accepted submissions.
    if (blotato) {
      for (const r of rows.filter((x) => x.status === 'sent' && x.external_id)) {
        const st = await blotato.pollStatus(r.external_id as string);
        if (!st || st.status === 'in-progress') continue;
        if (st.status === 'published') {
          await store.markSyndication(p.id, r.channel, { status: 'published', error: null });
          out.confirmed++;
        } else {
          await store.markSyndication(p.id, r.channel, { status: 'failed', error: st.errorMessage ?? 'Blotato reports the post failed' });
          out.failed++;
        }
      }
    }
  }
  return out;
}

/** 15-min cron lane. Fully dormant per shop until a channel is enabled: a
 * disabled shop costs one config read (same contract as runProfitAgentSweep). */
export async function runSyndicationSweep(env: Env): Promise<void> {
  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      const cfg = await store.getConfig();
      if (!cfg?.syndicate || !anyChannelEnabled(cfg.syndicate)) continue;
      const r = await runSyndicationForShop(env, store, cfg);
      if (r.queued || r.posted || r.confirmed || r.failed) {
        console.log(`syndication ${shop}: ${r.queued} queued, ${r.posted} posted, ${r.confirmed} confirmed, ${r.failed} failed`);
      }
    } catch (e) { console.warn(`syndication sweep failed for ${shop}: ${(e as Error).message}`); }
  }
}
