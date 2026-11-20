// Stage 0 gate helpers for the affiliate self-serve apply route
// (src/affiliate/apply.ts). Every function here is PURE and deterministic -
// no D1, no fetch, no ambient Date.now() - so the whole module is unit
// testable without mocking I/O (tests/affiliate-gates.test.ts). Async
// functions (signTimestamp/verifyTimestamp) use Web Crypto only, never
// network or storage. See docs/superpowers/specs/
// 2026-07-12-affiliate-self-serve-marketplace-design.md ("Stage 0").

// --- Email syntax -----------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmailSyntax(email: string): boolean {
  const e = (email ?? '').trim();
  if (e.length < 3 || e.length > 254) return false;
  if (!EMAIL_RE.test(e)) return false;
  const domain = e.split('@')[1] ?? '';
  return domain.length > 0 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

// --- Disposable-domain blocklist ---------------------------------------

// Curated, lowercase. Raises the cost of a throwaway mailbox; not
// exhaustive (the trust model never assumes it is - see the design doc's
// "bounding what a bad actor can extract" section).
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com', 'guerrillamail.info',
  'guerrillamail.biz', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamailblock.com',
  '10minutemail.com', '10minemail.com', 'throwawaymail.com', 'throwam.com', 'yopmail.com',
  'yopmail.net', 'yopmail.fr', 'trashmail.com', 'trashmail.net', 'sharklasers.com', 'getnada.com',
  'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'mytemp.email', 'mohmal.com',
  'emailondeck.com', 'mintemail.com', 'spamgourmet.com', 'tempinbox.com', 'moakt.com', 'tempail.com',
  'discard.email', 'discardmail.com', 'burnermail.io', 'mailcatch.com', 'spam4.me', 'tempmailo.com',
  'emailfake.com', 'fakemailgenerator.com', 'mailsac.com', 'harakirimail.com', 'tempr.email',
  'tempemail.co', 'mailnull.com', 'spambox.us', 'deadaddress.com', 'incognitomail.com', 'trbvm.com',
  'wegwerfmail.de', 'einrot.com', 'jetable.org', 'spamex.com', 'mailmoat.com', '33mail.net'
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_EMAIL_DOMAINS.has((domain ?? '').trim().toLowerCase());
}

// --- Mainstream mailbox providers ---------------------------------------

// A much higher per-domain daily rate-limit bucket applies to these
// (src/affiliate/apply.ts) so one shared consumer provider can never DoS
// every legitimate applicant using it.
export const MAINSTREAM_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'protonmail.com', 'proton.me'
]);

export function isMainstreamEmailDomain(domain: string): boolean {
  return MAINSTREAM_EMAIL_DOMAINS.has((domain ?? '').trim().toLowerCase());
}

// --- Coupon / deal / cashback host blocklist -----------------------------

// A channel that IS one of these (or a subdomain of one) is not a real
// content channel - it is a code-scraping/aggregator site.
export const COUPON_HOSTS: readonly string[] = [
  'honey.com', 'joinhoney.com', 'retailmenot.com', 'groupon.com', 'slickdeals.net', 'coupons.com',
  'rakuten.com', 'ebates.com', 'topcashback.co.uk', 'topcashback.com', 'quidco.com',
  'vouchercodes.co.uk', 'hotukdeals.com', 'dealspotr.com', 'wikibuy.com', 'capitaloneshopping.com',
  'cashbackmonitor.com', 'couponfollow.com', 'dealsplus.com', 'offers.com', 'coupofy.com',
  'raise.com', 'swagbucks.com', 'mypoints.com', 'befrugal.com', 'fatwallet.com', 'picodi.com',
  'myvouchercodes.co.uk', 'discountcode.com'
];

export function isCouponHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return false;
  return COUPON_HOSTS.some((c) => h === c || h.endsWith(`.${c}`));
}

// --- Channel URL gate ----------------------------------------------------

const ACTIVEPAW_HOST_SUFFIXES = ['activepaw.co.uk', 'myshopify.com'];

