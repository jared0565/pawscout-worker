// Help-guide diagrams (Phase 5): hand-authored inline SVG, one per concept the
// guide explains better with a picture. Conventions:
//   - stroke/fill use the console CSS tokens (var(--ink) etc.) so the diagrams
//     match the forced-dark palette and re-theme with it;
//   - NO element ids (the static-DOM duplicate-id test stays meaningful) -
//     arrowheads are plain polygons, not marker refs;
//   - role="img" + a first-child <title> gives each diagram an accessible name;
//   - every factual label mirrors the real behavior documented in help.ts
//     (numbers here must change when the code's defaults change).

const BOX = 'fill="var(--code-bg)" stroke="var(--border)"';
const MAIN = 'font-size="12" fill="var(--ink)" text-anchor="middle"';
const SUB = 'font-size="10" fill="var(--subdued)" text-anchor="middle"';
const CAP = 'font-size="10.5" fill="var(--subdued)"';
const LINE = 'stroke="var(--subdued)" stroke-width="1.2"';
const ARR = 'fill="var(--subdued)"';

/** Email -> lane -> draft -> review gate -> sent, with the automatic bypass. */
export const inboxFlowSvg = `<svg class="hlp-diagram" role="img" viewBox="0 0 720 175" xmlns="http://www.w3.org/2000/svg">
  <title>How an email becomes a reply: it arrives, is sorted into a lane, a draft is written, then it waits for your review before sending. An automatic route sends only when every safety check passes.</title>
  <rect x="8" y="30" width="120" height="44" rx="8" ${BOX}/>
  <text x="68" y="56" ${MAIN}>Email arrives</text>
  <line x1="128" y1="52" x2="160" y2="52" ${LINE}/><polygon points="168,52 160,48 160,56" ${ARR}/>
  <rect x="168" y="30" width="150" height="44" rx="8" ${BOX}/>
  <text x="243" y="49" ${MAIN}>Sorted into a lane</text>
  <text x="243" y="65" ${SUB}>every 15 minutes</text>
  <line x1="318" y1="52" x2="350" y2="52" ${LINE}/><polygon points="358,52 350,48 350,56" ${ARR}/>
  <rect x="358" y="30" width="140" height="44" rx="8" ${BOX}/>
  <text x="428" y="49" ${MAIN}>Reply drafted</text>
  <text x="428" y="65" ${SUB}>specialist for the lane</text>
  <line x1="498" y1="52" x2="530" y2="52" ${LINE}/><polygon points="538,52 530,48 530,56" ${ARR}/>
  <rect x="538" y="30" width="174" height="44" rx="8" fill="var(--code-bg)" stroke="#e8590c" stroke-width="1.4"/>
  <text x="625" y="49" ${MAIN}>Waits for your review</text>
  <text x="625" y="65" ${SUB}>edit, approve, regenerate</text>
  <line x1="625" y1="74" x2="625" y2="98" ${LINE}/><polygon points="625,106 621,98 629,98" ${ARR}/>
  <rect x="538" y="106" width="174" height="40" rx="8" fill="var(--code-bg)" stroke="var(--ok-ink)"/>
  <text x="625" y="130" ${MAIN}>Reply sent</text>
  <path d="M428 74 L428 126 L528 126" fill="none" stroke="#d3a133" stroke-width="1.2" stroke-dasharray="4 3"/>
  <polygon points="536,126 528,122 528,130" fill="#d3a133"/>
  <text x="8" y="166" ${CAP}>Dashed route = automatic sending: taken only when the lane is set to automatic and every safety check passes; otherwise the draft waits for you.</text>
</svg>`;

/** Paid order -> checks -> queue/hold -> supplier order -> tracking. */
export const orderFlowSvg = `<svg class="hlp-diagram" role="img" viewBox="0 0 720 190" xmlns="http://www.w3.org/2000/svg">
  <title>What happens after a customer pays: safety checks, then a 60 minute grace queue, then the supplier order, then tracking back to your store. Orders that fail a check are held for you to release or cancel.</title>
  <rect x="8" y="30" width="118" height="44" rx="8" ${BOX}/>
  <text x="67" y="56" ${MAIN}>Customer pays</text>
  <line x1="126" y1="52" x2="158" y2="52" ${LINE}/><polygon points="166,52 158,48 158,56" ${ARR}/>
  <rect x="166" y="30" width="128" height="44" rx="8" ${BOX}/>
  <text x="230" y="56" ${MAIN}>Safety checks</text>
  <line x1="294" y1="52" x2="326" y2="52" ${LINE}/><polygon points="334,52 326,48 326,56" ${ARR}/>
  <rect x="334" y="30" width="150" height="44" rx="8" ${BOX}/>
  <text x="409" y="49" ${MAIN}>Queued</text>
  <text x="409" y="65" ${SUB}>60-minute grace window</text>
  <line x1="484" y1="52" x2="516" y2="52" ${LINE}/><polygon points="524,52 516,48 516,56" ${ARR}/>
  <rect x="524" y="30" width="188" height="44" rx="8" ${BOX}/>
  <text x="618" y="49" ${MAIN}>Supplier order created</text>
  <text x="618" y="65" ${SUB}>paid per your fulfilment mode</text>
  <line x1="230" y1="74" x2="230" y2="102" ${LINE}/><polygon points="230,110 226,102 234,102" ${ARR}/>
  <rect x="166" y="110" width="128" height="40" rx="8" fill="var(--code-bg)" stroke="var(--no-ink)"/>
  <text x="230" y="134" ${MAIN}>Held for you</text>
  <path d="M294 130 L364 130 L364 82" fill="none" ${LINE}/>
  <polygon points="364,74 360,82 368,82" ${ARR}/>
  <text x="300" y="124" font-size="10" fill="var(--subdued)">Release</text>
  <line x1="618" y1="74" x2="618" y2="102" ${LINE}/><polygon points="618,110 614,102 622,102" ${ARR}/>
  <rect x="524" y="110" width="188" height="40" rx="8" fill="var(--code-bg)" stroke="var(--ok-ink)"/>
  <text x="618" y="129" ${MAIN}>Tracking back to Shopify</text>
  <text x="618" y="143" ${SUB}>customer gets the tracking email</text>
  <text x="8" y="180" ${CAP}>PawScout submits due orders and collects tracking every 15 minutes. Held orders wait for your Release or Cancel; nothing is sent while held.</text>
</svg>`;

