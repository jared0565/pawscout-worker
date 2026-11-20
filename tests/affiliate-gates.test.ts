import { describe, it, expect } from 'vitest';
import {
  validEmailSyntax, isDisposableDomain, isMainstreamEmailDomain, isCouponHost, channelHostAllowed, channelKey,
  honeypotOk, signTimestamp, verifyTimestamp, validateFields, MIN_SUBMIT_MS, TIMESTAMP_MAX_AGE_MS,
  APPLY_FIELD_LIMITS
} from '../src/affiliate/gates';

const SECRET = 'test-shopify-secret';

describe('validEmailSyntax', () => {
  it('accepts ordinary addresses', () => {
    expect(validEmailSyntax('jane@example.com')).toBe(true);
    expect(validEmailSyntax('jane.doe+tag@sub.example.co.uk')).toBe(true);
  });
  it('rejects malformed addresses', () => {
    expect(validEmailSyntax('')).toBe(false);
    expect(validEmailSyntax('not-an-email')).toBe(false);
    expect(validEmailSyntax('jane@')).toBe(false);
    expect(validEmailSyntax('@example.com')).toBe(false);
    expect(validEmailSyntax('jane@nodot')).toBe(false);
    expect(validEmailSyntax('jane@.com')).toBe(false);
    expect(validEmailSyntax('jane example@example.com')).toBe(false);
  });
  it('rejects an overlong address', () => {
    expect(validEmailSyntax(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('isDisposableDomain', () => {
  it('flags known disposable domains, case-insensitively', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    expect(isDisposableDomain('guerrillamail.com')).toBe(true);
    expect(isDisposableDomain('yopmail.com')).toBe(true);
    expect(isDisposableDomain('10minutemail.com')).toBe(true);
  });
  it('does not flag a normal domain', () => {
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isDisposableDomain('example.com')).toBe(false);
    expect(isDisposableDomain('')).toBe(false);
  });
});

describe('isMainstreamEmailDomain', () => {
  it('flags well-known consumer providers', () => {
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']) {
      expect(isMainstreamEmailDomain(d)).toBe(true);
    }
  });
  it('does not flag an arbitrary domain', () => {
    expect(isMainstreamEmailDomain('some-random-blog.com')).toBe(false);
  });
});

describe('isCouponHost', () => {
  it('flags known coupon/deal/cashback hosts and their subdomains', () => {
    expect(isCouponHost('retailmenot.com')).toBe(true);
    expect(isCouponHost('www.retailmenot.com')).toBe(true);
    expect(isCouponHost('honey.com')).toBe(true);
    expect(isCouponHost('quidco.com')).toBe(true);
    expect(isCouponHost('hotukdeals.com')).toBe(true);
  });
  it('does not flag an unrelated host', () => {
    expect(isCouponHost('example.com')).toBe(false);
    expect(isCouponHost('')).toBe(false);
  });
});

describe('channelHostAllowed', () => {
  it('accepts a normal http(s) URL', () => {
    const r = channelHostAllowed('https://mypetblog.com/reviews');
    expect(r.ok).toBe(true);
    expect(r.host).toBe('mypetblog.com');
  });
  it('rejects an unparseable URL', () => {
    expect(channelHostAllowed('not a url').ok).toBe(false);
    expect(channelHostAllowed('').ok).toBe(false);
  });
  it('rejects a non-http(s) protocol', () => {
    const r = channelHostAllowed('ftp://example.com/x');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_protocol');
  });
  it('rejects a coupon-host channel', () => {
    const r = channelHostAllowed('https://www.retailmenot.com/some-page');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('coupon_host');
  });
  it('rejects an activepaw domain (self-referential channel)', () => {
    expect(channelHostAllowed('https://activepaw.co.uk/blog').ok).toBe(false);
    expect(channelHostAllowed('https://shop.activepaw.co.uk/blog').ok).toBe(false);
    expect(channelHostAllowed('https://4qkudm-ez.myshopify.com').ok).toBe(false);
    expect(channelHostAllowed('https://activepaw.co.uk./blog').ok).toBe(false);
  });
  it('rejects a shared platform with no account in the link (not anyone\'s channel)', () => {
    for (const url of ['https://instagram.com', 'https://www.youtube.com/', 'https://m.facebook.com/?ref=x', 'https://web.facebook.com/', 'https://instagram.com./']) {
      const r = channelHostAllowed(url);
      expect(r.ok, url).toBe(false);
      expect(r.reason, url).toBe('platform_root');
    }
    expect(channelHostAllowed('https://www.instagram.com/alice').ok).toBe(true);
  });
});

// One channel is one account: on a platform many creators share, the account
// is in the path, so the host alone would make every creator there the same
// channel (production, 2026-11-20: one facebook.com application refused every
// later facebook.com applicant as "already linked").
describe('channelKey', () => {
  it('on a shared platform, is the host plus the account, whatever the form of the link', () => {
    expect(channelKey('https://www.instagram.com/Alice/?hl=en')).toBe('instagram.com/alice');
    expect(channelKey('https://instagram.com/alice')).toBe('instagram.com/alice');
    expect(channelKey('https://m.facebook.com/groups/DogLovers/about')).toBe('facebook.com/groups/doglovers');
    expect(channelKey('https://www.youtube.com/@DogTV/videos')).toBe('youtube.com/@dogtv');
    expect(channelKey('https://youtube.com/channel/UC123')).toBe('youtube.com/channel/uc123');
    expect(channelKey('https://www.tiktok.com/@pup.daily')).toBe('tiktok.com/@pup.daily');
    expect(channelKey('https://x.com/dogs')).toBe('x.com/dogs');
  });
  it('tells two creators on the same platform apart', () => {
    expect(channelKey('https://instagram.com/alice')).not.toBe(channelKey('https://instagram.com/bob'));
    expect(channelKey('https://facebook.com/alice')).not.toBe(channelKey('https://facebook.com/bob'));
  });
  it('on a site of its own, is the host without www, so another page of the same site is the same channel', () => {
    expect(channelKey('https://www.mypetblog.com/reviews')).toBe('mypetblog.com');
    expect(channelKey('https://mypetblog.com/about')).toBe('mypetblog.com');
    expect(channelKey('https://alice.substack.com/p/post')).toBe('alice.substack.com');
  });
  it('never matches a host that merely contains another', () => {
    expect(channelKey('https://notexample.com')).not.toBe(channelKey('https://example.com'));
    expect(channelKey('https://netflix.com/x')).not.toBe(channelKey('https://x.com/x'));
  });
  // Security review of 9b6837f: an exact key is only as strong as its
  // canonical form, so one account must not get a second key by spelling.
  it('gives one account one key however its link is spelled', () => {
    const alice = channelKey('https://instagram.com/alice');
    for (const url of [
      'https://instagram.com./alice', 'https://INSTAGRAM.COM/alice', 'https://instagram.com/%61lice',
      'https://www.instagram.com/alice/', 'https://de-de.instagram.com/alice'
    ]) expect(channelKey(url), url).toBe(alice);
    expect(channelKey('https://twitter.com/Dogs')).toBe(channelKey('https://x.com/dogs'));
    expect(channelKey('https://fb.com/alice')).toBe(channelKey('https://web.facebook.com/alice'));
    expect(channelKey('https://example.com./x')).toBe('example.com');
  });
  it('keeps the sites people own under a platform\'s subdomains apart', () => {
    expect(channelKey('https://alice.medium.com/post')).toBe('alice.medium.com');
    expect(channelKey('https://bob.tumblr.com')).toBe('bob.tumblr.com');
    expect(channelKey('https://medium.com/@alice')).toBe('medium.com/@alice');
  });
  it('has no key for a link that names no channel', () => {
    expect(channelKey('https://instagram.com/')).toBeNull();
    expect(channelKey('not a url')).toBeNull();
    expect(channelKey('')).toBeNull();
  });
});

describe('honeypotOk', () => {
  it('rejects when the honeypot field is filled', () => {
    expect(honeypotOk({ honeypot: 'i am a bot', formRenderedAtMs: 0 }, MIN_SUBMIT_MS + 1000)).toBe(false);
  });
  it('rejects a submit under the minimum time', () => {
    expect(honeypotOk({ honeypot: '', formRenderedAtMs: 1000 }, 1000 + MIN_SUBMIT_MS - 1)).toBe(false);
  });
  it('accepts an empty honeypot submitted after the minimum time', () => {
    expect(honeypotOk({ honeypot: '', formRenderedAtMs: 1000 }, 1000 + MIN_SUBMIT_MS)).toBe(true);
    expect(honeypotOk({ formRenderedAtMs: 1000 }, 1000 + MIN_SUBMIT_MS + 5000)).toBe(true);
  });
});

describe('signTimestamp / verifyTimestamp', () => {
  it('round-trips a freshly signed timestamp', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, SECRET);
    expect(await verifyTimestamp(token, SECRET, now + 5000)).toBe(now);
  });
  it('rejects a tampered timestamp value', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, SECRET);
    const [, mac] = token.split('.');
    const tampered = `${now + 100000}.${mac}`;
    expect(await verifyTimestamp(tampered, SECRET, now + 5000)).toBeNull();
  });
  it('rejects a tampered mac', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, SECRET);
    const [ts] = token.split('.');
    expect(await verifyTimestamp(`${ts}.deadbeef${'0'.repeat(56)}`, SECRET, now + 5000)).toBeNull();
  });
  it('rejects a token signed with a different secret', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, 'other-secret');
    expect(await verifyTimestamp(token, SECRET, now + 5000)).toBeNull();
  });
  it('rejects malformed tokens', async () => {
    expect(await verifyTimestamp('', SECRET, Date.now())).toBeNull();
    expect(await verifyTimestamp('not-a-token', SECRET, Date.now())).toBeNull();
    expect(await verifyTimestamp('123.456.789', SECRET, Date.now())).toBeNull();
  });
  it('rejects an expired token (older than the max age)', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, SECRET);
    expect(await verifyTimestamp(token, SECRET, now + TIMESTAMP_MAX_AGE_MS + 1)).toBeNull();
    expect(await verifyTimestamp(token, SECRET, now + TIMESTAMP_MAX_AGE_MS)).toBe(now);
  });
  it('rejects a timestamp from the future', async () => {
    const now = 1_700_000_000_000;
    const token = await signTimestamp(now, SECRET);
    expect(await verifyTimestamp(token, SECRET, now - 1)).toBeNull();
  });
});

