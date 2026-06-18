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
  it('validates statuses and labels', () => {
    expect(validateThreadStatus('needs_reply')).toBe(true);
    expect(validateThreadStatus('bogus')).toBe(false);
    expect(validateLabels(['lead', 'spam']).ok).toBe(true);
    expect(validateLabels(['not-a-label']).ok).toBe(false);
  });
});
