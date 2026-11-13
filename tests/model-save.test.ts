// What POST /api/llm checks before it stores a model selection (spec 5.6,
// 5.6.1, 5.10). Untouched slots are never checked, so an old model can always
// stay; a changed slot must be offered, vision-capable where needed, run its
// effort on both its model and the fallback, pass a price confirmation above
// 3x, and pass a live test. A cleared image or text slot counts as a change to
// SYSTEM_DEFAULT_MODEL, because that is what a blank slot runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { reduceFeed, type FeedModel } from '../src/models-feed';
import { checkModelSave, allowedEfforts, type HeldSlot, type ProbeFn, type SaveCheck } from '../src/model-save';
import type { ProbeResult } from '../src/model-probe';
import type { ModelsConfig } from '../src/types';

const feed = reduceFeed(feedJson);
const LUNA = 'openai/gpt-5.6-luna';
const FABLE = 'anthropic/claude-fable-5.2';
const MISTRAL = 'mistralai/mistral-large-4-0';
const HAIKU = 'anthropic/claude-haiku-5.5';
const SYSTEM_DEFAULT = 'google/gemini-3.1-pro-preview';

let probe: ReturnType<typeof vi.fn<ProbeFn>>;
const probeCalls = () => probe.mock.calls.map(([m, mode, effort]) => [m.id, mode, effort]);

beforeEach(() => { probe = vi.fn<ProbeFn>(async () => ({ ok: true }) as ProbeResult); });

function check(stored: ModelsConfig, requested: ModelsConfig, opts: { confirmCost?: boolean; feed?: FeedModel[] | null; noKey?: boolean } = {}): Promise<SaveCheck> {
  return checkModelSave({
    stored, requested, confirmCost: opts.confirmCost ?? false,
    loadFeed: async () => (opts.feed === undefined ? feed : opts.feed),
    probe: opts.noKey ? null : probe,
  });
}
const held = (r: SaveCheck) => (r as { held: HeldSlot[] }).held;

/** A synthetic feed row for the price edge cases. */
function fm(id: string, prompt: number, completion: number): FeedModel {
  return { id, canonicalSlug: null, name: id, created: 1, expiresOn: null, inputs: ['text', 'image'], outputs: ['text'],
    promptPriceM: prompt, completionPriceM: completion, json: true, efforts: [], defaultEffort: null };
}

