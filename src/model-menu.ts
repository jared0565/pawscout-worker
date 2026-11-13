import type { FeedModel } from './models-feed';
import type { ModelMenuConfig } from './types';

/**
 * The self-updating AI model menu (spec 5.2): from the OpenRouter feed, the
 * newest model in each family of each provider the owner lists, so a new
 * release appears within a day and supersedes its predecessor without a code
 * change. Pure: no I/O, "now" is passed in. The menu only OFFERS models; nothing
 * here can change what a tenant has saved.
 */

/** The four providers the owner named plus six emerging ones with current
 *  releases on 2026-11-13 (spec 5.3). The owner edits the list in Settings. */
export const DEFAULT_MENU_PROVIDERS = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'qwen', 'moonshotai', 'z-ai', 'minimax', 'mistralai'];
/** A family with no release for six months drops off (unless it is all its
 *  provider has, see buildMenu). */
export const MENU_STALE_SECONDS = 183 * 86400;
export const MENU_MAX_PER_PROVIDER = 6;

export interface MenuEntry {
  slug: string;
  name: string;
  provider: string;
  vision: boolean;
  promptPriceM: number | null;     // $ per million input tokens, 3 decimals
  completionPriceM: number | null; // $ per million output tokens, 3 decimals
  created: number | null;
  retiresOn: string | null;
  pinned: boolean;
  available: boolean;              // false: pinned but not in the feed, cannot be newly selected
  efforts: string[];
  defaultEffort: string | null;
}

export interface MenuGroup {
  provider: string;
  entries: MenuEntry[];
}

// Specialised variants that are not general-purpose models, matched as whole
// dash-separated tokens of the name after '/' ('guard' anywhere: llama-guard,
// gpt-oss-safeguard).
const VARIANT = /(?:^|-)(?:legal|code|coder|customtools|multi-agent|exp)(?:-|$)|guard/;
// A dated snapshot (-0613, -202604, -20260409) of a model whose undated name is
// also listed. When no undated alias exists the date IS the model's name
// (mistral-small-2603), so it stays.
const DATED = /^(.*)-(\d{4}|\d{6}|\d{8})$/;

const providerOf = (slug: string) => slug.split('/')[0];
const nameOf = (slug: string) => slug.slice(slug.indexOf('/') + 1);
const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

export function effectiveMenu(menu?: ModelMenuConfig): ModelMenuConfig {
  return menu ?? { providers: DEFAULT_MENU_PROVIDERS, pins: [], hides: [] };
}

/** Spec 5.2 step 2, the variant filter. The provider match is buildMenu's job. */
export function isMenuCandidate(m: FeedModel, ids: Set<string>): boolean {
  if (m.id.includes(':')) return false;                                 // :batch, :free, :thinking, any future suffix
  if (m.outputs.length !== 1 || m.outputs[0] !== 'text') return false; // image, music and video generators
  if (m.promptPriceM === null || m.completionPriceM === null) return false;
  if (m.promptPriceM < 0 || m.completionPriceM < 0) return false;       // routers price at -1
  if (!m.json) return false;                                            // every call is JSON mode
  const name = nameOf(m.id);
  const dated = name.match(DATED);
  if (dated && ids.has(`${providerOf(m.id)}/${dated[1]}`)) return false;
  return !VARIANT.test(name);
}

/** Provider plus the name with version tokens and '-preview' removed, so
 *  claude-sonnet-4.6 and claude-sonnet-5.5 are one family and a general release
 *  supersedes its preview. */
export function familyKey(slug: string): string {
  const name = nameOf(slug)
    .replace(/-preview/g, '')
    .replace(/v?\d+(?:\.\d+)*/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${providerOf(slug)}/${name}`;
}

function toEntry(m: FeedModel, pinned: boolean): MenuEntry {
  return {
    slug: m.id,
    name: m.name,
    provider: providerOf(m.id),
    vision: m.inputs.includes('image'),
    promptPriceM: round3(m.promptPriceM),
    completionPriceM: round3(m.completionPriceM),
    created: m.created,
    retiresOn: m.expiresOn,
    pinned,
    available: true,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
  };
}

function missingPin(slug: string): MenuEntry {
  return {
    slug, name: slug, provider: providerOf(slug), vision: false, promptPriceM: null, completionPriceM: null,
    created: null, retiresOn: null, pinned: true, available: false, efforts: [], defaultEffort: null,
  };
}

/** Newest first, then by slug, so equal release times still order the same way
 *  every day; entries with no release time (missing pins) go last. */
function byNewest(a: MenuEntry, b: MenuEntry): number {
  if (a.created === null || b.created === null) return a.created === null ? (b.created === null ? 0 : 1) : -1;
  return b.created - a.created || a.slug.localeCompare(b.slug);
}

export function buildMenu(feed: FeedModel[], menu: ModelMenuConfig | undefined, nowSec: number): MenuGroup[] {
  const { providers, pins, hides } = effectiveMenu(menu);
  const ids = new Set(feed.map((m) => m.id));
  const groups = new Map<string, MenuEntry[]>();

  for (const provider of providers) {
    const newestPerFamily = new Map<string, FeedModel>();
    for (const m of feed) {
      if (providerOf(m.id) !== provider || !isMenuCandidate(m, ids)) continue;
      const key = familyKey(m.id);
      const held = newestPerFamily.get(key);
      if (!held || m.created > held.created) newestPerFamily.set(key, m);
    }
    const families = [...newestPerFamily.values()].map((m) => toEntry(m, false)).sort(byNewest);
    const fresh = families.filter((e) => (e.created ?? 0) >= nowSec - MENU_STALE_SECONDS);
    // A provider the owner listed never shows an empty group just because it
    // has been quiet: it keeps its single newest family.
    groups.set(provider, (fresh.length ? fresh : families.slice(0, 1)).slice(0, MENU_MAX_PER_PROVIDER));
  }

  const hidden = new Set(hides);
  for (const [provider, entries] of groups) groups.set(provider, entries.filter((e) => !hidden.has(e.slug)));

  // Pins are added after the cap and the hides, so a pin always shows (it wins
  // over a hide of the same slug), and a pinned provider not on the list gets
  // its own group after the listed ones, in pin order.
  for (const slug of pins) {
    const provider = providerOf(slug);
    const entries = groups.get(provider) ?? [];
    const present = entries.find((e) => e.slug === slug);
    if (present) {
      present.pinned = true;
    } else {
      const m = feed.find((f) => f.id === slug);
      entries.push(m ? toEntry(m, true) : missingPin(slug));
      entries.sort(byNewest);
    }
    groups.set(provider, entries);
  }

  return [...groups].filter(([, entries]) => entries.length).map(([provider, entries]) => ({ provider, entries }));
}
