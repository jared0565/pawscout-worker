import { describe, it, expect } from 'vitest';
import { deriveModels } from '../src/llm-migrate';

describe('deriveModels (legacy → models)', () => {
  it('preserves the current pickHeroImage chain for blank visionModel', () => {
    expect(deriveModels({ model: 'base/x', curationModel: 'cur/y' }))
      .toEqual({ image: 'cur/y', text: 'cur/y', fallback: 'base/x' });
  });
  it('uses visionModel for image when present', () => {
    expect(deriveModels({ model: 'base/x', visionModel: 'vis/z' }))
      .toEqual({ image: 'vis/z', text: 'base/x', fallback: 'base/x' });
  });
  it('no legacy slugs → empty models', () => {
    expect(deriveModels({ enabled: true, scoreThreshold: 60 })).toEqual({});
  });
});
