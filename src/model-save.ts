import { SYSTEM_DEFAULT_MODEL } from './llm';
import type { FeedModel } from './models-feed';
import type { ProbeMode, ProbeResult } from './model-probe';
import { EFFORT_LEVELS, type ModelsConfig, type ReasoningEffort } from './types';

/**
 * What POST /api/llm checks before it stores a model selection (spec 5.6,
 * 5.6.1, 5.10). Only a CHANGED slot is checked, so a model or effort that has
 * since left the menu can always stay where it is (and saving the curation
 * threshold alone never touches the feed). A cleared image or text slot runs
 * SYSTEM_DEFAULT_MODEL, so it is checked as a change to that model; a cleared
 * fallback runs nothing and only widens the efforts allowed, so it is not.
 *
 * Order matters: a missing OpenRouter key first (nothing can be tested, so
 * the owner is never asked to confirm a price for a save that cannot happen),
 * then refusals, then the price confirmation, then the live tests, so a
 * cancelled save spends nothing.
 */

export type SlotName = 'image' | 'text' | 'fallback';
export const COST_CONFIRM_RATIO = 3;

/** The share of the shop's tokens that are input, from its own llm_usage
 *  (spec 5.11): prices are weighted by it, so a model is compared by what it
 *  would cost this shop, not by the plain sum of its two list prices. */
export interface UsageMix { promptShare: number }
/** How far back the mix reads. */
export const MIX_WINDOW_DAYS = 30;
/** Less history than this is no mix: the list prices are compared instead
 *  (production had about 5.6 million tokens in the 30 days to 2026-11-13). */
export const MIN_MIX_TOKENS = 100_000;

export function usageMix(promptTokens: number, completionTokens: number): UsageMix | null {
  const total = promptTokens + completionTokens;
  return total >= MIN_MIX_TOKENS ? { promptShare: promptTokens / total } : null;
}

/** An effort change held for confirmation: the slot will think more than it
 *  did. A level is null when it cannot be read (the old model is not in the
 *  feed, or lists efforts with no default). */
export interface HeldEffort {
  from: string | null;
  /** The old level was the model's own default (no effort chosen). */
  fromDefault: boolean;
  to: string;
  /** The new level is the model's own default (no effort chosen). */
  toDefault: boolean;
}

export interface HeldSlot {
  /** model: the new model costs more than 3x (or cannot be compared).
   *  effort: the slot will run at a higher reasoning effort (spec 5.11). */
  kind: 'model' | 'effort';
  slot: SlotName;
  slug: string;
  name: string;
  /** New cost over current cost; null when the current price is unknown or free. */
  ratio: number | null;
  promptPriceM: number | null;
  completionPriceM: number | null;
  /** Image or text slot cleared: it will run SYSTEM_DEFAULT_MODEL, which is the
   *  model held here. */
  cleared: boolean;
  /** Fallback set where none was: there is no current fallback, so the ratio
   *  is measured against SYSTEM_DEFAULT_MODEL. */
  newFallback: boolean;
  /** Set when kind is 'effort'. */
  effort?: HeldEffort;
  /** Kind 'model': 'usage' when the ratio weighs the two prices by the shop's
   *  own token mix (spec 5.11), 'list' when there was too little history and
   *  the plain list prices were compared. */
  basis?: 'usage' | 'list';
}

export type ProbeFn = (model: FeedModel, mode: ProbeMode, effort: ReasoningEffort | undefined) => Promise<ProbeResult>;

export type SaveCheck =
  | { ok: true }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; held: HeldSlot[] };

const SLOTS: SlotName[] = ['image', 'text', 'fallback'];
const EFFORT_KEY = { image: 'imageEffort', text: 'textEffort' } as const;
const LABEL = { image: 'Image', text: 'Text' } as const;

/** The efforts a slot can run: its model's, intersected with the fallback's,
 *  because the fallback runs at the effort of the slot it backs. A model that
 *  lists none allows only "Model default". */
export function allowedEfforts(model: FeedModel, fallback: FeedModel | null): string[] {
  return EFFORT_LEVELS.filter((e) => model.efforts.includes(e) && (!fallback || fallback.efforts.includes(e)));
}

const bad = (error: string): SaveCheck => ({ ok: false, status: 400, error });

