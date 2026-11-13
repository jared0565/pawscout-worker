// The self-updating menu builder (spec 5.2): newest model per family, grouped by
// the owner's provider list. Every expected value below was produced by running
// the spec's rules over the real 2026-11-13 feed and its trimmed fixture, which
// gave identical menus.
import { describe, it, expect } from 'vitest';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { reduceFeed } from '../src/models-feed';
import { buildMenu, isMenuCandidate, familyKey, effectiveMenu, DEFAULT_MENU_PROVIDERS, type MenuGroup } from '../src/model-menu';

const NOW = Date.parse('2026-11-13T12:00:00Z') / 1000;
const feed = reduceFeed(feedJson);
const slugs = (g: MenuGroup[], p: string) => g.find((x) => x.provider === p)?.entries.map((e) => e.slug) ?? [];

describe('buildMenu', () => {
  it('Anthropic is exactly the four newest families, newest first', () => {
    expect(slugs(buildMenu(feed, undefined, NOW), 'anthropic')).toEqual([
      'anthropic/claude-fable-5.2', 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']);
  });

  it('caps a provider at 6 families', () => {
    const g = buildMenu(feed, undefined, NOW);
    expect(slugs(g, 'openai')).toEqual(['openai/gpt-6.1-terra-pro', 'openai/gpt-6.1-terra', 'openai/gpt-6.1-sol-pro',
      'openai/gpt-6.1-sol', 'openai/gpt-6-luna-pro', 'openai/gpt-6-luna']); // gpt-6-astra cut by the cap
    expect(slugs(g, 'qwen')).toHaveLength(6);
    expect(slugs(g, 'qwen')).not.toContain('qwen/qwen3.7-plus');
  });

  it('drops variants, aliases, routers and non-text outputs', () => {
    const all = buildMenu(feed, undefined, NOW).flatMap((g) => g.entries.map((e) => e.slug));
    for (const s of ['anthropic/claude-sonnet-4.6', 'anthropic/claude-fable-5.2:batch', 'openrouter/auto', '~anthropic/claude-sonnet-latest',
      'google/lyria-3-pro-preview', 'google/gemini-nano-banana-2.1', 'google/gemini-omni-1.2-flash', 'deepseek/deepseek-v4.1-flash-1017',
      'z-ai/glm-5.3-flashx-legal', 'google/gemini-3.1-pro-preview-customtools']) expect(all).not.toContain(s);
    expect(all).toContain('qwen/qwen3.8-omni-flash'); // omni name, text output: kept
    expect(slugs(buildMenu(feed, undefined, NOW), 'mistralai')).toEqual(['mistralai/mistral-large-4-0']);
  });

  it('a provider with only stale families keeps its single newest', () => {
    expect(slugs(buildMenu(feed, { providers: ['meta-llama'], pins: [], hides: [] }, NOW), 'meta-llama'))
      .toEqual(['meta-llama/llama-4-maverick']);
  });

  it('groups follow the provider list order', () => {
    expect(buildMenu(feed, { providers: ['x-ai', 'anthropic'], pins: [], hides: [] }, NOW).map((g) => g.provider))
      .toEqual(['x-ai', 'anthropic']);
  });

  it('hides remove, pins add (pin wins), a missing pin is unavailable', () => {
    const g = buildMenu(feed, { providers: ['anthropic'], hides: ['anthropic/claude-opus-5.5', 'openai/gpt-5.6-luna'],
      pins: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.6-luna', 'openai/gone-1'] }, NOW);
    expect(slugs(g, 'anthropic')).not.toContain('anthropic/claude-opus-5.5');
    expect(g.find((x) => x.provider === 'anthropic')!.entries.find((e) => e.slug === 'anthropic/claude-sonnet-4.6')!.pinned).toBe(true);
    expect(g.map((x) => x.provider)).toEqual(['anthropic', 'openai']); // unlisted provider: its own group, after the listed ones
    const oa = g.find((x) => x.provider === 'openai')!.entries;
    expect(oa.map((e) => [e.slug, e.available])).toEqual([['openai/gpt-5.6-luna', true], ['openai/gone-1', false]]);
  });

  it('entries carry vision, prices, retirement and efforts', () => {
    const g = buildMenu(feed, { providers: ['z-ai', 'mistralai'], pins: ['openai/gpt-5-mini'], hides: [] }, NOW);
    const entry = (slug: string) => g.flatMap((x) => x.entries).find((e) => e.slug === slug)!;
    expect(entry('openai/gpt-5-mini')).toMatchObject({ retiresOn: '2026-12-11', vision: true, pinned: true, available: true });
    expect(entry('z-ai/glm-5.3').vision).toBe(false);
    expect(entry('mistralai/mistral-large-4-0')).toMatchObject({
      provider: 'mistralai', promptPriceM: 0.7, completionPriceM: 2.1, efforts: ['high', 'none'], defaultEffort: 'high', pinned: false,
    });
  });

  it('an empty feed yields only pins, all unavailable', () => {
    expect(buildMenu([], { providers: ['anthropic'], pins: ['a/b'], hides: [] }, NOW))
      .toEqual([{ provider: 'a', entries: [expect.objectContaining({ slug: 'a/b', available: false, efforts: [] })] }]);
  });
});

describe('menu rules', () => {
  it('the dated-snapshot rule drops only snapshots whose undated alias is listed', () => {
    const ids = new Set(feed.map((m) => m.id));
    const by = (id: string) => feed.find((m) => m.id === id)!;
    expect(isMenuCandidate(by('deepseek/deepseek-v4.1-flash-1017'), ids)).toBe(false);
    expect(isMenuCandidate(by('mistralai/mistral-small-2603'), ids)).toBe(true); // later dropped as stale, not here
  });

  it('family key strips versions and -preview', () => {
    expect(familyKey('anthropic/claude-sonnet-4.6')).toBe(familyKey('anthropic/claude-sonnet-5.5'));
    expect(familyKey('google/gemini-3.1-pro-preview')).toBe('google/gemini-pro');
    expect(familyKey('openai/gpt-6.1-terra')).not.toBe(familyKey('openai/gpt-6.1-terra-pro'));
  });

  it('effectiveMenu fills the defaults', () => {
    expect(effectiveMenu(undefined)).toEqual({ providers: DEFAULT_MENU_PROVIDERS, pins: [], hides: [] });
    expect(DEFAULT_MENU_PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'qwen', 'moonshotai', 'z-ai', 'minimax', 'mistralai']);
  });
});
