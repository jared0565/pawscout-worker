import { describe, it, expect } from 'vitest';
import { supplierAgent, SUPPLIER_PROMPT, OFF_NICHE_SUPPLIER_PROMPT, isOffNicheGrounding } from '../../src/inbox/agents/supplier';
import type { AgentContext } from '../../src/inbox/agents/types';
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

  // Design 2026-11-14 (8.2): an off-niche supplier, as the register records it,
  // gets the short acknowledgement prompt; anything else keeps the full flow.
  it('grounds an off-niche supplier from the register and picks the short prompt', async () => {
    const ctxFor = (getSupplier: () => Promise<unknown>) => ({ store: { getSupplier }, contactEmail: 'x@y.com' }) as unknown as AgentContext;
    const off = await supplierAgent.ground(ctxFor(async () => ({ niche_fit: 'off-niche' })));
    expect((off.data as { offNiche: boolean }).offNiche).toBe(true);
    expect(isOffNicheGrounding(off)).toBe(true);
    expect(supplierAgent.promptFragment(off)).toBe(OFF_NICHE_SUPPLIER_PROMPT);
    for (const row of [{ niche_fit: 'adjacent' }, { niche_fit: 'on-niche' }, null]) {
      const g = await supplierAgent.ground(ctxFor(async () => row));
      expect((g.data as { offNiche: boolean }).offNiche).toBe(false);
      expect(supplierAgent.promptFragment(g)).toBe(SUPPLIER_PROMPT);
    }
    // A register read failure never throws and keeps the full flow.
    const failed = await supplierAgent.ground(ctxFor(async () => { throw new Error('d1 down'); }));
    expect(isOffNicheGrounding(failed)).toBe(false);
  });

  // "for future reference" is the owner's own edit on an off-niche reply (2026-11-16).
  it('the off-niche prompt is the spec copy: noted, on file, no files, no asks, no promises', () => {
    expect(OFF_NICHE_SUPPLIER_PROMPT).toBe('This sender offers goods or services outside our range (dog and cat products). Write one or two short sentences after the opener: say we have noted their details and keep them on file for future reference. Answer a direct question only from the store facts. Do not invite a catalogue or any file, do not ask for links, do not ask about dropshipping, do not mention files, and promise nothing.');
  });

  // Owner 2026-11-20: a supplier "no" is worded as not for now, in any natural
  // words ("not this time", "at the moment", "for now", "at present"). Four of
  // the owner's six edits since 2026-11-14 added exactly that by hand, because
  // the 2026-09-27 prompt banned "for now". It still promises nothing.
  it('words a refusal as not for now, in any natural words, and still promises nothing', () => {
    expect(SUPPLIER_PROMPT).not.toMatch(/never write "at this stage" or "for now"/);
    expect(SUPPLIER_PROMPT).toMatch(/"not this time"/);
    expect(SUPPLIER_PROMPT).toMatch(/"at the moment"/);
    expect(SUPPLIER_PROMPT).toMatch(/never as a permanent no/i);
    expect(SUPPLIER_PROMPT).toMatch(/never say when or whether it will change/i);
    expect(SUPPLIER_PROMPT).toMatch(/not arranging samples or calls at the moment/);
    expect(SUPPLIER_PROMPT).toMatch(/on file for future reference/);
    expect(SUPPLIER_PROMPT).toMatch(/Never promise/);
    expect(SUPPLIER_PROMPT).not.toMatch(/[–—]/);
  });

  // Design 2026-11-14 (section 6 item 1, section 8.4): the catalogue invitation
  // follows the files, and step (2) names their range without a second thank-you.
  it('invites a catalogue only when no file arrived, and names the range in a few words', () => {
    expect(SUPPLIER_PROMPT).toContain('Files with this message');
    expect(SUPPLIER_PROMPT).toContain('Files sent but not kept');
    expect(SUPPLIER_PROMPT).not.toContain('(3) say they are welcome to email over their catalogue');
    const step2 = SUPPLIER_PROMPT.slice(SUPPLIER_PROMPT.indexOf('(2)'), SUPPLIER_PROMPT.indexOf('(3)'));
    // The old step (2) told the model to "thank them for the specific range";
    // what is left only says NOT to thank them again (the opener covers it).
    expect(step2).not.toMatch(/\bthank them\b|\bthank you for\b/i);
    expect(SUPPLIER_PROMPT).not.toContain('thank them for the specific range');
    expect(step2).toContain('in a few words');
    expect(step2).toContain('without thanking them again');
  });
});
