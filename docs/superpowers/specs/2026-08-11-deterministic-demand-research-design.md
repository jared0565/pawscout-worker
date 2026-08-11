# Deterministic demand research (design)

**Status:** spec only. NOT built. One blocking gate is unresolved (see "The gate").
**Date:** 2026-08-11
**Context:** follows worker `bd71ace` / deploy `32865fa0`, which made blog topic
research genuinely demand-grounded again.

## The problem

`researchDemand` works, and it is expensive. Measured from `llm_usage`, three
real clicks on 2026-08-11:

| prompt tokens | cost (OpenRouter-reported) |
|---|---|
| 138,095 | $0.2576 |
| 88,985 | $0.1876 |
| 84,308 | $0.1825 |

**99.6% of a click is the search step**; the call that actually writes the topics
costs about a tenth of a cent. The cost is injected web-page content, driven by
`web: { maxResults: 8 }`.

For scale: those three clicks came to **$0.63, about 41% of August's entire LLM
bill to date** ($1.54 across 1,358 calls). It is owner-triggered, so it is not
currently a runaway. On a cron it would be.

**This repo has already solved this exact problem once.** `src/market.ts` opens
by describing it: *"The old cron path paid an LLM to BE a search engine: the
OpenRouter web plugin injected ~200k tokens of page content per lookup (~$0.29
each, 98% of all LLM spend)."* The fix there was structured data plus
deterministic code, with a tiny LLM only for genuinely ambiguous cases. Same
shape, same price, same fix available.

## Options considered

| Source | Verdict |
|---|---|
| **Google autocomplete** (`suggestqueries.google.com`) | **Recommended.** HTTP 200, no auth, no key, 351 bytes/query. Returns real queries people type, ranked. |
| Google Trends | **Rejected.** HTTP 429 on the first request from a residential IP, before Cloudflare egress is even involved. Unofficial endpoints, widget-token dance, known to block datacenter IPs. |
| eBay Browse API (already wired, `src/market.ts`) | Not applicable. It is a PRICE signal; it has no search-volume data. |
| Google Search Console | Needs OAuth the owner has not wired, and would return almost nothing at current traffic (1 order, pages crawled-not-indexed). |
| Amazon best sellers | ToS problems; scraping is not an option. |
| Keep the LLM web plugin | Works, but is the thing being replaced. Keep as an occasional deliberate mode (see "Hybrid"). |

## Measured sizing (residential IP, 2026-08-11)

12 category seeds + 10 alphabet-soup expansions = 22 requests:

- **0 failures**
- **216 unique search phrases**
- **7,722 bytes total, about 1,930 tokens**
- 351 bytes per query

Against 138,095 tokens for one LLM search pass, that is roughly **70x less
input** for a comparable set of signals. Validation that it captures the same
information: the LLM's top signal was *"cat water fountain stainless steel"*;
autocomplete returns exactly that as suggestion #2 for the seed *"cat water
fountain"*, for nothing.

## The gate (BLOCKING, owner action)

**Everything above was measured from a residential IP. Google may treat
Cloudflare Worker egress differently, and a 429 there kills the approach.**

This was not testable in-session: `wrangler` auth has expired ("Not logged in",
after deploys succeeded earlier the same day), and the Cloudflare API MCP token
has Workers **read** but not **write**, so no probe could be deployed by any
route. The same expiry blocks all future `wrangler deploy`.

**Unblock:** `npx wrangler login` in an interactive terminal. Then deploy the
throwaway probe (kept at
`<scratchpad>/egress-probe/`) and read `http200` / `nonOk`.

Do not start building before this returns 200s from a Worker.

## Design

### Data flow

```
catalog vocabulary (real collections + de-branded product titles)
        |  deterministic: titleTokens() from src/market.ts
        v
   seed phrases  ---> Google autocomplete (351 B each, cached in D1)
        |
        v
   raw suggestions (~200+ phrases)
        |  deterministic: noise filter -> collection mapping -> ranking
        v
   ranked DemandSignal[]  (same type the console already renders)
        |
        v
   existing topic-generation call (unchanged, ~$0.001)
```

The output type is **already** `DemandSignal[]`, so the console UI, the
`DemandEvidence` plumbing, and `proposeTopics` need no changes. This slots in
behind `researchDemand` as an alternative source.

### New module: `src/blog/demand-suggest.ts`

Pure functions plus one fetch, mirroring `src/market.ts`'s structure:

