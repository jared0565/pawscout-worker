/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import type { ScreenVerdict } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('affiliate_applicants store', () => {
  it('upserts, reads, and updates an applicant; scoped per shop', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await s.getApplicantByThread('t1')).toBeNull();

    await s.upsertApplicant({ threadId: 't1', contactEmail: 'jane@x.com', stage: 'screen_sent' });
    let row = await s.getApplicantByThread('t1');
    expect(row?.stage).toBe('screen_sent');
    expect(row?.contact_email).toBe('jane@x.com');
    expect(row?.score).toBeNull();

    // upsert again (same thread) updates stage, keeps one row
    await s.upsertApplicant({ threadId: 't1', contactEmail: 'jane@x.com', stage: 'screen_sent', declaredIntent: 'partnerships' });
    row = await s.getApplicantByThread('t1');
    expect(row?.declared_intent).toBe('partnerships');

    const verdict: ScreenVerdict = { decision: 'form', score: 11, gate: null, signals: { S1: 2 }, reasons: ['strong'] };
    await s.setApplicantStage('t1', 'passed_to_form', verdict);
    row = await s.getApplicantByThread('t1');
    expect(row?.stage).toBe('passed_to_form');
    expect(row?.score).toBe(11);
    expect(JSON.parse(row!.verdict_json!).decision).toBe('form');

    // other shop sees nothing
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getApplicantByThread('t1')).toBeNull();
  });
});
