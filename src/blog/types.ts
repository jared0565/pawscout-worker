// src/blog/types.ts
//
// Types for the blog content pipeline (research -> draft -> syndicate). This
// module is DELIBERATELY isolated from src/inbox/: it shares only generic infra
// (LlmClient, adminForShop, Vault, TenantStore), never the inbox drafter, the
// inbox quality gate, or the CategoryAgent registry - those are tuned to a
// different job (short warm replies) and coupling to them would put the tested
// inbox path at risk. See docs/blog-rss-pinterest-traffic-prd-audit.md.

/** A single real product the drafter MAY reference (grounding fact pack). */
export interface GroundedProduct {
  title: string;
  handle: string;
  path: string;      // relative storefront path, e.g. /products/<handle>
  priceGbp: number;  // shop-currency price (GBP)
  available: boolean;
  imageUrl?: string; // featured image URL (drives the auto hero pick), if any
  imageWidth?: number;  // source px - a >=1200 square hero is what makes the
  imageHeight?: number; // og:image genuinely 1200x1200 (Shopify never upscales)
}

/** Deterministic fact pack for one target collection: what really exists, so the
 *  drafter grounds product claims in stock instead of inventing them. */
export interface FactPack {
  collectionHandle: string;
  collectionTitle: string;
  collectionPath: string; // /collections/<handle>
  products: GroundedProduct[];
}

/** The research agent's output: a plan a human can approve before drafting. */
export interface BlogBrief {
  title: string;            // proposed article title
  angle: string;           // the specific angle / promise of the piece
  targetKeyword: string;   // primary search intent
  collectionHandle: string;// which collection this funnels into (must be real)
  whyNow: string;          // seasonal / catalog rationale
  keyPoints: string[];     // 3-6 points the draft should cover
}

/** The draft agent's output: a full article ready to stage as a Shopify DRAFT. */
export interface BlogDraft {
  title: string;
  bodyHtml: string;        // article body (HTML)
  excerpt: string;         // summary / listing blurb
  metaTitle: string;       // SEO title
  metaDescription: string; // SEO meta description
  tag: string;             // collection handle -> drives the related-products block
}

/** A candidate topic the research agent ranks. Internal + seasonal signal. */
export interface TopicSeed {
  collectionHandle: string;
  workingTitle: string;
  note: string; // why this is a fit (season, evergreen, catalog gap)
}

/** A proposed topic the owner can pick from. It CARRIES its full validated
 *  brief (so generation reuses it and never re-derives the topic/collection),
 *  plus display evidence that it is backed by real, in-stock, on-storefront
 *  products (the gate that makes the suggestion trustworthy). */
export interface BlogTopicCandidate {
  brief: BlogBrief;            // the full validated brief, carried into generation
  collectionTitle: string;    // funnel collection display name
  liveProductCount: number;   // how many live storefront products back it
  sampleProducts: string[];   // a few product titles, for the dropdown subtitle
}
