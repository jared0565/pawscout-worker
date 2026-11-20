import { describe, it, expect } from 'vitest';
import { workerShell, LIQUID_STYLE } from '../src/affiliate/pages';

// Owner, 2026-11-20: "fix the faint orange buttons on the verify and portal
// pages". Those pages have no theme, so workerShell hardcodes its palette,
// and its accent was the theme's OLD #f05a28: white on it is about 3.2:1,
// under WCAG's 4.5:1. The values in the shell ARE what renders, so they are
// measured here directly.
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const shell = workerShell('Test', '<p>x</p>');
const ruleOf = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = shell.match(new RegExp('(?:^|\\n)\\s*' + esc + ' \\{([^}]*)\\}'));
  expect(m, 'no CSS rule for ' + selector).toBeTruthy();
  return m![1]!;
};
const hexIn = (rule: string, prop: string): string => {
  const m = rule.match(new RegExp('(?:^|[;\\s])' + prop + ': #([0-9a-f]{6}|[0-9a-f]{3})\\b'));
  expect(m, prop + ' in ' + rule).toBeTruthy();
  const h = m![1]!;
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h);
};
const BODY = hexIn(ruleOf('body'), 'background');
const CARD = hexIn(ruleOf('.apw-card'), 'background');

describe('workerShell: the verify and portal pages pass contrast', () => {
  it('no longer uses the old accent anywhere', () => {
    expect(shell).not.toMatch(/#f05a28|#ba3d1a/i);
  });

  it('the button\'s white text passes 4.5:1, resting and on hover', () => {
    const btn = ruleOf('.apw-button');
    const fg = hexIn(btn, 'color');
    expect(contrast(fg, hexIn(btn, 'background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, hexIn(ruleOf('.apw-button:hover'), 'background'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the button stands out from the card at 3:1', () => {
    expect(contrast(hexIn(ruleOf('.apw-button'), 'background'), CARD)).toBeGreaterThanOrEqual(3);
  });

  it('orange text (the label and the footer link) passes 4.5:1 where it sits', () => {
    expect(contrast(hexIn(ruleOf('.apw-kicker'), 'color'), CARD)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hexIn(ruleOf('.apw-foot a'), 'color'), BODY)).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring on a field passes 3:1 against the card', () => {
    const ring = ruleOf('.apw-input:focus').match(/outline: \d+px solid (#[0-9a-f]{6})/)?.[1];
    expect(contrast(ring!, CARD)).toBeGreaterThanOrEqual(3);
  });

  it('uses the same accent pair as the store pages\' fallbacks, so the two cannot drift', () => {
    const accent = LIQUID_STYLE.match(/var\(--accent, (#[0-9a-f]{6})\)/)?.[1];
    const accentDark = LIQUID_STYLE.match(/var\(--accent-dark, (#[0-9a-f]{6})\)/)?.[1];
    expect(hexIn(ruleOf('.apw-button'), 'background')).toBe(accent);
    expect(hexIn(ruleOf('.apw-kicker'), 'color')).toBe(accentDark);
  });
});
