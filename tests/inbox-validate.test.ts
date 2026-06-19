import { describe, it, expect } from 'vitest';
import { validateInboxPayload, validateThreadStatus, validateLabels } from '../src/validate';

describe('inbox validators', () => {
  it('accepts a clean inbox config', () => {
    const r = validateInboxPayload({ enabled: true, intentThreshold: 75, alertEmail: 'o@gmail.com', autosend: false, autoConfidenceThreshold: 80, labels: ['lead'] });
    expect(r.ok).toBe(true);
  });
  it('rejects a bad threshold', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 250, autosend: false, autoConfidenceThreshold: 80, labels: [] }).ok).toBe(false);
  });
  it('rejects autosend:true in this phase', () => {
    // autosend:true is now allowed — this test is superseded by the new acceptance test below
    // Keeping existing rejection test shape but verifying the old rejection is GONE:
    const r = validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: true, autoConfidenceThreshold: 80, labels: [] });
    // autosend:true now accepted — old hard-reject removed
    expect(r.ok).toBe(true);
  });
  it('rejects a bad alert email', () => {
    expect(validateInboxPayload({ enabled: true, intentThreshold: 70, autosend: false, autoConfidenceThreshold: 80, labels: [], alertEmail: 'nope' }).ok).toBe(false);
  });
  it('validates statuses and labels', () => {
    expect(validateThreadStatus('needs_reply')).toBe(true);
    expect(validateThreadStatus('bogus')).toBe(false);
    expect(validateLabels(['lead', 'spam']).ok).toBe(true);
    expect(validateLabels(['not-a-label']).ok).toBe(false);
  });
  it('now ACCEPTS autosend:true with the new fields', () => {
    const r = validateInboxPayload({ enabled: true, autosend: true, intentThreshold: 70, autoConfidenceThreshold: 85, replyGuidance: 'Be warm.', labels: ['lead'] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.autosend).toBe(true); expect(r.value.autoConfidenceThreshold).toBe(85); expect(r.value.replyGuidance).toBe('Be warm.'); }
  });
  it('rejects a bad autoConfidenceThreshold', () => {
    expect(validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 200, labels: [] }).ok).toBe(false);
  });
  it('accepts invoice config fields and defaults them', () => {
    const r = validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 80, labels: ['lead'], autoInvoice: true, invoiceConfidenceThreshold: 90, invoiceValueCeiling: 500, invoiceRateLimit: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.autoInvoice).toBe(true); expect(r.value.invoiceConfidenceThreshold).toBe(90); expect(r.value.invoiceValueCeiling).toBe(500); expect(r.value.invoiceRateLimit).toBe(1); }
  });
  it('rejects a bad invoiceValueCeiling and a bad invoiceRateLimit', () => {
    expect(validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 80, labels: [], invoiceValueCeiling: 0 }).ok).toBe(false);
    expect(validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 80, labels: [], invoiceRateLimit: 0 }).ok).toBe(false);
  });
  it('inbox save persists no model slug', () => {
    const r = validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 80, labels: [], replyModel: 'anthropic/claude-haiku-4.5', classifyModel: 'google/gemini-2.5-flash-lite' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect('replyModel' in r.value).toBe(false); expect('classifyModel' in r.value).toBe(false); }
  });
});
