import { describe, it, expect } from 'vitest';
import { prohibitedItemReason, prohibitedInDetail } from '../src/prohibited';

describe('prohibitedItemReason (aversive training devices, owner 2026-10-02)', () => {
  it.each([
    // The live overseas card: its listing says "shock" only in its images.
    'Smart GPS Wireless Fence Dog Training Collar',
    'Smart GPS Wireless Fence & Tracking Training Collar',
    'Dog Training Electric Shock Collar GPS Wireless Pet Rechargeable Water',
    'Pet Wireless Electronic Fence Gps Dog Trainer',
    'Pet Dog Fence Supplies GPS Positioning Wireless Electronic Fence',
    'Remote Dog Training Collar 800m Rechargeable',
    // Listed June to August 2026 ("static stimulation" in its description); the remote comes last.
    'Rechargeable Dog Training Collar with Remote',
    'Dog Trainer With Remote Control',
    'Anti Bark Shock Collar for Dogs',
    'Electronic Dog Collar With Static Correction',
  ])('blocks "%s"', (title) => {
    expect(prohibitedItemReason(title)).not.toBeNull();
  });

  it('blocks supplier text that names a shock or static mode', () => {
    expect(prohibitedItemReason('Operation mode: sound vibration shock Strength: 0-9 adjustable')).not.toBeNull();
    expect(prohibitedItemReason('Sound reminder + vibration intervention + static electricity warning')).not.toBeNull();
  });

  it.each([
    // A tracker that alerts the owner's phone, not a collar that corrects the dog.
    'Smart GPS Pet Collar Tracker Locator With Health And Activity Monitoring For Cats Dogs With Invisible Fence Notification Out Of Area',
    'GPS Locator Pet Collar Dog Cat Animal Anti-lost Anti-theft Tracker',
    'Shock Absorbing Bungee Dog Leash',
    'Anti-shock Elastic Dog Lead',
    'Shockproof Pet Camera',
    // In UK pet care an "e-collar" is usually the Elizabethan recovery cone.
    'Elizabethan E-Collar Recovery Cone for Dogs',
    'Martingale Training Collar for Dogs',
    'Dog Training Clicker',
    'LED Electronic Light Up Dog Collar',
  ])('keeps "%s"', (title) => {
    expect(prohibitedItemReason(title)).toBeNull();
  });
});

describe('prohibitedInDetail', () => {
  const base = { nameEn: 'Smart Dog Bark Control Collar', descriptionHtml: '<p>Waterproof, rechargeable.</p>', variants: [{ name: 'Black' }] };

  it('reads the description and the variant names, not only the title', () => {
    expect(prohibitedInDetail(base)).toBeNull();
    expect(prohibitedInDetail({ ...base, descriptionHtml: '<p>Modes: sound, vibration, shock</p>' })).not.toBeNull();
    expect(prohibitedInDetail({ ...base, variants: [{ name: 'Static shock version' }] })).not.toBeNull();
  });
});
