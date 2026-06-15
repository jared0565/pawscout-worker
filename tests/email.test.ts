import { describe, it, expect } from 'vitest';
import { sendEmail } from '../src/email';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

describe('sendEmail', () => {
  it('returns the Resend id on success', async () => {
    const r = await sendEmail('key', { to: 'a@b.com', subject: 'Hi', text: 'hello' }, fakeFetch(200, { id: 'em_123' }));
    expect(r).toEqual({ ok: true, id: 'em_123' });
  });

  it('reports the Resend error message on failure', async () => {
    const r = await sendEmail('key', { to: 'a@b.com', subject: 'Hi', text: 'x' }, fakeFetch(422, { message: 'domain not verified', name: 'validation_error' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('domain not verified');
  });

  it('fails fast when the API key is missing', async () => {
    const r = await sendEmail('', { to: 'a@b.com', subject: 'Hi', text: 'x' }, fakeFetch(200, { id: 'x' }));
    expect(r).toEqual({ ok: false, error: 'RESEND_API_KEY not configured' });
  });

  it('requires html or text', async () => {
    const r = await sendEmail('key', { to: 'a@b.com', subject: 'Hi' }, fakeFetch(200, { id: 'x' }));
    expect(r.ok).toBe(false);
  });

  it('sends to/from/subject in the request body', async () => {
    let seen: Record<string, unknown> = {};
    const capture: typeof fetch = (async (_u: unknown, init: RequestInit) => {
      seen = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await sendEmail('key', { to: 'a@b.com', subject: 'Subj', html: '<p>hi</p>' }, capture);
    expect(seen.to).toEqual(['a@b.com']);
    expect(seen.subject).toBe('Subj');
    expect(typeof seen.from).toBe('string');
  });
});