function isActivePawHost(host: string): boolean {
  return ACTIVEPAW_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export interface ChannelHostCheck { ok: boolean; host: string | null; reason?: string }

/** http(s) + parseable, not a coupon/deal/cashback host, not an activepaw
 *  domain, and on a shared platform it names an account. Does NOT check
 *  whether another application holds the channel (that needs D1 - the
 *  caller, apply.ts, does that separately, by channelKey). */
export function channelHostAllowed(url: string): ChannelHostCheck {
  let u: URL;
  try { u = new URL((url ?? '').trim()); } catch { return { ok: false, host: null, reason: 'unparseable' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, host: null, reason: 'bad_protocol' };
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return { ok: false, host: null, reason: 'no_host' };
  if (isCouponHost(host)) return { ok: false, host, reason: 'coupon_host' };
  if (isActivePawHost(host)) return { ok: false, host, reason: 'activepaw_domain' };
  if (platformOf(bareHost(host)) && !platformAccount(u)) return { ok: false, host, reason: 'platform_root' };
  return { ok: true, host };
}

// --- Channel identity (one channel per account, not per platform) ---------

// Hosts many creators share, where the channel is the account in the path.
// Production, 2026-11-20: matching on the host alone let one facebook.com
// application refuse every later Facebook creator as "already linked". A
// host not listed here is treated as a site of its own, so its host is the
// channel. Any subdomain of a listed host is that platform (de-de.facebook.com,
// uk.pinterest.com, music.youtube.com), except on the platforms below whose
// subdomains are sites people own (alice.substack.com).
export const SHARED_PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  'instagram.com', 'facebook.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'x.com', 'threads.net',
  'pinterest.com', 'pinterest.co.uk', 'twitch.tv', 'snapchat.com', 'linkedin.com', 'reddit.com',
  'medium.com', 'linktr.ee', 'etsy.com', 'tumblr.com', 'bsky.app', 'patreon.com', 'kick.com',
  'vimeo.com', 'substack.com'
]);

/** Other names for the same account namespace, keyed to the canonical host. */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  'twitter.com': 'x.com', 'fb.com': 'facebook.com', 'threads.com': 'threads.net'
};

/** Platforms whose subdomains are their users' own sites, not the platform. */
const USER_SUBDOMAIN_PLATFORMS: ReadonlySet<string> = new Set(['substack.com', 'medium.com', 'tumblr.com']);

// A first path segment that is a section, not an account, so the account
// is the segment after it (youtube.com/channel/ID, facebook.com/groups/name).
const SECTION_SEGMENTS: ReadonlySet<string> = new Set([
  'c', 'channel', 'user', 'u', 'r', 'in', 'company', 'groups', 'shop', 'people', 'pages', 'pg', 'profile'
]);

/** The host as a person reads it: lower case, no trailing dot, without
 *  www./m./mobile. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '').replace(/^(?:www|m|mobile)\./, '');
}

/** The canonical platform a bare host belongs to, or null for a site of its own. */
function platformOf(bare: string): string | null {
  for (const [alias, canonical] of Object.entries(PLATFORM_ALIASES)) {
    if (bare === alias || bare.endsWith(`.${alias}`)) return canonical;
  }
  for (const p of SHARED_PLATFORM_HOSTS) {
    if (bare === p) return p;
    if (bare.endsWith(`.${p}`)) return USER_SUBDOMAIN_PLATFORMS.has(p) ? null : p;
  }
  return null;
}

/** Every host a stored link to `platform` may carry, for the lookup's
 *  substring prefilter: the platform and its aliases. */
function platformHosts(platform: string): string[] {
  return [platform, ...Object.keys(PLATFORM_ALIASES).filter((a) => PLATFORM_ALIASES[a] === platform)];
}

function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The account a shared-platform link names, lower case ('' when none). */
function platformAccount(u: URL): string {
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeSegment(s).toLowerCase());
  if (segs.length === 0) return '';
  if (segs[0] === 'profile.php') {
    const id = u.searchParams.get('id');
    return id ? `profile.php?id=${id.toLowerCase()}` : '';
  }
  if (SECTION_SEGMENTS.has(segs[0]!)) return segs.length > 1 ? `${segs[0]}/${segs[1]}` : '';
  return segs[0]!;
}

/** Which channel a link names: on a shared platform the host plus the
 *  account (instagram.com/alice), elsewhere the host without www
 *  (mypetblog.com). Two links are the same channel exactly when their keys
 *  are equal. null when the link names no channel (unparseable, or a
 *  platform with no account in it). */