/** A model's cost per million tokens at a given input share; null when a
 *  price is unknown. At an even share the ratio between two models is the
 *  ratio of their summed list prices, the rule before spec 5.11. */
function weightedCost(m: FeedModel, promptShare: number): number | null {
  if (m.promptPriceM === null || m.completionPriceM === null) return null;
  return m.promptPriceM * promptShare + m.completionPriceM * (1 - promptShare);
}

/** Effort levels from least thinking (none, 0) to most (max, 6). */
const RANK = new Map<string, number>([...EFFORT_LEVELS].reverse().map((e, i) => [e, i]));

/** The effort a slot runs at: the chosen one, else its model's default; 'none'
 *  for a model that takes no effort (it does not think); null when it cannot
 *  be read (the model is not in the feed, or lists no usable default). */
function runsAt(models: ModelsConfig, s: 'image' | 'text', byId: Map<string, FeedModel>): { level: string | null; isDefault: boolean } {
  const chosen = models[EFFORT_KEY[s]];
  if (chosen) return { level: chosen, isDefault: false };
  const m = byId.get(models[s] || SYSTEM_DEFAULT_MODEL);
  if (!m) return { level: null, isDefault: true };
  if (!m.efforts.length) return { level: 'none', isDefault: true };
  return { level: m.defaultEffort !== null && RANK.has(m.defaultEffort) ? m.defaultEffort : null, isDefault: true };
}

