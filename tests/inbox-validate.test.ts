import { describe, it, expect } from 'vitest';
import { validateInboxPayload, validateThreadStatus, validateLabels } from '../src/validate';

describe('inbox validators', () => {
  it('accepts a clean inbox config', () => {
    const r = validateInboxPayload({ enabled: true, intentThreshold: 75, alertEmail: 'o@gmail.com', autosend: false, labels: ['lead'] });
    expect(r.ok).toBe(true);
  });
  it('rejects a bad threshold', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 250, autosend: false, labels: [] }).ok).toBe(false);
  });
  it('rejects autosend:true in this phase', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: true, labels: [] }).ok).toBe(false);
  });
  it('rejects a bad alert email', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: false, labels: [], alertEmail: 'nope' }).ok).toBe(false);
  });
  it('accepts a valid classifyModel slug and returns it', () => {
    const r = validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: false, labels: [], classifyModel: 'google/gemini-2.5-flash-lite' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.classifyModel).toBe('google/gemini-2.5-flash-lite');
  });
  it('rejects a non-slug classifyModel', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: false, labels: [], classifyModel: 'not a model' }).ok).toBe(false);
  });
  it('validates statuses and labels', () => {
    expect(validateThreadStatus('needs_reply')).toBe(true);
    expect(validateThreadStatus('bogus')).toBe(false);
    expect(validateLabels(['lead', 'spam']).ok).toBe(true);
    expect(validateLabels(['not-a-label']).ok).toBe(false);
  });
});
