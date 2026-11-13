import { SYSTEM_DEFAULT_MODEL } from './llm';
import { feedCost, type FeedModel } from './models-feed';
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
 * Order matters: refusals first, then the price confirmation, then the live
 * tests, so a cancelled save spends nothing.
 */

export type SlotName = 'image' | 'text' | 'fallback';
export const COST_CONFIRM_RATIO = 3;

export interface HeldSlot {
  slot: SlotName;
  slug: string;
  name: string;
  /** New cost over current cost; null when the current price is unknown or free. */
  ratio: number | null;
  promptPriceM: number | null;
  completionPriceM: number | null;
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

export async function checkModelSave(input: {
  stored: ModelsConfig;
  requested: ModelsConfig;
  loadFeed: () => Promise<FeedModel[] | null>;
  confirmCost: boolean;
  probe: ProbeFn | null;
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

  // 2. One feed read for the whole save.
  const feed = await input.loadFeed();
  if (!feed) return bad('Cannot verify new models right now; try again shortly.');
  const byId = new Map(feed.map((m) => [m.id, m]));

  // 3. Every changed slot must name a real, specific, capable model.
  for (const s of changed) {
    const slug = runs[s]!;
    if (slug.startsWith('~')) return bad(`${s} model ${slug} is a floating "-latest" alias; pick a specific model instead.`);
    const m = byId.get(slug);
    if (!m) return bad(`${s} model ${slug} is not offered by OpenRouter`);
    if (s !== 'text' && !m.inputs.includes('image')) return bad('Image and Fallback must be vision-capable models');
  }

  // 4. An effort must run on the slot's model and on the fallback behind it. A
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

  // 5. Price: only a model change, never an effort-only change.
  const held: HeldSlot[] = [];
  for (const s of changed) {
    if (!modelChanged(s)) continue;
    const next = byId.get(runs[s]!)!;
    const base = byId.get(stored[s] || SYSTEM_DEFAULT_MODEL);
    const baseCost = base ? feedCost(base) : null;
    const nextCost = feedCost(next);
    const ratio = baseCost !== null && baseCost > 0 && nextCost !== null ? Math.round((nextCost / baseCost) * 100) / 100 : null;
    if (ratio === null || ratio > COST_CONFIRM_RATIO) {
      held.push({ slot: s, slug: next.id, name: next.name, ratio, promptPriceM: next.promptPriceM, completionPriceM: next.completionPriceM });
    }
  }
  if (held.length > 0 && !input.confirmCost) return { ok: false, status: 409, held };

  // 6. Live tests need our OpenRouter key.
  if (!input.probe) return bad('No OpenRouter key is configured, so new models cannot be tested.');

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
