import { SYSTEM_DEFAULT_MODEL } from './llm';
import type { FeedModel } from './models-feed';
import type { SlotName } from './model-save';
import type { AlertResult } from './owner-alert';
import type { TenantStore } from './tenant-store';
import type { ModelsConfig } from './types';

/**
 * The daily watch over the models PawScout runs (spec 5.7, 5.10). A selected
 * model OpenRouter is retiring within 30 days or no longer lists, the system
 * SEARCH_MODEL in the same states, and a stored reasoning effort the slot's
 * model (or its fallback) has stopped listing: each emails the owner once.
 * An unsupported effort matters more than it looks: OpenRouter may answer it
 * with a 400, which LlmClient treats as final, so the fallback never runs.
 */

export type WatchState = 'ok' | 'retiring' | 'delisted';

export interface SlotStatus {
  slug: string;
  state: WatchState;
  retiresOn: string | null;
  /** From the feed, for the console's effort select. */
  efforts: string[];
  defaultEffort: string | null;
  /** Image and text only: false when the stored effort is no longer offered. */
  effortSupported: boolean;
  /** The slot is blank, so it runs SYSTEM_DEFAULT_MODEL (the slug above). */
  systemDefault: boolean;
}

export const RETIRE_WARN_DAYS = 30;
export const WATCH_ALERT_KEY = 'modelwatch:alerted';
export const WATCH_ALERT_TTL_DAYS = 90;

const SLOTS: SlotName[] = ['image', 'text', 'fallback'];
const EFFORT_KEY = { image: 'imageEffort', text: 'textEffort' } as const;
const DAY_MS = 86_400_000;

export function modelState(slug: string, feed: FeedModel[], nowMs: number): { state: WatchState; retiresOn: string | null } {
  const m = feed.find((x) => x.id === slug);
  if (!m) return { state: 'delisted', retiresOn: null };
  // reduceFeed stores YYYY-MM-DD, but a feed cached before it did can still
  // hold a full timestamp for up to a day: read only the date part.
  const day = m.expiresOn ? m.expiresOn.slice(0, 10) : null;
  const ends = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (Number.isFinite(ends) && ends - nowMs <= RETIRE_WARN_DAYS * DAY_MS) return { state: 'retiring', retiresOn: day };
  return { state: 'ok', retiresOn: null };
}

/** The model a slot runs: its own, or SYSTEM_DEFAULT_MODEL when blank. */
const slotSlug = (models: ModelsConfig, s: 'image' | 'text') => models[s] || SYSTEM_DEFAULT_MODEL;

/** The model that no longer offers the slot's stored effort, or null. A model
 *  missing from the feed is not judged here: the delisted state covers it. */
function effortGap(models: ModelsConfig, feed: FeedModel[], s: 'image' | 'text'): string | null {
  const effort = models[EFFORT_KEY[s]];
  if (!effort) return null;
  const own = feed.find((x) => x.id === slotSlug(models, s));
  if (own && !own.efforts.includes(effort)) return own.id;
  const fb = models.fallback ? feed.find((x) => x.id === models.fallback) : undefined;
  if (fb && !fb.efforts.includes(effort)) return fb.id;
  return null;
}

/** Status of every slot that runs a model: a set model, and a blank image or
 *  text slot as SYSTEM_DEFAULT_MODEL, which is what it runs (with or without an
 *  effort). A blank fallback runs nothing, so it has no status. */
export function selectedStatus(models: ModelsConfig, feed: FeedModel[], nowMs: number): Partial<Record<SlotName, SlotStatus>> {
  const out: Partial<Record<SlotName, SlotStatus>> = {};
  for (const s of SLOTS) {
    const blank = s !== 'fallback' && !models[s];
    const slug = s === 'fallback' ? models.fallback : slotSlug(models, s);
    if (!slug) continue;
    const row = feed.find((x) => x.id === slug);
    out[s] = {
      slug,
      ...modelState(slug, feed, nowMs),
      efforts: row?.efforts ?? [],
      defaultEffort: row?.defaultEffort ?? null,
      effortSupported: s === 'fallback' || effortGap(models, feed, s) === null,
      systemDefault: blank,
    };
  }
  return out;
}

const slotList = (slots: SlotName[]) =>
  slots.length === 1 ? `the ${slots[0]} slot` : `the ${slots.slice(0, -1).join(', ')} and ${slots[slots.length - 1]} slots`;

