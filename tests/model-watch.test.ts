// The daily watch over the models PawScout runs (spec 5.7, 5.10): a selected
// model that OpenRouter is retiring or has delisted, the system SEARCH_MODEL,
// and a stored effort a model has stopped listing. Each issue emails the owner
// once; a failed send is retried the next day, and an issue that clears and
// comes back alerts again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { reduceFeed } from '../src/models-feed';
import { modelState, selectedStatus, runModelWatch, WATCH_ALERT_KEY } from '../src/model-watch';
import { DAILY_SHOP_STAGES } from '../src/jobs';
import type { AlertResult } from '../src/owner-alert';
import type { ModelsConfig } from '../src/types';

const feed = reduceFeed(feedJson);
const NOW = Date.parse('2026-11-13T12:00:00Z');
const MINI = 'openai/gpt-5-mini';
const LUNA = 'openai/gpt-5.6-luna';
const FABLE = 'anthropic/claude-fable-5.2';
const MISTRAL = 'mistralai/mistral-large-4-0';
const SEARCH_OK = 'anthropic/claude-haiku-5.5';
const SYSTEM_DEFAULT = 'google/gemini-3.1-pro-preview';
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

let mem: Map<string, string>;
let store: { getSearchCache: (k: string) => Promise<string | null>; putSearchCache: (k: string, p: string) => Promise<void> };
let send: ReturnType<typeof vi.fn<(subject: string, text: string) => Promise<AlertResult>>>;

beforeEach(() => {
  mem = new Map();
  store = { getSearchCache: async (k) => mem.get(k) ?? null, putSearchCache: async (k, p) => { mem.set(k, p); } };
  send = vi.fn(async () => 'sent' as AlertResult);
});

const run = (models: ModelsConfig, searchModel = SEARCH_OK) => runModelWatch(store, models, searchModel, feed, NOW, send);
const sent = () => send.mock.calls.map(([subject, text]) => ({ subject, text }));

describe('modelState', () => {
  it('gpt-5-mini is retiring on 2026-12-11; Luna is ok; an unknown slug is delisted', () => {
    expect(modelState(MINI, feed, NOW)).toEqual({ state: 'retiring', retiresOn: '2026-12-11' });
    expect(modelState(LUNA, feed, NOW).state).toBe('ok');
    expect(modelState('openai/gone', feed, NOW)).toEqual({ state: 'delisted', retiresOn: null });
    expect(modelState(MINI, feed, Date.parse('2026-11-01T00:00:00Z')).state).toBe('ok'); // 40 days out
  });

  // A feed cached before reduceFeed normalised dates can still hold a full
  // timestamp for up to a day.
  it('reads a retirement date given as a full timestamp', () => {
    const row = { ...feed.find((m) => m.id === LUNA)!, expiresOn: '2026-12-01T00:00:00Z' };
    expect(modelState(LUNA, [row], NOW)).toEqual({ state: 'retiring', retiresOn: '2026-12-01' });
  });
});

describe('selectedStatus', () => {
  // Deferred minor (final review 2026-11-13): a blank image or text slot runs
  // SYSTEM_DEFAULT_MODEL, so it is watched as that model even with no effort set.
  // A blank fallback runs nothing and stays out.
  it('covers every set slot, and a blank image or text slot as the system default it runs', () => {
    const row = feed.find((m) => m.id === MINI)!;
    const def = feed.find((m) => m.id === SYSTEM_DEFAULT)!;
    expect(selectedStatus({ text: MINI }, feed, NOW)).toEqual({
      image: { slug: SYSTEM_DEFAULT, state: 'ok', retiresOn: null, efforts: def.efforts, defaultEffort: def.defaultEffort, effortSupported: true, systemDefault: true },
      text: { slug: MINI, state: 'retiring', retiresOn: '2026-12-11', efforts: row.efforts, defaultEffort: row.defaultEffort, effortSupported: true, systemDefault: false },
    });
  });

  it('flags a stored effort the model no longer offers', () => {
    expect(selectedStatus({ text: MISTRAL, textEffort: 'medium' }, feed, NOW).text!.effortSupported).toBe(false);
  });

  it('flags a stored effort the fallback does not offer, but not when the fallback is delisted', () => {
    expect(selectedStatus({ text: FABLE, textEffort: 'medium', fallback: MISTRAL }, feed, NOW).text!.effortSupported).toBe(false);
    expect(selectedStatus({ text: FABLE, textEffort: 'medium', fallback: 'openai/gone' }, feed, NOW).text!.effortSupported).toBe(true);
  });

  it('a blank slot with an effort is watched on the model it runs, SYSTEM_DEFAULT_MODEL', () => {
    const s = selectedStatus({ textEffort: 'max' }, feed, NOW);
    expect(s.text).toMatchObject({ slug: SYSTEM_DEFAULT, effortSupported: false, systemDefault: true });
    expect(s.image).toMatchObject({ slug: SYSTEM_DEFAULT, effortSupported: true, systemDefault: true });
    expect(s.fallback).toBeUndefined();
  });
});