export function channelKey(url: string): string | null {
  let u: URL;
  try { u = new URL((url ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = bareHost(u.hostname);
  if (!host) return null;
  const platform = platformOf(host);
  if (!platform) return host;
  const account = platformAccount(u);
  return account ? `${platform}/${account}` : null;
}

/** Substrings that every stored link to the channel `key` contains (lower
 *  cased), for a prefilter that can never be narrower than the key itself:
 *  hosts only, never the account, since a stored path may be spelled
 *  differently (%61lice) from the decoded key. */
export function channelLookupHosts(key: string): string[] {
  const slash = key.indexOf('/');
  return slash < 0 ? [key] : platformHosts(key.slice(0, slash));
}

// --- Honeypot + min time-to-submit ---------------------------------------

export const MIN_SUBMIT_MS = 3000;

export interface HoneypotFields { honeypot?: string | null; formRenderedAtMs: number }

/** `formRenderedAtMs` must already be the VERIFIED timestamp (see
 *  verifyTimestamp below) - this function stays pure/sync by trusting its
 *  caller to have authenticated that number first. */
export function honeypotOk(fields: HoneypotFields, nowMs: number): boolean {
  if ((fields.honeypot ?? '').trim() !== '') return false;
  const elapsed = nowMs - fields.formRenderedAtMs;
  return Number.isFinite(elapsed) && elapsed >= MIN_SUBMIT_MS;
}

// --- Signed form-render timestamp (anti-forgery) -------------------------
// Anti-forgery only: the signed token is replayable within its window
// (TIMESTAMP_MAX_AGE_MS below) - it proves the form was actually rendered by
// this server, not that the request is a first-and-only use. Turnstile is
// the real bot/replay-cost gate; this token's job is honeypot-timing proof.

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A signed token is good for this long after the GET that minted it - long
// enough for a slow human, short enough to bound replay of a leaked token.
export const TIMESTAMP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

/** Mint a hidden-field value: `${tsMs}.${hmac}`. Keyed with the worker's own
 *  Shopify app secret (the same keying convention as retention.ts's
 *  unsubscribe token and proxy/verify.ts) - no new secret needed. */
export async function signTimestamp(tsMs: number, secret: string): Promise<string> {
  return `${tsMs}.${await hmacHex(String(tsMs), secret)}`;
}

/** Verify + parse a signTimestamp token. Returns the embedded tsMs when the
 *  signature is valid, not from the future, and not older than maxAgeMs;
 *  otherwise null. Null covers "missing", "tampered", and "expired" alike -
 *  the caller (apply.ts) folds all of these into the same silent reject. */
export async function verifyTimestamp(
  token: string, secret: string, nowMs: number, maxAgeMs: number = TIMESTAMP_MAX_AGE_MS
): Promise<number | null> {
  const parts = (token ?? '').split('.');
  if (parts.length !== 2) return null;
  const [tsStr, mac] = parts;
  const tsMs = Number(tsStr);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  const expected = await hmacHex(tsStr, secret);
  if (!timingSafeEqual(expected, mac)) return null;
  if (nowMs < tsMs) return null; // from the future - clock skew or tamper, either way don't trust it
  if (nowMs - tsMs > maxAgeMs) return null;
  return tsMs;
}

// --- Required-field + length-cap validation -------------------------------

export interface ApplicationFieldsInput {
  name?: string; email?: string; channelUrl?: string; audience?: string; plan?: string; termsAccepted?: boolean;
}
/** Field names as the apply form posts them (and as `field` names them in an
 *  error body), so the page can mark the one that failed. */
export type ApplyFieldKey = 'name' | 'email' | 'channel_url' | 'audience' | 'plan' | 'terms';

/** The one length table for the apply form, counted after trimming. The
 *  validator, its error messages, and the form's minlength/maxlength and hints
 *  all read it, so the browser and the server cannot disagree (theme agent
 *  report 2026-11-20: a 9-character answer failed an unstated minimum). */
export const APPLY_FIELD_LIMITS = {
  name: { min: 1, max: 120 },
  email: { min: 1, max: 254 },
  channel_url: { min: 1, max: 500 },
  audience: { min: 10, max: 2000 },
  plan: { min: 10, max: 2000 }
} as const;

export type FieldValidation = { ok: true } | { ok: false; reason: ApplyFieldKey };

/** All fields required, length-capped. Does not re-check email syntax or
 *  channel URL parseability - those have their own dedicated gates below. */
export function validateFields(f: ApplicationFieldsInput): FieldValidation {
  const L = APPLY_FIELD_LIMITS;
  const fits = (v: string | undefined, lim: { min: number; max: number }) => {
    const n = (v ?? '').trim().length;
    return n >= lim.min && n <= lim.max;
  };
  if (!fits(f.name, L.name)) return { ok: false, reason: 'name' };
  if (!fits(f.email, L.email)) return { ok: false, reason: 'email' };
  if (!fits(f.channelUrl, L.channel_url)) return { ok: false, reason: 'channel_url' };
  if (!fits(f.audience, L.audience)) return { ok: false, reason: 'audience' };
  if (!fits(f.plan, L.plan)) return { ok: false, reason: 'plan' };
  if (f.termsAccepted !== true) return { ok: false, reason: 'terms' };
  return { ok: true };
}
