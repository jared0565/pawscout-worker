import { describe, it, expect } from 'vitest';
import { visionModelRejected } from '../src/index';
import type { CatalogModel } from '../src/models-catalog';

const cat: CatalogModel[] = [
  { slug: 'm/vis', name: 'V', vision: true, promptPriceM: 1, completionPriceM: 2 },
  { slug: 'm/txt', name: 'T', vision: false, promptPriceM: 1, completionPriceM: 2 },
];

describe('visionModelRejected', () => {
  it('rejects a catalog model marked vision:false', () => {
    expect(visionModelRejected('m/txt', cat)).toBe(true);
  });
  it('allows a vision model', () => {
    expect(visionModelRejected('m/vis', cat)).toBe(false);
  });
  it('allows an unknown slug or unset (defense-in-depth; UI already constrained)', () => {
    expect(visionModelRejected('m/unknown', cat)).toBe(false);
    expect(visionModelRejected(undefined, cat)).toBe(false);
  });
});