describe('runModelWatch', () => {
  it('alerts once per (slug, state)', async () => {
    expect(await run({ text: MINI })).toBe(1);
    expect(sent()[0].subject).toBe('PawScout: AI model openai/gpt-5-mini is retiring on 2026-12-11');
    expect(sent()[0].text).toContain('Open Settings > AI models and pick a replacement.');
    expect(await run({ text: MINI })).toBe(0);
  });

  it('a cleared issue that returns alerts again', async () => {
    expect(await run({ text: MINI })).toBe(1);
    expect(await run({ text: LUNA })).toBe(0);
    expect(await run({ text: MINI })).toBe(1);
  });

  it('a failed send is retried next run', async () => {
    send.mockResolvedValueOnce('failed');
    expect(await run({ text: MINI })).toBe(1);
    expect(await run({ text: MINI })).toBe(1);
    expect(await run({ text: MINI })).toBe(0);
  });

  // Deferred minor (final review 2026-11-13), reversing the Task 8 ruling: an
  // alert address set up later must still hear about an issue that already exists.
  it('an unconfigured mailer is asked again each run, until a send goes through', async () => {
    send.mockResolvedValue('unconfigured');
    expect(await run({ text: MINI })).toBe(1);
    expect(await run({ text: MINI })).toBe(1);
    send.mockResolvedValue('sent');
    expect(await run({ text: MINI })).toBe(1);
    expect(await run({ text: MINI })).toBe(0);
  });

  it('a corrupt remembered set counts as empty', async () => {
    mem.set(WATCH_ALERT_KEY, 'not json');
    expect(await run({ text: MINI })).toBe(1);
    expect(JSON.parse(mem.get(WATCH_ALERT_KEY)!)).toEqual(['model|openai/gpt-5-mini|retiring']);
  });

  it('one email per slug, naming every slot it fills', async () => {
    expect(await run({ image: 'openai/gone', fallback: 'openai/gone' })).toBe(1);
    expect(sent()[0].subject).toBe('PawScout: AI model openai/gone is no longer offered by OpenRouter');
    expect(sent()[0].text).toContain('image and fallback');
  });

  it('blank slots running a retiring system default alert once, and the email says they are blank', async () => {
    const soon = feed.map((m) => (m.id === SYSTEM_DEFAULT ? { ...m, expiresOn: '2026-11-30' } : m));
    expect(await runModelWatch(store, {}, SEARCH_OK, soon, NOW, send)).toBe(1);
    expect(sent()[0].subject).toBe(`PawScout: AI model ${SYSTEM_DEFAULT} is retiring on 2026-11-30`);
    expect(sent()[0].text).toContain('The image and text slots are left blank, so PawScout runs it there as the system default.');
    expect(sent()[0].text).toContain('Open Settings > AI models and pick a replacement.');
    // A slot set to the same model by name is named as chosen, not as blank.
    send.mockClear();
    mem.clear();
    expect(await runModelWatch(store, { text: SYSTEM_DEFAULT }, SEARCH_OK, soon, NOW, send)).toBe(1);
    expect(sent()[0].text).toContain('PawScout runs it in the text slot. The image slot is left blank, so PawScout runs it there as the system default.');
  });

  it('the search model alert says a code change is needed', async () => {
    expect(await run({}, 'anthropic/gone')).toBe(1);
    expect(sent()[0].text).toContain('code change');
    expect(sent()[0].text).not.toContain('pick a replacement');
  });

  it('an unsupported effort alerts once', async () => {
    expect(await run({ text: MISTRAL, textEffort: 'medium' })).toBe(1);
    expect(sent()[0].subject).toBe('PawScout: the text effort "medium" is no longer offered');
    expect(sent()[0].text).toContain('OpenRouter may reject these calls outright, with no fallback. Open Settings > AI models and pick another effort.');
    expect(await run({ text: MISTRAL, textEffort: 'medium' })).toBe(0);
  });

  it('a healthy selection sends nothing', async () => {
    expect(await run({ image: LUNA, text: LUNA, fallback: SEARCH_OK, textEffort: 'high' })).toBe(0);
  });

  it('no email copy carries a dash', async () => {
    await run({ image: 'openai/gone', text: MISTRAL, textEffort: 'medium', fallback: MINI }, 'anthropic/gone');
    expect(send.mock.calls.length).toBeGreaterThan(2);
    for (const { subject, text } of sent()) expect(DASHES.test(subject + text)).toBe(false);
  });
});

describe('daily stage', () => {
  it('the daily chain runs model-watch without needing CJ, right after order-webhooks', () => {
    const names = DAILY_SHOP_STAGES.map((s) => s.name);
    expect(names.indexOf('model-watch')).toBe(names.indexOf('order-webhooks') + 1);
    expect(DAILY_SHOP_STAGES.find((x) => x.name === 'model-watch')?.needsCj).toBe(false);
  });
});