describe('validateFields', () => {
  const VALID = {
    name: 'Jane Doe', email: 'jane@example.com', channelUrl: 'https://mypetblog.com',
    audience: 'A pet-focused blog with about 5000 monthly readers interested in dog care.',
    plan: 'I will write a review post and share it across my newsletter and social channels.',
    termsAccepted: true
  };
  it('accepts a fully valid submission', () => {
    expect(validateFields(VALID)).toEqual({ ok: true });
  });
  it('rejects a missing name', () => {
    expect(validateFields({ ...VALID, name: '' })).toEqual({ ok: false, reason: 'name' });
  });
  it('rejects a missing email', () => {
    expect(validateFields({ ...VALID, email: '' })).toEqual({ ok: false, reason: 'email' });
  });
  it('rejects a missing channel URL', () => {
    expect(validateFields({ ...VALID, channelUrl: '' })).toEqual({ ok: false, reason: 'channel_url' });
  });
  it('rejects a too-short audience description', () => {
    expect(validateFields({ ...VALID, audience: 'short' })).toEqual({ ok: false, reason: 'audience' });
  });
  it('rejects a too-short promotion plan', () => {
    expect(validateFields({ ...VALID, plan: 'short' })).toEqual({ ok: false, reason: 'plan' });
  });
  it('rejects an overlong field', () => {
    expect(validateFields({ ...VALID, audience: 'a'.repeat(2001) })).toEqual({ ok: false, reason: 'audience' });
  });
  it('rejects when terms are not accepted', () => {
    expect(validateFields({ ...VALID, termsAccepted: false })).toEqual({ ok: false, reason: 'terms' });
    expect(validateFields({ ...VALID, termsAccepted: undefined })).toEqual({ ok: false, reason: 'terms' });
  });

  // The owner's own attempt (2026-11-20): "dog owners" (10) passed the audience
  // check, "blog link" (9) failed the plan check. Both questions ask for 10.
  it('takes the owner\'s 10-character audience and refuses their 9-character plan', () => {
    expect(validateFields({ ...VALID, audience: 'dog owners', plan: 'blog link' })).toEqual({ ok: false, reason: 'plan' });
    expect(validateFields({ ...VALID, audience: 'dog owners', plan: 'blog links' })).toEqual({ ok: true });
  });

  it('counts a length after trimming, so padding never reaches the minimum', () => {
    expect(validateFields({ ...VALID, plan: '  blog link  ' })).toEqual({ ok: false, reason: 'plan' });
  });

  // The form's minlength/maxlength and the error messages read the same table,
  // so the validator must enforce exactly what the table says, at both edges.
  const KEY_OF = { name: 'name', email: 'email', channel_url: 'channelUrl', audience: 'audience', plan: 'plan' } as const;
  for (const field of Object.keys(APPLY_FIELD_LIMITS) as Array<keyof typeof APPLY_FIELD_LIMITS>) {
    it('enforces the shared limits for ' + field + ' at both edges', () => {
      const { min, max } = APPLY_FIELD_LIMITS[field];
      const at = (n: number) => validateFields({ ...VALID, [KEY_OF[field]]: 'a'.repeat(n) });
      expect(at(min)).toEqual({ ok: true });
      expect(at(max)).toEqual({ ok: true });
      expect(at(min - 1)).toEqual({ ok: false, reason: field });
      expect(at(max + 1)).toEqual({ ok: false, reason: field });
    });
  }

  it('asks the two free-text questions for at least 10 characters', () => {
    expect(APPLY_FIELD_LIMITS.audience.min).toBe(10);
    expect(APPLY_FIELD_LIMITS.plan.min).toBe(10);
  });
});
