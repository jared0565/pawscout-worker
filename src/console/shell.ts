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
    display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;color:var(--subdued);
    border:0;border-radius:8px;padding:9px 12px;margin:2px 0;font-size:14px;font-weight:550;
  }
  .rail-btn:hover{background:rgba(232,89,12,.10);color:var(--ink);filter:none}
  .rail-btn.active{background:rgba(232,89,12,.18);color:#f0854b;font-weight:650}
  .rail-badge{
    margin-left:auto;min-width:19px;height:19px;padding:0 5px;border-radius:10px;
    background:#e8590c;color:#fff;display:inline-flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;
  }
  .rail-badge[hidden]{display:none}
  .view{display:none;flex:1 1 auto;min-width:0;padding:24px;max-width:1240px}
  .view.active{display:block}
  #view-inbox{max-width:none}
`;

export const railHtml = `<nav class="rail" aria-label="Console sections">
  <div class="rail__wordmark">PawScout</div>
  <button type="button" class="rail-btn" data-route="glance" onclick="location.hash='#/glance'">Glance</button>
  <button type="button" class="rail-btn" data-route="inbox" onclick="location.hash='#/inbox'">Inbox<span class="rail-badge" id="rail-inbox-badge" hidden>0</span></button>
  <button type="button" class="rail-btn" data-route="catalog" onclick="location.hash='#/catalog'">Catalog</button>
  <button type="button" class="rail-btn" data-route="ops" onclick="location.hash='#/ops'">Operations</button>
  <button type="button" class="rail-btn" data-route="audit" onclick="location.hash='#/audit'">Audit</button>
  <button type="button" class="rail-btn" data-route="partners" onclick="location.hash='#/partners'">Partners</button>
  <button type="button" class="rail-btn" data-route="campaigns" onclick="location.hash='#/campaigns'">Campaigns</button>
  <button type="button" class="rail-btn" data-route="events" onclick="location.hash='#/events'">Events</button>
  <button type="button" class="rail-btn" data-route="traffic" onclick="location.hash='#/traffic'">Traffic</button>
  <button type="button" class="rail-btn" data-route="settings" onclick="location.hash='#/settings'">Settings</button>
  <button type="button" class="rail-btn" data-route="help" onclick="location.hash='#/help'">Help</button>
</nav>`;

export const routerJs = `
// --- Hash router (shell): #/glance default (Phase 3 landing); #/inbox,
// #/catalog, #/ops, #/audit, #/partners, #/campaigns, #/traffic, #/settings,
// #/help, #/events. Toggles .active on the .view containers and rail buttons
// on hashchange and on load; a missing or unknown hash falls back to glance.
// Hash-only navigation so it works inside the Shopify embedded iframe.
// 'events' is deliberately LAST: digits 1-9 and 0 map to the first ten routes,
// so appending keeps every existing keyboard shortcut stable (Events has no
// key; the rail button sits next to Campaigns regardless - rail order is HTML
// order, not ROUTES order).
var ROUTES=['glance','inbox','catalog','ops','audit','partners','campaigns','traffic','settings','help','events'];
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
// --- Keyboard shortcuts (Phase 4): 1-9 switch views; j/k walk the inbox thread
// list (j/k route through the row's click handler, so the unsent-draft-edits
// guard still applies). Deliberately NO shortcut sends or approves anything -
// emailing a customer stays a mouse-click decision. All keys are ignored while
// typing (inputs/textareas/selects/contenteditable) or with a modifier held.
function keyEditable(t){
  if(!t) return false;
  var tag=(t.tagName||'').toUpperCase();
  return tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||!!t.isContentEditable;
}
window.addEventListener('keydown',function(e){
  if(e.ctrlKey||e.metaKey||e.altKey||e.defaultPrevented) return;
  if(keyEditable(e.target)) return;
  if(window.__modalOpen) return; // a modal (e.g. the Audit conversation) owns the keyboard
  var d=parseInt(e.key,10);
  if(d>=1&&d<=ROUTES.length){ location.hash='#/'+ROUTES[d-1]; e.preventDefault(); return; }
  // Ten routes but nine digits: 0 is the tenth view (Help).
  if(e.key==='0'&&ROUTES.length>=10){ location.hash='#/'+ROUTES[9]; e.preventDefault(); return; }
  if((e.key==='j'||e.key==='k')&&currentRoute()==='inbox'){
    var rows=document.querySelectorAll('#inbox-threads .ibx-row');
    if(!rows.length) return;
    var idx=-1;
    for(var i=0;i<rows.length;i++){ if(rows[i].classList.contains('is-sel')){ idx=i; break; } }
    var next=(e.key==='j')?Math.min(idx+1,rows.length-1):Math.max(idx<0?0:idx-1,0);
    if(next===idx) return;
    rows[next].click();
    rows[next].scrollIntoView({block:'nearest'});
    e.preventDefault();
  }
});
`;