- `buildSeeds(packs: FactPack[]): string[]`
  Category seeds from collection titles, plus the most common content tokens
  across live product titles. Reuse `titleTokens` from `src/market.ts` (it
  already strips the right stopwords). Cap the count; each seed is a request.

- `fetchSuggestions(seed, fetchImpl): Promise<string[] | null>`
  `null` on source failure (so callers can fall back), `[]` on a genuine empty
  answer. Same null-vs-empty contract as `MarketSource.search`.

- `NOISE` filter, deterministic and tested. The measurement surfaced three
  distinct kinds of junk that must be dropped:
  1. **Foreign-geo leakage:** `gl=uk` is not binding. Observed: `dog bed
     bunnings` (Australian), `cat water fountain kmart`, `... nz`.
  2. **Competitor and retailer names:** `amazon`, `bunnings`, `kmart`, `argos`,
     `pets at home`. Dropping these is required anyway by the standing rule that
     no competitor or supplier brand may surface customer-facing, and the
     existing de-brand vocabulary is the natural source for this list.
  3. **Navigational intent:** `near me`, `nearby`, `second hand`, `used`,
     `diy`, `argos opening times` shaped queries. These are not content demand.

- `mapToCollection(phrase, packs): string | null`
  Token-overlap scoring with `titleSimilarity` from `src/market.ts`; below
  threshold returns `null` and the phrase is dropped. **No LLM.**

- `rankSignals(...): DemandSignal[]`
  Deterministic score from: best position in a suggestion list (autocomplete is
  roughly popularity-ordered), recurrence across distinct seeds, and whether the
  mapped collection has enough live stock. `why` is generated from the evidence
  (for example "appears at position 2 for 'cat water fountain' and recurs across
  3 seeds"), NOT written by a model, so nothing can be fabricated.

### Seasonality: the honest gap

Autocomplete gives no volume and no rising-vs-falling signal. The current LLM
pass produces reasoning like *"back-to-routine purchases peak in
September-October as school schedules resume"*. **Nothing here reproduces that.**

Two partial answers:

1. `publishWindow(month0)` already supplies the calendar steer, deterministically
   and free. It is what stops summer topics in August.
2. **Snapshot each run's suggestions to D1 and diff over time.** New and climbing
   phrases become a genuine trend signal that we own, at zero marginal cost. It
   is worth nothing on day one and takes months to be useful, so it must not be
   sold as an immediate replacement.

### Hybrid, and the actual recommendation

Do NOT delete the LLM path. Make the cheap source the default and the expensive
one a deliberate choice:

- **"Suggest topics"** (default): deterministic. About $0.001 per click, all of
  it the topic-writing call.
- **"Deep market research"** (explicit, labelled with its cost): the current
  `researchDemand`, kept for when genuine market reasoning and cited trade
  sources are wanted.

`DemandEvidence.note` already exists to tell the owner which one produced the
list, and `grounded` already distinguishes researched from not. Extend the note
rather than inventing new UI.

## What this does NOT change

- `collectSourcedFacts` stays on the web plugin. Cited article facts need real
  source pages from approved authorities; autocomplete cannot supply those, and
  that path has a fabrication guard for good reason.
- `proposeBrief`, the drafter, the quality gate, and the publish gate are all
  untouched.

## Testing

- Pure functions (`buildSeeds`, noise filter, `mapToCollection`, `rankSignals`)
  unit-tested with no network, the way `src/market.ts`'s matcher is.
- Fixture the real observed autocomplete payload shape, including the three junk
  classes above, so the filter is pinned against real data rather than invented
  data.
- One test asserting a foreign-retailer phrase never survives to a
  `DemandSignal`, since that is both a quality and a brand-policy failure.
- Source failure (`null`) must degrade to the existing behaviour, never to an
  empty topic list.

## Rollout

1. Egress gate (above). Stop if it fails.
2. Build behind a config flag so the LLM path stays reachable.
3. Compare both sources on the same day and judge the topics side by side.
   The comparison is the acceptance test: cheaper is only better if the topics
   are as good.
4. Keep the D1 snapshot from day one even though its value is deferred, because
   the trend signal cannot be backfilled.

## Open questions for the owner

1. **Does Cloudflare egress get 200s?** Blocking; needs `wrangler login`.
2. **Is losing "why now" reasoning acceptable** for the default button, given it
   is recoverable over months via snapshots and always available via the deep
   mode?
3. **Is ~$0.21 a click actually a problem?** At a few guides a month it is
   pennies, and this whole design may be premature. The strongest argument for
   building it is not today's bill but that it removes the thing that makes
   automating content generation unaffordable.
