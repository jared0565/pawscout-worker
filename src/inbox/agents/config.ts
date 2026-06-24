import { INBOX_LABELS, type InboxLabel } from '../types';

export interface AgentSettings { autosend: boolean }

/**
 * Resolve per-agent settings with a default for EVERY known label, defeating the
 * shallow JSON-merge hazard (same pattern as resolveLogistics). A stored partial or
 * garbage map can never yield an undefined/NaN setting; unknown keys are dropped.
 */
export function resolveAgents(inbox: { agents?: Record<string, { autosend?: unknown }> } | undefined | null): Record<InboxLabel, AgentSettings> {
  const stored = inbox?.agents ?? {};
  const out = {} as Record<InboxLabel, AgentSettings>;
  for (const label of INBOX_LABELS) {
    out[label] = { autosend: stored[label]?.autosend === true };
  }
  return out;
}
