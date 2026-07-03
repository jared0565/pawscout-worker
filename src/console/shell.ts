// Console shell (Phase 1): left rail nav + view show/hide CSS + hash router.
//
// - The rail is a fixed ~200px left column; nav buttons switch views by
//   setting location.hash only (works inside the Shopify admin iframe - no
//   history.pushState, no page reload).
// - ALL views exist in the DOM simultaneously; the router just toggles the
//   .active class. Every getElementById in the existing console JS therefore
//   keeps working regardless of which view a control sits in.
// - routerJs is appended to the page's single inline <script> AFTER the
//   existing console JS (it relies on el() defined there). Same template-
//   literal escaping conventions apply: it is browser JS inside a TS template
//   literal, so backticks/dollar-brace must not appear unescaped.

export const shellCss = `
  /* --- Shell: left rail + multi-view layout (Phase 1) --- */
  body{display:flex;align-items:stretch;padding:0}
  .rail{
    flex:0 0 200px;width:200px;position:sticky;top:0;height:100vh;overflow-y:auto;
    background:var(--surface);border-right:1px solid var(--border);padding:18px 10px;
  }
  .rail__wordmark{font-size:17px;font-weight:700;color:var(--ink);padding:2px 12px 14px}
  .rail-btn{
    display:block;width:100%;text-align:left;background:transparent;color:var(--subdued);
    border:0;border-radius:8px;padding:9px 12px;margin:2px 0;font-size:14px;font-weight:550;
  }
  .rail-btn:hover{background:rgba(232,89,12,.10);color:var(--ink);filter:none}
  .rail-btn.active{background:rgba(232,89,12,.18);color:#f0854b;font-weight:650}
  .view{display:none;flex:1 1 auto;min-width:0;padding:24px;max-width:1240px}
  .view.active{display:block}
  #view-inbox{max-width:none}
`;

export const railHtml = `<nav class="rail" aria-label="Console sections">
  <div class="rail__wordmark">PawScout</div>
  <button type="button" class="rail-btn" data-route="glance" onclick="location.hash='#/glance'">Glance</button>
  <button type="button" class="rail-btn" data-route="inbox" onclick="location.hash='#/inbox'">Inbox</button>
  <button type="button" class="rail-btn" data-route="catalog" onclick="location.hash='#/catalog'">Catalog</button>
  <button type="button" class="rail-btn" data-route="ops" onclick="location.hash='#/ops'">Operations</button>
  <button type="button" class="rail-btn" data-route="settings" onclick="location.hash='#/settings'">Settings</button>
  <button type="button" class="rail-btn" data-route="help" onclick="location.hash='#/help'">Help</button>
</nav>`;

export const routerJs = `
// --- Hash router (shell): #/glance default (Phase 3 landing); #/inbox,
// #/catalog, #/ops, #/settings, #/help. Toggles .active on the .view containers
// and rail buttons on hashchange and on load; a missing or unknown hash falls
// back to glance. Hash-only navigation so it works inside the Shopify embedded
// iframe.
var ROUTES=['glance','inbox','catalog','ops','settings','help'];
function currentRoute(){
  var h=location.hash||'';
  if(h.indexOf('#/')===0) h=h.slice(2); else if(h.indexOf('#')===0) h=h.slice(1);
  return ROUTES.indexOf(h)>=0?h:'glance';
}
function applyRoute(){
  var r=currentRoute();
  for(var i=0;i<ROUTES.length;i++){
    var on=ROUTES[i]===r;
    var v=el('view-'+ROUTES[i]); if(v){ if(on) v.classList.add('active'); else v.classList.remove('active'); }
    var b=document.querySelector('.rail-btn[data-route="'+ROUTES[i]+'"]'); if(b){ if(on) b.classList.add('active'); else b.classList.remove('active'); }
  }
}
window.addEventListener('hashchange',applyRoute);
applyRoute();
`;
