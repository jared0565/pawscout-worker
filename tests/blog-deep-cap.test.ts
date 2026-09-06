/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { deepResearchBudget, DEEP_RESEARCH_TASK, DEEP_RESEARCH_DAILY_CAP_USD } from '../src/blog/research';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// aramid llm-review c1029563 (2026-09-07): the paid web-search research pass
// (~$0.21 a run) could be triggered by any session that reaches the console
// route, with nothing bounding the spend. A Shopify session token carries no
// role claim, so instead of an owner check the route enforces a per-day spend
// cap on the task's own llm_usage rows, the same shape as the affiliate
// screening cap. The fast, free source is never capped.
describe('deepResearchBudget', () => {
  it('allows deep research while the last 24 hours of web-research spend is under the cap', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    await s.logLlmUsage(DEEP_RESEARCH_TASK, 'm', 100, 100, 0.21);
    await s.logLlmUsage('blog-topics', 'm', 100, 100, 5); // a different task never counts
    const b = await deepResearchBudget(s);
    expect(b.allowed).toBe(true);
    expect(b.spentUsd).toBeCloseTo(0.21, 2);
    expect(b.capUsd).toBe(DEEP_RESEARCH_DAILY_CAP_USD);
  });

  it('refuses once the cap is reached', async () => {
    const s = new TenantStore(env.DB, 'b.myshopify.com');
    for (let i = 0; i < 5; i++) await s.logLlmUsage(DEEP_RESEARCH_TASK, 'm', 100, 100, 0.21);
    const b = await deepResearchBudget(s);
    expect(b.allowed).toBe(false);
    expect(b.spentUsd).toBeGreaterThanOrEqual(DEEP_RESEARCH_DAILY_CAP_USD);
  });

  it('the cap is a real amount (about four runs a day) on the tag only the deep pass writes', () => {
    expect(DEEP_RESEARCH_DAILY_CAP_USD).toBe(1);
    expect(DEEP_RESEARCH_TASK).toBe('blog-demand'); // researchDemand's tag; the fast source logs nothing
  });
});