describe('checkModelSave: what counts as a change', () => {
  it('unchanged slots never load the feed or probe', async () => {
    const loadFeed = vi.fn(async () => null);
    const same = { image: LUNA, text: LUNA, fallback: LUNA, textEffort: 'low' as const };
    expect(await checkModelSave({ stored: same, requested: same, loadFeed, confirmCost: false, probe })).toEqual({ ok: true });
    expect(loadFeed).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('an unchanged effort a model has since dropped still saves', async () => {
    const same = { text: MISTRAL, textEffort: 'medium' as const };
    expect(await check(same, same)).toEqual({ ok: true });
  });

  it('clearing fallback needs no check', async () => {
    const loadFeed = vi.fn(async () => feed);
    expect(await checkModelSave({ stored: { text: LUNA, fallback: LUNA }, requested: { text: LUNA }, loadFeed, confirmCost: false, probe }))
      .toEqual({ ok: true });
    expect(loadFeed).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('clearing text is a change to SYSTEM_DEFAULT_MODEL and is held at about 10x', async () => {
    const r = await check({ text: LUNA }, {});
    expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'text', slug: SYSTEM_DEFAULT, cleared: true, newFallback: false }] });
    expect(held(r)[0].ratio).toBeCloseTo(10, 1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('a confirmed clear of image runs the vision live test on SYSTEM_DEFAULT_MODEL', async () => {
    expect(await check({ image: LUNA }, {}, { confirmCost: true })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([[SYSTEM_DEFAULT, 'vision', undefined]]);
  });
});

describe('checkModelSave: refusals', () => {
  it('feed down refuses only a change', async () => {
    expect(await check({ text: LUNA }, { text: HAIKU }, { feed: null }))
      .toEqual({ ok: false, status: 400, error: 'Cannot verify new models right now; try again shortly.' });
  });

  it('refuses a slug OpenRouter does not list', async () => {
    expect(await check({ text: LUNA }, { text: 'openai/nope' }))
      .toEqual({ ok: false, status: 400, error: 'text model openai/nope is not offered by OpenRouter' });
  });

  it('refuses a floating alias even though the feed lists it', async () => {
    expect(feed.some((m) => m.id === '~anthropic/claude-sonnet-latest')).toBe(true);
    const r = await check({ text: LUNA }, { text: '~anthropic/claude-sonnet-latest' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses a text-only model for image', async () => {
    expect(await check({ image: LUNA }, { image: 'z-ai/glm-5.3' }))
      .toEqual({ ok: false, status: 400, error: 'Image and Fallback must be vision-capable models' });
  });

  it('no OpenRouter key refuses a change', async () => {
    expect(await check({ text: LUNA }, { text: HAIKU }, { noKey: true }))
      .toEqual({ ok: false, status: 400, error: 'No OpenRouter key is configured, so new models cannot be tested.' });
  });

  // Deferred minor (final review 2026-11-13): the owner must never confirm a
  // price only to be told afterwards that nothing can be tested.
  it('no OpenRouter key refuses before any feed read or price hold, and an unchanged save still passes', async () => {
    const loadFeed = vi.fn(async () => feed);
    expect(await checkModelSave({ stored: { text: LUNA }, requested: { text: 'anthropic/claude-opus-5.5' }, loadFeed, confirmCost: false, probe: null }))
      .toEqual({ ok: false, status: 400, error: 'No OpenRouter key is configured, so new models cannot be tested.' });
    expect(loadFeed).not.toHaveBeenCalled();
    expect(await checkModelSave({ stored: { text: LUNA }, requested: { text: LUNA }, loadFeed, confirmCost: false, probe: null })).toEqual({ ok: true });
  });

  it('a failed live test refuses the slot with the reason', async () => {
    probe.mockResolvedValue({ ok: false, reason: 'r' });
    expect(await check({ text: LUNA }, { text: HAIKU }))
      .toEqual({ ok: false, status: 400, error: 'text model failed its live test: r' });
  });
});

describe('checkModelSave: price confirmation', () => {
  it('holds Luna -> Opus at about 17x and does not probe', async () => {
    const r = await check({ text: LUNA }, { text: 'anthropic/claude-opus-5.5' });
    expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'text', slug: 'anthropic/claude-opus-5.5', name: expect.any(String), promptPriceM: 4, completionPriceM: 20, cleared: false, newFallback: false }] });
    expect(held(r)[0].ratio).toBeCloseTo(17.14, 1);
    expect(probe).not.toHaveBeenCalled();
  });

  // Deferred minor: with no fallback set, a new one is priced against the
  // system default, and the hold must say so rather than "your current fallback".
  it('a new fallback where none was set is held against the system default and marked as new', async () => {
    const r = await check({ text: LUNA }, { text: LUNA, fallback: FABLE }); // 48 vs 14 = 3.43x
    expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'fallback', slug: FABLE, cleared: false, newFallback: true }] });
    expect(held(r)[0].ratio).toBeCloseTo(3.43, 2);
    const replaced = await check({ text: LUNA, fallback: HAIKU }, { text: LUNA, fallback: FABLE });
    expect(held(replaced)[0]).toMatchObject({ slot: 'fallback', newFallback: false });
  });

  it('confirmCost lets the held change through to its live test', async () => {
    expect(await check({ text: LUNA }, { text: 'anthropic/claude-opus-5.5' }, { confirmCost: true })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([['anthropic/claude-opus-5.5', 'text', undefined]]);
  });

  it('a cheaper model is not held', async () => {
    expect(await check({ text: LUNA }, { text: HAIKU })).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('exactly 3x is not held', async () => {
    const synthetic = [fm('a/base', 1, 1), fm('a/new', 3, 3)];
    expect(await check({ text: 'a/base' }, { text: 'a/new' }, { feed: synthetic })).toEqual({ ok: true });
  });

  it('a blank slot compares with SYSTEM_DEFAULT_MODEL', async () => {
    expect(await check({}, { text: 'anthropic/claude-opus-5.5' })).toEqual({ ok: true }); // 24 vs 14 = 1.71x
    const r = await check({}, { text: FABLE });                                              // 48 vs 14 = 3.43x
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(held(r)[0].ratio).toBeCloseTo(3.43, 2);
  });

  it('a delisted or free current model holds with ratio null', async () => {
    const delisted = await check({ text: 'openai/gone' }, { text: HAIKU });
    expect(held(delisted)).toEqual([expect.objectContaining({ slot: 'text', slug: HAIKU, ratio: null })]);
    const free = await check({ text: 'a/free' }, { text: 'a/paid' }, { feed: [fm('a/free', 0, 0), fm('a/paid', 1, 1)] });
    expect(held(free)).toEqual([expect.objectContaining({ ratio: null })]);
    expect(JSON.stringify([delisted, free])).not.toMatch(/Infinity|NaN/);
  });
});

describe('checkModelSave: reasoning effort', () => {
  it('offered efforts are the model intersected with the fallback', () => {
    const by = (id: string) => feed.find((m) => m.id === id)!;
    expect(allowedEfforts(by(FABLE), by(MISTRAL))).toEqual(['high']);
    expect(allowedEfforts(by(FABLE), null)).toEqual(['max', 'xhigh', 'high', 'medium', 'low']);
    expect(allowedEfforts(by(LUNA), by('qwen/qwen3.8-flash'))).toEqual([]); // fallback lists none: only the default
  });

  it('an effort-only change is live-tested at that effort and never price-held', async () => {
    expect(await check({ text: LUNA }, { text: LUNA, textEffort: 'high' })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([[LUNA, 'text', 'high']]);
  });

  it('refuses an effort the model does not offer', async () => {
    expect(await check({}, { text: MISTRAL, textEffort: 'medium' }))
      .toEqual({ ok: false, status: 400, error: 'Text effort "medium" is not offered by mistralai/mistral-large-4-0.' });
  });

  it('refuses an effort the fallback does not offer', async () => {
    expect(await check({ fallback: MISTRAL }, { text: FABLE, textEffort: 'medium', fallback: MISTRAL }))
      .toEqual({ ok: false, status: 400, error: 'Text effort "medium" is not offered by the fallback model mistralai/mistral-large-4-0.' });
  });

  it('a changed effort also tests the fallback at that effort', async () => {
    expect(await check({ text: FABLE, fallback: MISTRAL }, { text: FABLE, fallback: MISTRAL, textEffort: 'high' })).toEqual({ ok: true });
    expect(probeCalls()).toEqual(expect.arrayContaining([[FABLE, 'text', 'high'], [MISTRAL, 'vision', 'high']]));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a new fallback is tested at both slot efforts, deduplicated', async () => {
    const stored = { text: LUNA, image: LUNA, textEffort: 'high' as const, imageEffort: 'high' as const };
    expect(await check(stored, { ...stored, fallback: HAIKU })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([[HAIKU, 'vision', 'high']]);
  });

  it('a fallback no longer in the feed neither limits nor blocks an effort change', async () => {
    expect(await check({ text: LUNA, fallback: 'openai/gone' }, { text: LUNA, fallback: 'openai/gone', textEffort: 'low' })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([[LUNA, 'text', 'low']]);
  });
});

describe('checkModelSave: which live tests run', () => {
  it('a model moved into fallback is tested in vision mode, and only there', async () => {
    expect(await check({ text: LUNA }, { text: LUNA, fallback: LUNA })).toEqual({ ok: true });
    expect(probeCalls()).toEqual([[LUNA, 'vision', undefined]]);
  });

  it('the same slug in image and fallback is probed once', async () => {
    expect(await check({}, { image: HAIKU, fallback: HAIKU })).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