export async function checkModelSave(input: {
  stored: ModelsConfig;
  requested: ModelsConfig;
  loadFeed: () => Promise<FeedModel[] | null>;
  confirmCost: boolean;
  probe: ProbeFn | null;
  /** The shop's token mix (usageMix); read only when a model changes. Absent
   *  or null: the list prices are compared. */
  loadMix?: () => Promise<UsageMix | null>;
}): Promise<SaveCheck> {
  const { stored, requested } = input;

  // 1. Which slots changed, and what each changed slot will run.
  const modelChanged = (s: SlotName) => (requested[s] || '') !== (stored[s] || '');
  const effortChanged = (s: 'image' | 'text') => (requested[EFFORT_KEY[s]] ?? '') !== (stored[EFFORT_KEY[s]] ?? '');
  const runs: Partial<Record<SlotName, string>> = {};
  for (const s of ['image', 'text'] as const) {
    if (modelChanged(s) || effortChanged(s)) runs[s] = requested[s] || SYSTEM_DEFAULT_MODEL;
  }
  const fallbackChanged = modelChanged('fallback') && !!requested.fallback;
  if (fallbackChanged) runs.fallback = requested.fallback;
  const changed = SLOTS.filter((s) => runs[s] !== undefined);
  if (changed.length === 0) return { ok: true };

  // 2. Every change needs a live test, and the tests need our OpenRouter key.
  if (!input.probe) return bad('No OpenRouter key is configured, so new models cannot be tested.');

  // 3. One feed read for the whole save.
  const feed = await input.loadFeed();
  if (!feed) return bad('Cannot verify new models right now; try again shortly.');
  const byId = new Map(feed.map((m) => [m.id, m]));

  // 4. Every changed slot must name a real, specific, capable model.
  for (const s of changed) {
    const slug = runs[s]!;
    if (slug.startsWith('~')) return bad(`${s} model ${slug} is a floating "-latest" alias; pick a specific model instead.`);
    const m = byId.get(slug);
    if (!m) return bad(`${s} model ${slug} is not offered by OpenRouter`);
    if (s !== 'text' && !m.inputs.includes('image')) return bad('Image and Fallback must be vision-capable models');
  }

  // 5. An effort must run on the slot's model and on the fallback behind it. A
  //    model no longer in the feed (only possible for an unchanged one) cannot
  //    be checked here; the model watch reports it instead.
  const fallbackModel = requested.fallback ? byId.get(requested.fallback) ?? null : null;
  for (const s of ['image', 'text'] as const) {
    const effort = requested[EFFORT_KEY[s]];
    if (!effort || (runs[s] === undefined && !fallbackChanged)) continue;
    const own = byId.get(requested[s] || SYSTEM_DEFAULT_MODEL);
    if (own && !own.efforts.includes(effort)) return bad(`${LABEL[s]} effort "${effort}" is not offered by ${own.id}.`);
    if (fallbackModel && !fallbackModel.efforts.includes(effort)) {
      return bad(`${LABEL[s]} effort "${effort}" is not offered by the fallback model ${fallbackModel.id}.`);
    }
  }

  // 6. Price. A model change more than 3x as expensive is held; so is a slot
  //    that will run at a higher reasoning effort than it did (spec 5.11),
  //    since thinking is billed as output tokens. A lower effort never is.
  const held: HeldSlot[] = [];
  // Prices are weighted by the shop's own mix of input and output tokens, read
  // once and only when a model changes; with too little history, an even
  // weighting compares the summed list prices instead.
  const mix = changed.some((s) => modelChanged(s)) && input.loadMix ? await input.loadMix() : null;
  const promptShare = mix ? mix.promptShare : 0.5;
  for (const s of changed) {
    const next = byId.get(runs[s]!)!;
    if (modelChanged(s)) {
      const base = byId.get(stored[s] || SYSTEM_DEFAULT_MODEL);
      const baseCost = base ? weightedCost(base, promptShare) : null;
      const nextCost = weightedCost(next, promptShare);
      const ratio = baseCost !== null && baseCost > 0 && nextCost !== null ? Math.round((nextCost / baseCost) * 100) / 100 : null;
      if (ratio === null || ratio > COST_CONFIRM_RATIO) {
        held.push({
          kind: 'model', slot: s, slug: next.id, name: next.name, ratio, promptPriceM: next.promptPriceM, completionPriceM: next.completionPriceM,
          cleared: s !== 'fallback' && !requested[s],
          newFallback: s === 'fallback' && !stored.fallback,
          basis: mix ? 'usage' : 'list',
        });
      }
    }
    if (s === 'fallback') continue; // the fallback runs at the effort of the slot it backs
    const before = runsAt(stored, s, byId);
    const after = runsAt(requested, s, byId);
    // From a level that cannot be read, only an effort the owner chose counts
    // as a raise: a model's own default there is not evidence of more thinking.
    const raised = after.level !== null && after.level !== 'none'
      && (before.level === null ? !after.isDefault : RANK.get(after.level)! > RANK.get(before.level)!);
    if (raised) {
      held.push({
        kind: 'effort', slot: s, slug: next.id, name: next.name, ratio: null,
        promptPriceM: next.promptPriceM, completionPriceM: next.completionPriceM, cleared: false, newFallback: false,
        effort: { from: before.level, fromDefault: before.isDefault, to: after.level!, toDefault: after.isDefault },
      });
    }
  }
  if (held.length > 0 && !input.confirmCost) return { ok: false, status: 409, held };

  // 7. The tests, one per model, mode and effort, in slot order.
  const tests = new Map<string, { slot: SlotName; model: FeedModel; mode: ProbeMode; effort: ReasoningEffort | undefined }>();
  const add = (slot: SlotName, model: FeedModel | null | undefined, mode: ProbeMode, effort: ReasoningEffort | undefined) => {
    if (!model) return;
    const key = `${model.id}|${mode}|${effort ?? ''}`;
    if (!tests.has(key)) tests.set(key, { slot, model, mode, effort });
  };
  for (const s of ['image', 'text'] as const) {
    if (runs[s] === undefined) continue;
    const effort = requested[EFFORT_KEY[s]];
    add(s, byId.get(runs[s]!), s === 'image' ? 'vision' : 'text', effort);
    if (effortChanged(s)) add('fallback', fallbackModel, 'vision', effort);
  }
  if (fallbackChanged) {
    add('fallback', fallbackModel, 'vision', requested.imageEffort);
    add('fallback', fallbackModel, 'vision', requested.textEffort);
  }

  // 8. Run them together; report the first failure in slot order.
  const list = [...tests.values()];
  const results = await Promise.all(list.map((t) => input.probe!(t.model, t.mode, t.effort)));
  for (const s of SLOTS) {
    const i = list.findIndex((t, j) => t.slot === s && !results[j].ok);
    if (i >= 0) {
      const r = results[i];
      return bad(`${s} model failed its live test: ${r.ok ? '' : r.reason}`);
    }
  }
  return { ok: true };
}
