import { test, expect } from 'vitest';
import { freightUsdToGbp } from '../../src/shipping/pricing';

test('freightUsdToGbp converts with fx + handling, 2dp', () => {
  expect(freightUsdToGbp(10, 0.8, 0)).toBe('8.00');
  expect(freightUsdToGbp(9.83, 0.82, 0.5)).toBe('8.56'); // 9.83*0.82=8.0606 +0.5 = 8.5606 -> 8.56
  expect(freightUsdToGbp(0, 0.8, 0)).toBe('0.00');      // domestic GB->GB free
  expect(freightUsdToGbp(null, 0.8, 0)).toBe('0.00');   // null freight degrades to 0
});
