// Branded page shells for the affiliate self-serve funnel (2026-07-13,
// owner-requested redesign: "adapt it with the brand - hero section, footer").
// TWO rendering contexts, ONE visual language:
//
// 1) LIQUID FRAGMENTS (apply + terms, store domain via App Proxy).
//    src/index.ts returns these with `Content-Type: application/liquid`, which
//    makes Shopify render the body as Liquid INSIDE the published theme's
//    layout - the real Active Paw header, announcement bar, nav, and footer
//    come from the theme itself. The fragment must therefore be a BODY
//    FRAGMENT (no doctype/html/head/body tags) and styles itself via the
//    theme's own :root CSS variables (--ink/--accent/--accent-dark/--surface/
//    --line/--muted/--panel, defined by theme.css + layout/theme.liquid), so
//    the pages track any future theme re-skin automatically. Theme classes
//    `.button .button-primary` are available too and are used for CTAs.
//
//    LIQUID-INJECTION SAFETY: Shopify EXECUTES any `{{ ... }}` / `{% ... %}`
//    in these fragments in the storefront context. Nothing user-controlled is
//    ever interpolated into a fragment (only server-minted hex tokens and the
//    Turnstile sitekey, both brace-free by construction), our own copy/CSS/JS
//    contains no double-brace sequences, and tests/affiliate-apply.test.ts
//    asserts the rendered fragments contain no `{{` or `{%`.
//
// 2) WORKER-DOMAIN PAGES (verify + portal on pawscout.activepaw.co.uk) have
//    no theme available, so `workerShell()` renders a standalone document
//    with the same palette HARDCODED to the theme's defaults (theme.css
//    :root - ink #101820, accent #f05a28, surface #f7f4ef, line #ded8cf,
//    muted #5d6670, body #fffdf9). If the store is ever re-skinned these
//    utility pages need a matching update; acceptable for email-link and
//    dashboard pages.

// --- 1) Liquid-fragment styles (apply + terms) -------------------------------

// All classes are `apaff-` prefixed so nothing can collide with theme.css.
// Written with spaced braces so no `{{` sequence can ever appear (Liquid).
export const LIQUID_STYLE = `<style>
  .apaff { max-width: 900px; margin: 0 auto; padding: 8px 20px 64px; line-height: 1.65; }
  .apaff-hero { background: var(--surface, #f7f4ef); border: 1px solid var(--line, #ded8cf); border-radius: 18px; padding: clamp(30px, 5vw, 56px) clamp(20px, 4vw, 48px); margin: 26px 0 22px; text-align: center; }
  .apaff-kicker { display: inline-block; letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; font-weight: 800; color: var(--accent-dark, #ba3d1a); margin-bottom: 12px; }
  .apaff-hero h1 { margin: 0 0 12px; font-size: clamp(28px, 4.5vw, 44px); line-height: 1.12; }
  .apaff-lede { max-width: 600px; margin: 0 auto; color: var(--muted, #5d6670); font-size: 17px; }
  .apaff-chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 22px 0 0; padding: 0; list-style: none; }
  .apaff-chips li { background: var(--panel, #ffffff); border: 1px solid var(--line, #ded8cf); border-radius: 999px; padding: 8px 16px; font-size: 13.5px; font-weight: 700; }
  .apaff-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0 0 22px; padding: 0; list-style: none; counter-reset: apaffstep; }
  .apaff-steps li { background: var(--panel, #ffffff); border: 1px solid var(--line, #ded8cf); border-radius: 14px; padding: 20px; counter-increment: apaffstep; }
  .apaff-steps li::before { content: counter(apaffstep); display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent, #f05a28); color: #fff; font-weight: 800; font-size: 14px; margin-bottom: 10px; }
  .apaff-steps h3 { margin: 0 0 6px; font-size: 16px; }
  .apaff-steps p { margin: 0; color: var(--muted, #5d6670); font-size: 14px; }
  .apaff-card { background: var(--panel, #ffffff); border: 1px solid var(--line, #ded8cf); border-radius: 14px; padding: clamp(20px, 3.5vw, 32px); margin-bottom: 16px; }
  .apaff-card h2 { margin: 0 0 10px; font-size: 20px; }
  .apaff-card p { margin: 0; }
  .apaff-card p + p { margin-top: 10px; }
  .apaff-field label { display: block; font-weight: 700; font-size: 14px; margin: 0 0 6px; }
  .apaff-field { margin: 0 0 16px; }
  .apaff-form input[type="text"], .apaff-form input[type="email"], .apaff-form input[type="url"], .apaff-form textarea { width: 100%; border: 1px solid var(--line, #ded8cf); border-radius: 8px; padding: 12px 14px; font: inherit; color: inherit; background: #fff; }
  .apaff-form textarea { min-height: 110px; resize: vertical; }
  .apaff-form input:focus, .apaff-form textarea:focus { outline: 2px solid var(--accent, #f05a28); outline-offset: 0; border-color: var(--accent, #f05a28); }
  .apaff-agree { display: flex; gap: 10px; align-items: baseline; font-size: 14px; margin: 0 0 16px; }
  .apaff-agree input { width: auto; }
  .apaff-agree a { color: var(--accent-dark, #ba3d1a); text-decoration: underline; font-weight: 700; }
  .apaff-form .cf-turnstile { margin: 0 0 16px; }
  .apaff-result { font-weight: 700; margin: 0 0 14px; }
  .apaff-result.ok { color: var(--green, #1f7a5a); }
  .apaff-result.error { color: var(--accent-dark, #ba3d1a); }
  .apaff-foot { text-align: center; color: var(--muted, #5d6670); font-size: 13.5px; }
  .apaff-foot a { color: var(--accent-dark, #ba3d1a); text-decoration: underline; }
  .apaff-preview { text-align: center; background: var(--ink, #101820); color: #fff; border-radius: 10px; padding: 10px 16px; font-size: 13.5px; font-weight: 700; }
  .apaff-cta { text-align: center; padding: clamp(24px, 4vw, 40px); }
  .apaff-cta .button { display: inline-flex; align-items: center; justify-content: center; min-width: 220px; }
  @media (max-width: 720px) { .apaff-steps { grid-template-columns: 1fr; } }
</style>`;

