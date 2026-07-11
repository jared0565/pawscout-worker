import { describe, it, expect } from 'vitest';
import { mergeSyndicate, DEFAULT_SYNDICATE, SYNDICATE_CHANNEL_KEYS } from '../src/types';

describe('mergeSyndicate', () => {
  it('empty/corrupt blobs yield the full dormant default', () => {
    expect(mergeSyndicate('')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate(null)).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{}').channels.pinterest).toEqual({ enabled: false, auto: false });
  });
  it('saved partial blob merges per channel without losing siblings', () => {
    const syn = mergeSyndicate(JSON.stringify({ channels: { pinterest: { enabled: true, accountId: 'a1', boardId: 'b1' } } }));
    expect(syn.channels.pinterest).toEqual({ enabled: true, auto: false, accountId: 'a1', boardId: 'b1' });
    expect(syn.channels.facebook).toEqual({ enabled: false, auto: false });
    expect(syn.digest.mode).toBe('weekly');
  });
  it('channel keys are the stable registry', () => {
    expect(SYNDICATE_CHANNEL_KEYS).toEqual(['pinterest', 'facebook', 'instagram']);
  });
});
