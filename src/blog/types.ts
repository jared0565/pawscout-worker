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

/** One FAQ entry the drafter produces: rendered by the theme as a visible FAQ
 *  section AND as FAQPage JSON-LD from the same metafield (never drifts). */
export interface BlogFaqEntry {
  q: string; // a question a pet owner genuinely asks, natural phrasing
  a: string; // 40-80 word plain-text answer, grounded like the article
}

/** A short verifiable fact the research step found via web search, with the
 *  source page that states it. The drafter may cite ONLY these (linked), so the
 *  article gains citable data points without opening the fabrication door. */
export interface SourcedFact {
  fact: string;       // the claim, short and quotable
  sourceUrl: string;  // http(s) page that states it
  sourceName: string; // display name of the source (e.g. a charity or vet body)
}

/** The draft agent's output: a full article ready to stage as a Shopify DRAFT. */
export interface BlogDraft {
  title: string;
  bodyHtml: string;        // article body (HTML)
  excerpt: string;         // summary / listing blurb
  metaTitle: string;       // SEO title
  metaDescription: string; // SEO meta description
  tag: string;             // collection handle -> drives the related-products block
  faq?: BlogFaqEntry[];    // 3-5 Q&As -> blog.faq_json metafield (visible FAQ + schema)
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
  demandTerm?: string;        // the researched search term this topic answers, if any
}

/** One thing UK pet owners are searching for RIGHT NOW, found by live web
 *  research and tied to a category we actually stock. This is the demand
 *  evidence a topic is built ON, so the owner can see WHY a topic was proposed
 *  rather than trusting that some research happened. */
export interface DemandSignal {
  term: string;              // the search phrase / product interest, as people express it
  collectionHandle: string;  // the real collection it maps to (validated)
  why: string;               // one line: what makes this current
  sourceName?: string;       // where the signal came from, when the research names one
  sourceUrl?: string;
}

/** Whether a topic set was built on live demand research, and the evidence if so.
 *  `grounded:false` is a FIRST-CLASS result, not an error: the owner must be able
 *  to tell a researched suggestion from a catalog-and-calendar guess, because for
 *  nine days they could not and the topics silently became seasonal filler. */
export interface DemandEvidence {
  grounded: boolean;
  signals: DemandSignal[];
  note: string;             // owner-facing explanation, always populated
}