/** Shared hero band for the Liquid pages. `titleHtml`/`ledeHtml`/`extraHtml`
 *  are AUTHORED HTML (never user input - see the module doc's Liquid-safety
 *  note). */
export function liquidHero(kicker: string, titleHtml: string, ledeHtml: string, extraHtml = ''): string {
  return `<section class="apaff-hero">
  <span class="apaff-kicker">${kicker}</span>
  <h1>${titleHtml}</h1>
  <p class="apaff-lede">${ledeHtml}</p>
  ${extraHtml}
</section>`;
}

// --- 2) Worker-domain shell (verify + portal) --------------------------------

// NOTE: copy inside `inner` is the caller's; this shell adds only brand
// chrome. It must never introduce the words "form" or "buyer" (portal tests
// assert their absence on specific pages), so the footer stays minimal.
const WORKER_STYLE = `<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; color: #101820; background: #fffdf9; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6; }
  a { color: inherit; }
  .apw-top { background: rgba(255, 253, 249, 0.97); border-bottom: 1px solid #ded8cf; padding: 14px clamp(18px, 4vw, 56px); }
  .apw-brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; font-size: 20px; text-decoration: none; }
  .apw-brand-mark { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: #f05a28; color: #fff; font-size: 17px; }
  .apw-main { flex: 1; width: 100%; max-width: 760px; margin: 0 auto; padding: clamp(24px, 5vw, 48px) 20px; }
  .apw-card { background: #ffffff; border: 1px solid #ded8cf; border-radius: 16px; padding: clamp(24px, 4vw, 40px); }
  .apw-card h1 { margin: 0 0 12px; font-size: clamp(22px, 3.5vw, 30px); line-height: 1.15; }
  .apw-card p { margin: 0 0 12px; }
  .apw-card p:last-child { margin-bottom: 0; }
  .apw-muted { color: #5d6670; }
  .apw-kicker { display: inline-block; letter-spacing: 0.14em; text-transform: uppercase; font-size: 11.5px; font-weight: 800; color: #ba3d1a; margin-bottom: 10px; }
  .apw-input { width: 100%; border: 1px solid #ded8cf; border-radius: 8px; padding: 12px 14px; font: inherit; color: inherit; background: #fff; margin: 6px 0 16px; }
  .apw-input:focus { outline: 2px solid #f05a28; outline-offset: 0; border-color: #f05a28; }
  .apw-label { font-weight: 700; font-size: 14px; }
  .apw-button { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; border: 1px solid transparent; border-radius: 8px; padding: 13px 22px; font: inherit; font-weight: 800; background: #f05a28; color: #fff; cursor: pointer; }
  .apw-button:hover { background: #ba3d1a; }
  .apw-table { width: 100%; border-collapse: collapse; margin: 6px 0 18px; font-size: 14.5px; }
  .apw-table th { text-align: left; font-size: 12.5px; letter-spacing: 0.06em; text-transform: uppercase; color: #5d6670; border-bottom: 2px solid #ded8cf; padding: 8px 10px; }
  .apw-table td { border-bottom: 1px solid #ded8cf; padding: 10px; }
  .apw-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 6px 0 16px; }
  .apw-stat { background: #f7f4ef; border: 1px solid #ded8cf; border-radius: 12px; padding: 14px 16px; }
  .apw-stat b { display: block; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #5d6670; margin-bottom: 4px; }
  .apw-stat span { font-size: 19px; font-weight: 800; }
  .apw-foot { text-align: center; color: #5d6670; font-size: 13px; padding: 22px 20px 30px; }
  .apw-foot a { color: #ba3d1a; }
</style>`;

/** Standalone branded document for worker-domain pages. `inner` is authored
 *  or already-escaped HTML placed inside the centered card. */
export function workerShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${WORKER_STYLE}
</head>
<body>
<header class="apw-top"><a class="apw-brand" href="https://activepaw.co.uk"><span class="apw-brand-mark">&#128062;</span>Active Paw</a></header>
<main class="apw-main">
<div class="apw-card">
${inner}
</div>
</main>
<footer class="apw-foot">Active Paw Partner Program &middot; <a href="https://activepaw.co.uk">activepaw.co.uk</a></footer>
</body>
</html>`;
}