interface Issue { key: string; subject: string; text: string }

function currentIssues(models: ModelsConfig, searchModel: string, feed: FeedModel[], nowMs: number): Issue[] {
  const status = selectedStatus(models, feed, nowMs);
  // slots: set to this model by name; blank: left blank, so running it as the
  // system default. Both are the owner's to change in Settings.
  const groups = new Map<string, { state: WatchState; retiresOn: string | null; slots: SlotName[]; blank: SlotName[]; search: boolean }>();
  const group = (slug: string, st: { state: WatchState; retiresOn: string | null }) => {
    const g = groups.get(slug) ?? { state: st.state, retiresOn: st.retiresOn, slots: [], blank: [], search: false };
    groups.set(slug, g);
    return g;
  };
  for (const s of SLOTS) {
    const st = status[s];
    if (st && st.state !== 'ok') {
      const g = group(st.slug, st);
      (st.systemDefault ? g.blank : g.slots).push(s);
    }
  }
  const search = modelState(searchModel, feed, nowMs);
  if (search.state !== 'ok') group(searchModel, search).search = true;

  const issues: Issue[] = [];
  for (const [slug, g] of groups) {
    const delisted = g.state === 'delisted';
    const lines = [delisted ? `OpenRouter no longer lists ${slug}.` : `OpenRouter is retiring ${slug} on ${g.retiresOn}.`];
    const owner: string[] = [];
    if (g.slots.length) owner.push(`PawScout runs it in ${slotList(g.slots)}.`);
    if (g.blank.length) {
      const list = slotList(g.blank);
      owner.push(`${list[0].toUpperCase()}${list.slice(1)} ${g.blank.length === 1 ? 'is' : 'are'} left blank, so PawScout runs it there as the system default.`);
    }
    if (owner.length) lines.push(`${owner.join(' ')} Open Settings > AI models and pick a replacement.`);
    if (g.search) lines.push(`This is PawScout's built-in research model, so replacing it needs a code change.`);
    issues.push({
      key: `model|${slug}|${g.state}`,
      subject: `PawScout: AI model ${slug} is ${delisted ? 'no longer offered by OpenRouter' : `retiring on ${g.retiresOn}`}`,
      text: lines.join('\n\n'),
    });
  }
  for (const s of ['image', 'text'] as const) {
    const gap = effortGap(models, feed, s);
    if (!gap) continue;
    const effort = models[EFFORT_KEY[s]]!;
    const slug = slotSlug(models, s);
    const who = gap === slug ? slug : `its fallback ${gap}`;
    issues.push({
      key: `effort|${s}|${effort}|${slug}`,
      subject: `PawScout: the ${s} effort "${effort}" is no longer offered`,
      text: `The ${s} slot runs ${slug} at the "${effort}" reasoning effort, which ${who} no longer offers.\n\n`
        + 'OpenRouter may reject these calls outright, with no fallback. Open Settings > AI models and pick another effort.',
    });
  }
  return issues;
}

function readRemembered(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Emails each issue not already sent, and returns how many sends it made. An
 *  issue is remembered only once its email is sent: a failed send, or no
 *  alert address configured yet, is tried again the next day, so an address
 *  set up later still hears about an issue that already exists. An issue that
 *  clears is forgotten, so its return alerts again. */
export async function runModelWatch(
  store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>,
  models: ModelsConfig,
  searchModel: string,
  feed: FeedModel[],
  nowMs: number,
  send: (subject: string, text: string) => Promise<AlertResult>,
): Promise<number> {
  const issues = currentIssues(models, searchModel, feed, nowMs);
  const current = new Set(issues.map((i) => i.key));
  const remembered = new Set(readRemembered(await store.getSearchCache(WATCH_ALERT_KEY)));
  const keep = [...remembered].filter((k) => current.has(k));
  let calls = 0;
  for (const issue of issues) {
    if (remembered.has(issue.key)) continue;
    calls++;
    let result: AlertResult;
    try { result = await send(issue.subject, issue.text); } catch { result = 'failed'; }
    if (result === 'sent') keep.push(issue.key);
  }
  await store.putSearchCache(WATCH_ALERT_KEY, JSON.stringify(keep), WATCH_ALERT_TTL_DAYS);
  return calls;
}
