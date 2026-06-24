// tests/agents/registry.test.ts
import { describe, it, expect } from 'vitest';
import { agentFor, AGENTS } from '../../src/inbox/agents/registry';
import { INBOX_LABELS } from '../../src/inbox/types';

describe('agent registry', () => {
  it('maps every replyable label to an agent', () => {
    for (const l of INBOX_LABELS) if (l !== 'spam' && l !== 'automated') expect(AGENTS[l]).toBeTruthy();
  });
  it('falls back to the other agent for unknown/null category', () => {
    expect(agentFor(null).category).toBe('other');
    expect(agentFor('not-a-category').category).toBe('other');
  });
});