/** Landed USD cost -> GBP conversion -> multiplier -> shelf price. */
export const pricingChainSvg = `<svg class="hlp-diagram" role="img" viewBox="0 0 720 118" xmlns="http://www.w3.org/2000/svg">
  <title>How a shelf price is built: supplier cost plus freight in dollars, converted to pounds with a safety buffer, multiplied by 2.5, with a minimum margin of 6 pounds enforced.</title>
  <rect x="8" y="26" width="150" height="48" rx="8" ${BOX}/>
  <text x="83" y="47" ${MAIN}>Supplier cost + freight</text>
  <text x="83" y="63" ${SUB}>US dollars, landed</text>
  <line x1="158" y1="50" x2="182" y2="50" ${LINE}/><polygon points="190,50 182,46 182,54" ${ARR}/>
  <rect x="190" y="26" width="160" height="48" rx="8" ${BOX}/>
  <text x="270" y="47" ${MAIN}>Convert to pounds</text>
  <text x="270" y="63" ${SUB}>rate 0.78 + 2% buffer</text>
  <line x1="350" y1="50" x2="374" y2="50" ${LINE}/><polygon points="382,50 374,46 374,54" ${ARR}/>
  <rect x="382" y="26" width="140" height="48" rx="8" ${BOX}/>
  <text x="452" y="47" ${MAIN}>Multiply by 2.5</text>
  <text x="452" y="63" ${SUB}>never below 2.2</text>
  <line x1="522" y1="50" x2="546" y2="50" ${LINE}/><polygon points="554,50 546,46 546,54" ${ARR}/>
  <rect x="554" y="26" width="158" height="48" rx="8" fill="var(--code-bg)" stroke="#e8590c" stroke-width="1.4"/>
  <text x="633" y="47" ${MAIN}>Shelf price</text>
  <text x="633" y="63" ${SUB}>margin at least &#163;6</text>
  <text x="8" y="106" ${CAP}>Defaults shown; every number is adjustable in Catalog. The 2.5 multiplier targets roughly 17% net after advertising, fees and refunds.</text>
</svg>`;

/** Per-market local-for-local check -> shown or hidden. */
export const marketsSvg = `<svg class="hlp-diagram" role="img" viewBox="0 0 720 190" xmlns="http://www.w3.org/2000/svg">
  <title>Market availability: each product is checked per market every fifteen minutes. A product belongs in a market when a warehouse local to that market stocks it, or, while the local range is still growing, when it is part of the China-warehouse range and genuinely deliverable there. Everything else is hidden and checkout will not accept it.</title>
  <rect x="8" y="64" width="140" height="48" rx="8" ${BOX}/>
  <text x="78" y="85" ${MAIN}>Every product</text>
  <text x="78" y="101" ${SUB}>checked every 15 min</text>
  <line x1="148" y1="88" x2="188" y2="88" ${LINE}/><polygon points="196,88 188,84 188,92" ${ARR}/>
  <rect x="196" y="64" width="180" height="48" rx="8" ${BOX}/>
  <text x="286" y="85" ${MAIN}>Stocked near that</text>
  <text x="286" y="101" ${SUB}>market's buyers?</text>
  <path d="M376 88 L420 88 L420 44 L454 44" fill="none" ${LINE}/>
  <polygon points="462,44 454,40 454,48" ${ARR}/>
  <text x="426" y="36" font-size="10" fill="var(--ok-ink)">yes</text>
  <path d="M420 88 L420 140 L454 140" fill="none" ${LINE}/>
  <polygon points="462,140 454,136 454,144" ${ARR}/>
  <text x="426" y="158" font-size="10" fill="var(--no-ink)">no</text>
  <rect x="462" y="22" width="250" height="44" rx="8" fill="var(--code-bg)" stroke="var(--ok-ink)"/>
  <text x="587" y="41" ${MAIN}>Shown and sellable</text>
  <text x="587" y="57" ${SUB}>in that market</text>
  <rect x="462" y="118" width="250" height="44" rx="8" fill="var(--code-bg)" stroke="var(--no-ink)"/>
  <text x="587" y="137" ${MAIN}>Hidden from that market</text>
  <text x="587" y="153" ${SUB}>checkout will not accept it either</text>
  <text x="8" y="182" ${CAP}>Markets: United Kingdom (primary), European Union, US and Canada, Australia. "Near" means a local warehouse stocks it, or the China range still covering that market while its local range grows.</text>
</svg>`;

export const helpDiagramCss = `
  .hlp-diagram{width:100%;max-width:720px;height:auto;display:block;margin:6px 0 12px}
  .hlp-diagram text{font-family:inherit}
`;
