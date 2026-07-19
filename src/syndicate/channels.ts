// Channel payload mapping (blog distribution phase 1): pure functions from a
// creative pack to a Blotato post per channel. Rail-agnostic callers (sweep,
// manual send route) only see BlotatoPostInput | {error}; a config gap (no
// account/board/image) is a HARD error surfaced on the ledger, never a silent
// skip. UTM discipline: every link carries source/medium/campaign so Shopify
// analytics can attribute sessions and sales per channel per guide (the data
// the 90-day Blotato review reads).
import { COPY_CAPS, type SyndicationCopy } from './pack';
import type { BlotatoPostInput } from './blotato';
import type { SyndicateChannelConfig, SyndicateChannelKey } from '../types';
import { BLOG_HANDLE } from '../blog/pipeline';
import { capTitle } from '../debrand';

export const STORE_URL = 'https://activepaw.co.uk';

export function utmUrl(articleHandle: string, channel: string): string {
  return `${STORE_URL}/blogs/${BLOG_HANDLE}/${articleHandle}`
    + `?utm_source=${encodeURIComponent(channel)}&utm_medium=social&utm_campaign=guide-${encodeURIComponent(articleHandle)}`;
}

export interface ChannelSendInput { copy: SyndicationCopy; articleHandle: string; imageUrl: string | null }

export function blotatoPostFor(
  channel: SyndicateChannelKey, ch: SyndicateChannelConfig, input: ChannelSendInput
): BlotatoPostInput | { error: string } {
  if (!ch.accountId) return { error: 'channel has no connected accountId' };
  const link = utmUrl(input.articleHandle, channel);
  if (channel === 'pinterest') {
    if (!ch.boardId) return { error: 'pinterest channel has no boardId' };
    if (!input.imageUrl) return { error: 'no image available for a pin' };
    return {
      accountId: ch.accountId, text: input.copy.pinDesc, mediaUrls: [input.imageUrl], platform: 'pinterest',
      target: { targetType: 'pinterest', boardId: ch.boardId, title: input.copy.pinTitle, link, altText: input.copy.altText }
    };
  }
  if (channel === 'facebook') {
    if (!ch.pageId) return { error: 'facebook channel has no pageId' };
    // Link post, no media: Facebook renders the article's OG card (built and
    // debugger-verified in the blog MVP), which converts better than a photo
    // post whose link hides in the text.
    return {
      accountId: ch.accountId, text: input.copy.caption, mediaUrls: [], platform: 'facebook',
      target: { targetType: 'facebook', pageId: ch.pageId, link }
    };
  }
  // instagram: feed posts carry no clickable link; the URL rides in the caption.
  if (!input.imageUrl) return { error: 'no image available for an instagram post' };
  // Caption budget: the copy gate caps caption at COPY_CAPS.caption (Instagram's
  // hard 2200), but the appended suffix (link + optional discovery hashtags)
  // would push a near-cap caption over it and the post would be rejected at
  // publish time. Budget the suffix first and word-boundary-trim the caption
  // into what remains (never the link or the tags - a truncated URL is
  // worthless and a half hashtag is a different hashtag).
  const tags = input.copy.hashtags?.trim() ? `\n\n${input.copy.hashtags.trim()}` : '';
  const suffix = `\n\nRead the guide: ${link}${tags}`;
  const caption = capTitle(input.copy.caption, COPY_CAPS.caption - suffix.length);
  return {
    accountId: ch.accountId, text: `${caption}${suffix}`, mediaUrls: [input.imageUrl], platform: 'instagram',
    target: { targetType: 'instagram' }
  };
}
