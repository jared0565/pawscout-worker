import { describe, it, expect } from 'vitest';
import { supplierAgent, SUPPLIER_PROMPT } from '../../src/inbox/agents/supplier';
import { agentFor } from '../../src/inbox/agents/registry';
import { DEPARTMENT_SIGNATURES } from '../../src/inbox/draft';
import { INBOX_LABELS } from '../../src/inbox/types';
import { decideDisposition } from '../../src/inbox/classify';
import { resolveAgents } from '../../src/inbox/agents/config';

describe('supplier lane', () => {
  it('is a label, routes to its own agent, and signs as the Sourcing Team', () => {
    expect(INBOX_LABELS).toContain('supplier');
    expect(agentFor('supplier')).toBe(supplierAgent);
    expect(supplierAgent.department).toBe('sourcing');
    expect(supplierAgent.commercial).toBe(false);
    expect(DEPARTMENT_SIGNATURES.sourcing).toBe('Active Paw Sourcing Team');
  });

  it('autosend defaults off for the new lane', () => {
    expect(resolveAgents({}).supplier.autosend).toBe(false);
  });

  it('a supplier thread needs a reply and never alerts the owner, even at high intent', () => {
    const d = decideDisposition({ isHuman: true, category: 'supplier', intentScore: 95, summary: 's', labels: ['supplier'] });
    expect(d.status).toBe('needs_reply');
    expect(d.alert).toBe(false);
  });

  it('the prompt accepts information, asks for the link and about dropshipping, and promises nothing', () => {
    expect(SUPPLIER_PROMPT).toMatch(/welcome to email/i);
    expect(SUPPLIER_PROMPT).toMatch(/website/i);
    expect(SUPPLIER_PROMPT).toMatch(/Alibaba/);
    expect(SUPPLIER_PROMPT).toMatch(/dropshipping/i);
    expect(SUPPLIER_PROMPT).toMatch(/single orders directly to our customers/i);
    expect(SUPPLIER_PROMPT).toMatch(/Never promise/);
    expect(SUPPLIER_PROMPT).toMatch(/not arranging samples or calls/);
    expect(SUPPLIER_PROMPT).toMatch(/logistics/i);
    expect(SUPPLIER_PROMPT).toMatch(/already/i);          // do not re-ask what the thread already has
    expect(SUPPLIER_PROMPT).toMatch(/question they asked/i); // a direct question is still answered
    expect(SUPPLIER_PROMPT).not.toMatch(/[\u2013\u2014]/);
    expect(supplierAgent.promptFragment({ confident: true, facts: '', quotesFigure: false })).toBe(SUPPLIER_PROMPT);
  });
});
