// Subresource Integrity note:
// app-bridge.js is loaded WITHOUT SRI deliberately - it is EVERGREEN and Shopify
// ships updates continuously; an `integrity` hash would break it on the next update
// (Shopify's own guidance). App Bridge v4 exposes a global `shopify` and reads the
// API key from the <meta name="shopify-api-key"> tag, which MUST appear before the
// script. `host` is read from the URL by App Bridge itself - no createApp needed.
//
// Theme note: this renders inside Shopify admin's iframe, which is usually DARK (admin
// dark mode follows the OS color-scheme). The console must feel native, not alien - so
// it defaults to a DARK palette congruent with Polaris dark, and flips to LIGHT only
// when the environment prefers light (`@media (prefers-color-scheme: light)`). Colors
// are explicit in BOTH modes - never inherit, or text washes out. Keep both palettes in
// sync: every --token defined in :root must have a light counterpart in the media query.
//
// Feedback note: this app renders inside Shopify admin's cross-origin iframe, where
// window.alert()/confirm() are silently blocked. ALL user feedback must be inline
// (writing into DOM elements) - never alert(). Do not reintroduce alert() here.
//
// Structure note (Phase 1 shell / Phase 2 inbox / Phase 3 glance): this file is
// the COMPOSER - the shared <style> block and the single inline <script> live
// here, while the card markup lives in ./views/*.ts fragments, the rail/router
// in ./shell.ts, and the view-specific browser JS + CSS in ./inbox-js.ts +
// ./views/inbox.ts and ./glance-js.ts + ./views/glance.ts (composed below:
// inboxCss then glanceCss after shellCss; inboxJs then glanceJs before the init
// calls). All six views exist in the DOM at once; the hash router only toggles
// .active, so every getElementById below works regardless of the active view.

import { inboxView, inboxCss } from './views/inbox';
import { inboxJs } from './inbox-js';
import { glanceView, glanceCss } from './views/glance';
import { glanceJs } from './glance-js';
import { auditJs } from './audit-js';
import { partnersJs } from './partners-js';
import { catalogView } from './views/catalog';
import { opsView } from './views/ops';
import { auditView, auditCss } from './views/audit';
import { partnersView, partnersCss } from './views/partners';
import { settingsView } from './views/settings';
import { helpView, helpCss } from './views/help';
import { railHtml, routerJs, shellCss } from './shell';
export function consolePage(apiKey: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${apiKey}">
<meta name="color-scheme" content="dark light">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
  /* DARK always - forced regardless of OS preference. The merchant reported light
     sensitivity ("having problem looking at bright screens"), so the old
     prefers-color-scheme:light palette (white --surface was the glare source) was
     removed; the console never renders the bright theme now. */
  :root{
    color-scheme:dark;
    --bg:#1a1a1a; --surface:#2a2a2b; --ink:#e3e3e3; --subdued:#a8abb0;
    --border:#444748; --accent:#e3e3e3; --accent-ink:#1a1a1a;
    --ok-bg:#11331f; --ok-ink:#8fe0a6; --no-bg:#3a1714; --no-ink:#f4a39c;
    --field:#1a1a1a; --field-border:#6a6e73; --code-bg:#1a1a1a; --shadow:rgba(0,0,0,.3);
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:680px;margin:0 auto}
  header{margin-bottom:20px}
  h1{font-size:22px;margin:0 0 4px;color:var(--ink);font-weight:650}
  .sub{color:var(--subdued);margin:0;font-size:13px}
  .card{
    background:var(--surface); border:1px solid var(--border); border-radius:12px;
    padding:20px; margin-bottom:16px; box-shadow:0 1px 2px var(--shadow);
  }
  .card h2{font-size:15px;margin:0 0 14px;color:var(--ink);font-weight:600;display:flex;align-items:center;gap:8px}
  .step{
    display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
    border-radius:50%;background:var(--accent);color:var(--accent-ink);font-size:12px;font-weight:600;flex:0 0 auto;
  }
  label{display:block;font-weight:550;color:var(--ink);margin:0 0 6px}
  input[type=text],input[type=number],select{
    width:100%; padding:9px 11px; border:1px solid var(--field-border); border-radius:8px;
    background:var(--field); color:var(--ink); font-size:14px; font-family:inherit;
  }
  input::placeholder{color:#8a8d91}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .combo{position:relative}
  .combo-menu{
    position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:30;
    max-height:240px; overflow-y:auto; display:none;
    background:var(--field); border:1px solid var(--field-border); border-radius:8px;
    box-shadow:0 8px 24px rgba(0,0,0,.18);
  }
  .combo-menu.on{display:block}
  .combo-grp{padding:7px 11px 2px;font-size:11px;font-weight:600;color:var(--subdued);text-transform:uppercase;letter-spacing:.04em}
  .combo-opt{display:flex;justify-content:space-between;gap:10px;padding:7px 11px;font-size:14px;color:var(--ink);cursor:pointer}
  .combo-opt:hover,.combo-opt.active{background:var(--code-bg)}
  .combo-opt .cc{color:var(--subdued);font-size:12px}
  .combo-empty{padding:9px 11px;font-size:13px;color:var(--subdued)}
  .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  .row .grow{flex:1 1 160px}
  .row+.row{margin-top:10px}
  button{
    padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-ink);
    font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap;
  }
  button:hover{filter:brightness(.94)}
  button:disabled{opacity:.55;cursor:default}
  button.ghost{background:transparent;color:var(--ink);border:1px solid var(--field-border)}
  button.ghost:hover{filter:none;background:var(--code-bg)}
  .msg{margin:10px 0 0;font-size:13px;min-height:18px}
  .bar{height:6px;background:var(--code-bg);border:1px solid var(--border);border-radius:999px;overflow:hidden;margin-top:10px;display:none}
  .bar.on{display:block}
  .bar i{display:block;height:100%;width:0;background:var(--ok-ink);border-radius:999px;transition:width .4s ease}
  .bar.pulse i{width:100%;animation:barpulse 1.2s ease-in-out infinite}
  @keyframes barpulse{0%,100%{opacity:.35}50%{opacity:1}}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:var(--ok-bg);color:var(--ok-ink)}
  .badge.no{background:var(--no-bg);color:var(--no-ink)}
  .msg.ok{color:var(--ok-ink)} .msg.no{color:var(--no-ink)} .msg.muted{color:var(--subdued)}
  .kv{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;margin:0}
  .kv dt{color:var(--subdued)} .kv dd{margin:0;color:var(--ink);font-weight:550}
  ul.cols{list-style:none;padding:0;margin:8px 0 0}
  ul.cols li{padding:6px 0;border-top:1px solid var(--border)}
  ul.cols li:first-child{border-top:0}
  .muted{color:var(--subdued)}
  code{background:var(--code-bg);padding:1px 6px;border-radius:5px;font-size:12px;color:var(--ink)}
  hr{border:0;border-top:1px solid var(--border);margin:16px 0}
  .inbox-settings textarea{width:100%;min-height:80px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;font-family:inherit;resize:vertical}
  .inbox-settings textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .toggle-wrap{display:flex;align-items:center;gap:8px;padding:8px 0}
  .toggle-wrap input[type=checkbox]{width:auto;cursor:pointer}
  .reply-mode{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 14px;margin:0 0 14px;border:1px solid var(--border);border-radius:10px;background:var(--code-bg)}
  .reply-mode.is-auto{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .reply-mode__text{flex:1 1 240px;min-width:0}
  .reply-mode__state{font-weight:650}
  .reply-mode.is-auto .reply-mode__state{color:var(--accent)}
  .reply-mode__sw{display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;white-space:nowrap}
  .reply-mode__sw input[type=checkbox]{width:auto;cursor:pointer}
  .agents-panel{margin:0 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:10px}
  .agents-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--border)}
  .agents-row:first-of-type{border-top:0}
  .agents-row.is-disabled{opacity:.5}
${shellCss}
${inboxCss}
${glanceCss}
${auditCss}
${partnersCss}
${helpCss}</style>
</head><body>
${railHtml}
<main class="view" id="view-glance">
${glanceView}
</main>
<main class="view" id="view-inbox">
${inboxView}
</main>
<main class="view" id="view-catalog">
${catalogView}
</main>
<main class="view" id="view-ops">
${opsView}
</main>
<main class="view" id="view-audit">
${auditView}
</main>
<main class="view" id="view-partners">
${partnersView}
</main>
<main class="view" id="view-settings">
${settingsView}
</main>
<main class="view" id="view-help">
${helpView}
</main>

<script>
function el(id){ return document.getElementById(id); }
function setMsg(id,t,kind){ var n=el(id); if(!n) return; n.textContent=t; n.className='msg '+(kind||'muted'); }
function errText(e){ return e&&e.message?e.message:String(e); }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
async function token(){ return await shopify.idToken(); }
async function api(path,body,method){
  var t=await token();
  var m=method||'POST';
  var opts={method:m,headers:{'Authorization':'Bearer '+t}};
  if(m!=='GET'){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body||{}); }
  var r=await fetch('/api'+path,opts);
  return r.json();
}
// Model dropdowns: fetch the curated catalog (with live pricing + vision flags)
// once, cache the option HTML, and populate selects. The vision (image) select
// is built only from vision-capable models - a text-only model can never be
// chosen for image QA.
var modelOptionsPromise=null;
function ensureModelOptions(){
  if(!modelOptionsPromise){
    modelOptionsPromise=api('/models',null,'GET').then(function(r){
      var models=(r&&r.models)||[];
      function opt(m){
        var price=(m.promptPriceM==null)?'price n/a':('$'+m.promptPriceM+'/M in · $'+m.completionPriceM+'/M out');
        return '<option value="'+esc(m.slug)+'">'+esc(m.name)+' - '+price+(m.vision?' · 👁':'')+'</option>';
      }
      return { all:models.map(opt).join(''), vision:models.filter(function(m){return m.vision;}).map(opt).join('') };
    }).catch(function(){ return {all:'',vision:''}; });
  }
  return modelOptionsPromise;
}
// Preserve a saved slug not in the curated list as a selected option, so
// converting free-text → dropdown never silently changes a tenant's config.
function setSelectValue(id,slug){
  if(!slug) return;
  var s=el(id); if(!s) return;
  var has=false; for(var i=0;i<s.options.length;i++){ if(s.options[i].value===slug){ has=true; break; } }
  if(!has){ var o=document.createElement('option'); o.value=slug; o.textContent=slug+' (current)'; s.insertBefore(o,s.options[0]||null); }
  s.value=slug;
}
async function setModelSelect(id,slug,opts){
  opts=opts||{};
  var o=await ensureModelOptions();
  var e=el(id); if(!e) return;
  var html=opts.vision?o.vision:o.all;
  if(opts.blank) html='<option value="">'+opts.blank+'</option>'+html;
  e.innerHTML=html;
  setSelectValue(id,slug);
}
function renderStatus(s){
  var g=s.gates||{}; var p=s.pricing||{};
  var rows=''
    +'<dt>CJ supplier</dt><dd><span class="badge '+(s.cjConnected?'ok':'no')+'">'+(s.cjConnected?'Connected':'Not connected')+'</span></dd>'
    +'<dt>Popularity floor</dt><dd>'+esc(g.popularityFloor)+'</dd>'
    +'<dt>Price range</dt><dd>$'+esc(g.priceMin)+' - $'+esc(g.priceMax)+'</dd>'
    +'<dt>Relevance</dt><dd>'+esc(g.relevance)+'</dd>'
    +'<dt>Target count</dt><dd>'+esc(s.target)+'</dd>'
    +'<dt>Pricing</dt><dd>'+esc(p.multiplier)+'× (floor '+esc(p.floor)+'×, min £'+esc(p.minMarginGbp)+(p.maxMarginGbp!=null?', cap £'+esc(p.maxMarginGbp):'')+')</dd>'
    +(function(){ var a=s.addons||{}; return '<dt>Add-on lane</dt><dd>'+(a.enabled?('$'+esc(a.priceMinUsd)+' - $'+esc(a.priceMaxUsd)+' · pool '+esc(a.poolSize)+' · '+(a.suppressFromBrowse?'hidden':'visible')):'Off')+'</dd>'; })();
  var cm=s.collectionMap||{}; var keys=Object.keys(cm);
  var cols = keys.length
    ? keys.map(function(k){ var v=cm[k]||{}; return '<li><strong>'+esc(v.handle||k)+'</strong> <span class="muted">← tag</span> <code>'+esc(v.tag)+'</code></li>'; }).join('')
    : '<li class="muted">No collections mapped</li>';
  el('status').innerHTML='<dl class="kv">'+rows+'</dl><hr><div class="muted" style="font-weight:550;color:var(--ink)">Collection map</div><ul class="cols">'+cols+'</ul>';
}
// Forms are populated from the server exactly once - refresh() after a save
// must not clobber fields the merchant is still editing.
var formsPopulated=false;
function populateForms(s){
  if(formsPopulated) return; formsPopulated=true;
  var g=s.gates||{};
  if(g.popularityFloor!=null) el('pf').value=g.popularityFloor;
  if(g.priceMin!=null) el('pmin').value=g.priceMin;
  if(g.priceMax!=null) el('pmax').value=g.priceMax;
  if(g.relevance) el('rel').value=g.relevance;
  if(s.target!=null) el('tgt').value=s.target;
  var p=s.pricing||{};
  if(p.multiplier!=null) el('pmult').value=p.multiplier;
  if(p.floor!=null) el('pfloor').value=p.floor;
  if(p.minMarginGbp!=null) el('pmm').value=p.minMarginGbp;
  if(p.maxMarginGbp!=null) el('pmaxm').value=p.maxMarginGbp;
  if(p.fxUsdToGbp!=null) el('pfx').value=p.fxUsdToGbp;
  if(p.fxBufferPct!=null) el('pfxb').value=p.fxBufferPct;
  var l=s.llm||{};
  var mm=(l.models||{});
  setModelSelect('mdl-image', mm.image, {vision:true, blank:'- top model'});
  setModelSelect('mdl-text', mm.text, {blank:'- top model'});
  setModelSelect('mdl-fallback', mm.fallback, {vision:true, blank:'- none'});
  if(l.scoreThreshold!=null) el('llmthresh').value=l.scoreThreshold;
  if(l.enabled!=null) el('llmon').value=String(l.enabled);
  var a=s.addons||{};
  if(a.priceMinUsd!=null) el('addmin').value=a.priceMinUsd;
  if(a.priceMaxUsd!=null) el('addmax').value=a.priceMaxUsd;
  if(a.poolSize!=null) el('addpool').value=a.poolSize;
  if(a.enabled!=null) el('addon').value=String(a.enabled);
  if(a.suppressFromBrowse!=null) el('addvis').value=String(a.suppressFromBrowse);
  if(s.gbFreeUkLive!=null) el('gb-free-uk-chk').checked=!!s.gbFreeUkLive;
  setGbStatus(s.gbWarehousedCount, s.gbFreeUkLive);
  var cm=s.collectionMap||{};
  el('maprows').textContent='';
  Object.keys(cm).forEach(function(k){ var v=cm[k]||{}; addMapRow(v.handle||k, v.tag||''); });
}
function addMapRow(handle,tag){
  var row=document.createElement('div'); row.className='row maprow';
  function field(ph,val){
    var d=document.createElement('div'); d.className='grow';
    var i=document.createElement('input'); i.type='text'; i.placeholder=ph; i.value=val;
    i.spellcheck=false; i.autocomplete='off';
    d.appendChild(i); row.appendChild(d); return i;
  }
  field('collection handle (e.g. pet-toys)',handle);
  field('supplier tag (e.g. cj-pet-toys)',tag);
  var rm=document.createElement('button'); rm.className='ghost'; rm.type='button'; rm.textContent='Remove';
  rm.onclick=function(){ row.remove(); };
  row.appendChild(rm);
  el('maprows').appendChild(row);
}
async function refresh(){
  try{
    var s=await api('/status');
    renderStatus(s);
    populateForms(s);
    setMsg('cjstatus', s.cjConnected?'Connected ✓':'Not connected - enter your CJ API key above.', s.cjConnected?'ok':'muted');
  }catch(e){
    el('status').innerHTML='<p class="msg no">Could not load configuration: '+esc(errText(e))+'</p>';
    setMsg('cjstatus','Could not reach PawScout. Reload the page.','no');
  }
}
async function loadInsights(){
  try{
    var r=await api('/insights');
    var html='';
    var cats=(r&&r.categories)||[];
    if(cats.length){
      html+='<div class="muted" style="font-weight:550;color:var(--ink)">Category fill (store / warehouse)</div><ul class="cols">'
        +cats.map(function(c){
          var low=Number(c.imported)<Number(c.floor);
          return '<li><strong>'+esc(c.key)+'</strong> <span class="badge '+(low?'no':'ok')+'">'+esc(c.imported)+' / '+esc(c.target)+' listed</span> <span class="muted">· floor '+esc(c.floor)+' · warehouse '+esc(c.warehouse)+'</span></li>';
        }).join('')+'</ul><hr>';
    }
    var ks=(r&&r.keywords)||[];
    if(ks.length){
      html+='<div class="muted" style="font-weight:550;color:var(--ink)">Top searches - 30 days</div><ul class="cols">'
        +ks.map(function(k){
          var fill=(Number(k.avg_store_hits)+Number(k.avg_ghost_hits)).toFixed(1);
          return '<li><strong>'+esc(k.keyword_norm)+'</strong> <span class="muted">· '+esc(k.searches)+' searches · avg fill</span> <code>'+esc(fill)+'</code></li>';
        }).join('')+'</ul>';
    }
    if(r&&r.llmSpend&&r.llmSpend.calls>0){
      html+='<p class="muted" style="margin-top:10px">AI curation: '+esc(r.llmSpend.calls)+' calls · $'+esc(Number(r.llmSpend.costUsd).toFixed(4))+' (30 days)</p>';
    }
    el('insights').innerHTML=html||'<p class="muted">No storefront searches hit the backfill yet.</p>';
  }catch(e){
    el('insights').innerHTML='<p class="muted">Insights unavailable.</p>';
  }
}
async function connectCj(){
  var btn=el('cjbtn'); btn.disabled=true; setMsg('cjstatus','Connecting…','muted');
  try{
    var key=el('cj').value.trim();
    if(!key){ setMsg('cjstatus','Enter your CJ API key first.','no'); return; }
    var r=await api('/connect-cj',{apiKey:key});
    if(r.ok){ el('cj').value=''; setMsg('cjstatus','Connected ✓','ok'); refresh(); }
    else { setMsg('cjstatus','Failed: '+(r.error||'unknown error'),'no'); }
  }catch(e){ setMsg('cjstatus','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function saveGates(){
  setMsg('gatesmsg','Saving…','muted');
  try{
    var r=await api('/gates',{
      popularityFloor:Number(el('pf').value),
      priceMin:Number(el('pmin').value),
      priceMax:Number(el('pmax').value),
      relevance:el('rel').value,
      target:Number(el('tgt').value)
    });
    if(r.ok){ setMsg('gatesmsg','Saved ✓','ok'); refresh(); }
    else setMsg('gatesmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('gatesmsg','Failed: '+errText(e),'no'); }
}
async function savePricing(){
  setMsg('pricingmsg','Saving…','muted');
  try{
    var body={
      multiplier:Number(el('pmult').value),
      floor:Number(el('pfloor').value),
      minMarginGbp:Number(el('pmm').value),
      fxUsdToGbp:Number(el('pfx').value),
      fxBufferPct:Number(el('pfxb').value)
    };
    // Optional margin cap: blank input = no cap (the field is omitted, and the
    // server clears any stored cap because the payload replaces pricing wholesale).
    var mx=el('pmaxm').value;
    if(mx!=='') body.maxMarginGbp=Number(mx);
    var r=await api('/pricing',body);
    if(r.ok){ setMsg('pricingmsg','Saved ✓','ok'); refresh(); }
    else setMsg('pricingmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('pricingmsg','Failed: '+errText(e),'no'); }
}
// saveLlm serves TWO buttons in different views (Catalog "Save AI" -> #llmmsg,
// Settings "Save AI models" -> #llm-models-msg), so the confirmation is written
// to both message slots - whichever view the merchant clicked in shows it.
function llmMsg(t,kind){ setMsg('llmmsg',t,kind); setMsg('llm-models-msg',t,kind); }
async function saveLlm(){
  llmMsg('Saving…','muted');
  try{
    var r=await api('/llm',{
      enabled:el('llmon').value==='true',
      scoreThreshold:Number(el('llmthresh').value),
      models:{ image:(el('mdl-image')&&el('mdl-image').value)||'', text:(el('mdl-text')&&el('mdl-text').value)||'', fallback:(el('mdl-fallback')&&el('mdl-fallback').value)||'' }
    });
    if(r.ok){ llmMsg('Saved ✓','ok'); refresh(); }
    else llmMsg('Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ llmMsg('Failed: '+errText(e),'no'); }
}
function syncBar(mode,frac){
  var b=el('syncbar'); if(!b) return;
  b.className='bar'+(mode==='off'?'':' on')+(mode==='pulse'?' pulse':'');
  if(mode==='frac') b.querySelector('i').style.width=Math.round((frac||0)*100)+'%';
}
async function heroImagesNow(){
  var btn=el('herobtn'); btn.disabled=true;
  try{
    setMsg('heromsg','Reviewing product images…','muted');
    syncBar('frac',0);
    var offset=0, fixed=0, scanned=0, total=0;
    for(;;){
      var r=await api('/hero-images',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('heromsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      fixed+=r.fixed; scanned+=r.scanned; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('heromsg','Reviewed '+Math.min(offset+r.scanned,total)+' of '+total+'… '+fixed+' default image'+(fixed===1?'':'s')+' fixed','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('heromsg','Done ✓ '+fixed+' default image'+(fixed===1?'':'s')+' fixed across '+total+' product'+(total===1?'':'s')+'.','ok');
  }catch(e){ syncBar('off'); setMsg('heromsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function rewriteDescsNow(){
  var btn=el('descbtn'); btn.disabled=true;
  try{
    setMsg('descmsg','Checking descriptions for raw supplier copy…','muted');
    syncBar('frac',0);
    var offset=0, rewritten=0, total=0;
    for(;;){
      var r=await api('/descriptions',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('descmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      rewritten+=r.rewritten; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('descmsg','Scanned '+Math.min(offset+r.scanned,total)+' of '+total+'… '+rewritten+' rewritten','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('descmsg','Done ✓ '+rewritten+' description'+(rewritten===1?'':'s')+' rewritten of '+total+' scanned.','ok');
  }catch(e){ syncBar('off'); setMsg('descmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
var currentMode='manual';
var currentCreateOnly=false;
var armPawscout=false;
function renderMode(){
  var l=el('modelabel'); if(!l) return;
  var base=({manual:'Manual (queue only)',cj:'CJ app (PawScout not managing)',pawscout:'PawScout auto (create + pay + track)'}[currentMode]||currentMode);
  l.textContent=base+((currentMode==='pawscout'&&currentCreateOnly)?' - create-only (you pay in CJ)':'');
  var cb=el('createonlybtn');
  if(cb){ cb.textContent='Create-only: '+(currentCreateOnly?'ON':'OFF'); cb.disabled=(currentMode!=='pawscout'); }
}
async function applyMode(mode){
  try{
    var r=await api('/fulfil',{mode:mode});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode; currentCreateOnly=!!r.createOnly; renderMode();
    setMsg('ordmsg','Fulfilment mode set to '+r.mode+'.',r.mode==='pawscout'?'ok':'muted');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function toggleCreateOnly(){
  if(currentMode!=='pawscout'){ setMsg('ordmsg','Create-only only applies in PawScout auto mode.','muted'); return; }
  try{
    var next=!currentCreateOnly;
    var r=await api('/fulfil',{mode:'pawscout',createOnly:next});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode; currentCreateOnly=!!r.createOnly; renderMode();
    setMsg('ordmsg',currentCreateOnly?'Create-only ON - PawScout will create CJ orders and leave them for you to pay in CJ.':'Create-only OFF - PawScout will pay CJ orders from the wallet balance.',currentCreateOnly?'muted':'ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function setMode(mode){
  if(mode!=='pawscout'){ armPawscout=false; await applyMode(mode); return; }
  // PawScout mode spends money: inline two-click confirm (confirm() is blocked in the admin iframe)
  if(!armPawscout){
    armPawscout=true;
    setMsg('ordmsg','⚠ PawScout mode auto-CREATES and PAYS CJ orders from your wallet. First fund the CJ wallet AND turn OFF CJ native order-import (else duplicate orders). Click PawScout auto again within 8s to confirm.','no');
    setTimeout(function(){ if(armPawscout){ armPawscout=false; setMsg('ordmsg','Cancelled.','muted'); } },8000);
    return;
  }
  armPawscout=false; await applyMode('pawscout');
}
function alertEmailVal(){ return (el('alertemail')&&el('alertemail').value||'').trim(); }
async function sendTestEmail(){
  var b=el('testemailbtn'); var to=alertEmailVal();
  if(!to||to.indexOf('@')<0){ setMsg('ordmsg','Enter a valid email.','no'); return; }
  b.disabled=true; setMsg('ordmsg','Sending test email to '+to+'…','muted');
  try{
    var r=await api('/test-email',{to:to});
    if(!r.ok){ setMsg('ordmsg','Test email failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','Test email sent ✓ (Resend id '+(r.id||'?')+'). Check '+to+' (and spam).','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function saveAlertEmail(){
  var b=el('savealertbtn'); var to=alertEmailVal();
  if(to&&to.indexOf('@')<0){ setMsg('ordmsg','Enter a valid email (or clear it to disable alerts).','no'); return; }
  b.disabled=true;
  try{
    var r=await api('/fulfil',{mode:currentMode,alertEmail:to});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg',to?('Alert email saved - PawScout will notify '+to+' on each CJ order awaiting payment.'):'Alert email cleared - no awaiting-payment emails will be sent.','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function runFulfilNow(){
  var b=el('runbtn'); b.disabled=true;
  setMsg('ordmsg','Running fulfilment (create due CJ orders + poll tracking)…','muted');
  try{
    var r=await api('/fulfil-run',{});
    if(!r.ok){ setMsg('ordmsg','Fulfilment run failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','Fulfilment run ✓ - created/awaiting '+(r.awaiting||0)+', submitted '+(r.submitted||0)+', errored '+(r.errored||0)+', tracking checked '+(r.checked||0)+', fulfilled '+(r.fulfilled||0)+'.',(r.errored?'no':'ok'));
    loadOrders();
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function verifyCjOrders(){
  var b=el('cjdiagbtn'); b.disabled=true;
  setMsg('ordmsg','Checking CJ order API (read-only)…','muted');
  try{
    var r=await api('/cj-order-diag',{});
    if(!r.ok){ setMsg('ordmsg','CJ order API check failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('ordmsg','CJ order API reachable ✓ (read-only list returned).','ok');
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function loadOrders(){
  var btn=el('ordbtn'); btn.disabled=true;
  try{
    var r=await api('/orders',{});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    currentMode=r.mode||'manual'; currentCreateOnly=!!r.createOnly; renderMode();
    if(r.alertEmail&&el('alertemail')) el('alertemail').value=r.alertEmail;
    var list=el('ordlist');
    var awaiting=(r.orders||[]).filter(function(o){return o.status==='awaiting-payment';});
    var banner=el('awaitbanner');
    if(banner){
      if(awaiting.length){
        var ids=awaiting.map(function(o){return esc(o.cj||o.name||o.id);}).join(', ');
        banner.className='msg no'; banner.style.display='';
        banner.textContent='⚠ '+awaiting.length+' order(s) created in CJ awaiting your payment. Pay these CJ order(s) in app.cjdropshipping.com: '+ids+'. Tracking will sync back automatically once paid.';
      } else { banner.style.display='none'; banner.textContent=''; }
    }
    if(!r.orders.length){ list.innerHTML=''; setMsg('ordmsg','No orders yet.','muted'); return; }
    setMsg('ordmsg','','muted');
    var rows=r.orders.map(function(o){
      var holds=(o.holds&&o.holds.length)?(' · '+o.holds.join(', ')):'';
      var act='';
      if(o.status==='held') act='<button class="ghost" data-act="release" data-id="'+esc(o.id)+'">Release</button> <button class="ghost" data-act="cancel" data-id="'+esc(o.id)+'">Cancel</button>';
      else if(o.status==='queued') act='<button class="ghost" data-act="cancel" data-id="'+esc(o.id)+'">Cancel</button>';
      var tn=o.tracking?(' · '+esc(o.tracking)):'';
      var cjid=((o.status==='awaiting-payment'||o.status==='submitted')&&o.cj)?(' · CJ '+esc(o.cj)):'';
      return '<tr><td>'+esc(o.name||o.id)+'</td><td>'+esc((o.currency||'')+' '+(o.total!=null?o.total:''))+'</td><td><strong>'+esc(o.status)+'</strong>'+esc(holds)+cjid+tn+'</td><td>'+act+'</td></tr>';
    }).join('');
    list.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left">Order</th><th style="text-align:left">Total</th><th style="text-align:left">Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
    var bts=list.querySelectorAll('button[data-act]');
    for(var i=0;i<bts.length;i++){ bts[i].onclick=function(){ orderAction(this.getAttribute('data-id'), this.getAttribute('data-act')); }; }
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function orderAction(id,action){
  try{
    var r=await api('/order-action',{id:id,action:action});
    if(!r.ok){ setMsg('ordmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
    loadOrders();
  }catch(e){ setMsg('ordmsg','Failed: '+errText(e),'no'); }
}
async function fixCategoriesNow(){
  var btn=el('catbtn'); btn.disabled=true;
  try{
    setMsg('catmsg','Re-checking collection assignments…','muted');
    syncBar('frac',0);
    var offset=0, moved=0, total=0;
    for(;;){
      var r=await api('/categories',{offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('catmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      moved+=r.moved; total=r.total;
      var attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('catmsg','Checked '+Math.min(offset+r.scanned,total)+' of '+total+'… '+moved+' re-filed','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    syncBar('off');
    setMsg('catmsg','Done ✓ '+moved+' product'+(moved===1?'':'s')+' re-filed to a clearer collection ('+total+' checked).','ok');
  }catch(e){ syncBar('off'); setMsg('catmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function runDiag(){
  var btn=el('diagbtn'); btn.disabled=true;
  var out=el('diagout');
  out.className='msg muted'; out.textContent='Running CJ listV2 + Firecrawl (can take ~30s)…';
  try{
    var r=await api('/search-diag',{q:el('diagq').value});
    if(!r.ok){ out.className='msg no'; out.textContent='Failed: '+(r.error||'unknown'); return; }
    function fmt(list){ return (list||[]).map(function(x){ return '• '+esc(x.title)+(x.price!=null?(' - '+esc(x.price)):''); }).join('<br>'); }
    out.className='msg';
    out.innerHTML='<strong>Our listV2 ('+r.oursCount+')</strong><br>'+fmt(r.ours)+'<hr><strong>CJ website / Firecrawl ('+r.webCount+')</strong><br>'+fmt(r.web);
  }catch(e){ out.className='msg no'; out.textContent='Failed: '+errText(e); }
  finally{ btn.disabled=false; }
}
// --- Country combobox (searchable; single source of truth for the quote card) ---
var FQ_COUNTRIES=[
  {g:'UK & Ireland',c:'GB',n:'United Kingdom'},{g:'UK & Ireland',c:'IE',n:'Ireland'},
  {g:'Western Europe',c:'ES',n:'Spain'},{g:'Western Europe',c:'FR',n:'France'},{g:'Western Europe',c:'DE',n:'Germany'},
  {g:'Western Europe',c:'IT',n:'Italy'},{g:'Western Europe',c:'NL',n:'Netherlands'},{g:'Western Europe',c:'BE',n:'Belgium'},
  {g:'Western Europe',c:'PT',n:'Portugal'},{g:'Western Europe',c:'AT',n:'Austria'},{g:'Western Europe',c:'LU',n:'Luxembourg'},
  {g:'Western Europe',c:'CH',n:'Switzerland'},
  {g:'Nordics',c:'SE',n:'Sweden'},{g:'Nordics',c:'DK',n:'Denmark'},{g:'Nordics',c:'FI',n:'Finland'},{g:'Nordics',c:'NO',n:'Norway'},
  {g:'Central & Eastern Europe',c:'PL',n:'Poland'},{g:'Central & Eastern Europe',c:'CZ',n:'Czechia'},
  {g:'Central & Eastern Europe',c:'SK',n:'Slovakia'},{g:'Central & Eastern Europe',c:'HU',n:'Hungary'},
  {g:'Central & Eastern Europe',c:'RO',n:'Romania'},{g:'Central & Eastern Europe',c:'BG',n:'Bulgaria'},
  {g:'Central & Eastern Europe',c:'GR',n:'Greece'},{g:'Central & Eastern Europe',c:'HR',n:'Croatia'},
  {g:'Central & Eastern Europe',c:'SI',n:'Slovenia'},{g:'Central & Eastern Europe',c:'EE',n:'Estonia'},
  {g:'Central & Eastern Europe',c:'LV',n:'Latvia'},{g:'Central & Eastern Europe',c:'LT',n:'Lithuania'},
  {g:'North America',c:'US',n:'United States'},{g:'North America',c:'CA',n:'Canada'},
  {g:'Oceania',c:'AU',n:'Australia'},{g:'Oceania',c:'NZ',n:'New Zealand'},
  {g:'Asia & Middle East',c:'SG',n:'Singapore'},{g:'Asia & Middle East',c:'HK',n:'Hong Kong'},
  {g:'Asia & Middle East',c:'JP',n:'Japan'},{g:'Asia & Middle East',c:'KR',n:'South Korea'},
  {g:'Asia & Middle East',c:'MY',n:'Malaysia'},{g:'Asia & Middle East',c:'AE',n:'United Arab Emirates'},
  {g:'Asia & Middle East',c:'SA',n:'Saudi Arabia'}
];
var fqShown=[], fqActive=-1;
function fqFind(code){ for(var i=0;i<FQ_COUNTRIES.length;i++){ if(FQ_COUNTRIES[i].c===code) return FQ_COUNTRIES[i]; } return null; }
function fqCountryRender(filter){
  var f=(filter||'').trim().toLowerCase(), html='', lastG='';
  fqShown=[];
  for(var i=0;i<FQ_COUNTRIES.length;i++){
    var x=FQ_COUNTRIES[i];
    if(f && x.n.toLowerCase().indexOf(f)<0 && x.c.toLowerCase().indexOf(f)<0) continue;
    if(x.g!==lastG){ html+='<div class="combo-grp">'+esc(x.g)+'</div>'; lastG=x.g; }
    html+='<div class="combo-opt" data-code="'+x.c+'"><span>'+esc(x.n)+'</span><span class="cc">'+x.c+'</span></div>';
    fqShown.push(x.c);
  }
  el('fqcountrymenu').innerHTML=html||'<div class="combo-empty">No match</div>';
  fqActive=-1;
}
function fqCountryMenuClick(e){
  var opt=e.target.closest?e.target.closest('.combo-opt'):null;
  if(!opt) return;
  e.preventDefault(); // keep focus on the input so onblur doesn't pre-empt the pick
  fqCountryPick(opt.getAttribute('data-code'));
}
function fqHighlight(){
  var opts=el('fqcountrymenu').querySelectorAll('.combo-opt');
  for(var i=0;i<opts.length;i++){ if(i===fqActive){ opts[i].classList.add('active'); opts[i].scrollIntoView({block:'nearest'}); } else opts[i].classList.remove('active'); }
}
function fqCountryOpen(){ el('fqcountry').select(); fqCountryRender(''); el('fqcountrymenu').classList.add('on'); }
function fqCountryFilter(){ fqCountryRender(el('fqcountry').value); el('fqcountrymenu').classList.add('on'); }
function fqCountryClose(){ el('fqcountrymenu').classList.remove('on'); }
function fqCountryPick(code){ var x=fqFind(code); if(!x) return; var inp=el('fqcountry'); inp.value=x.n; inp.dataset.code=x.c; fqCountryClose(); }
function fqCountryBlur(){ setTimeout(function(){ fqCountryClose(); var inp=el('fqcountry'), x=fqFind(inp.dataset.code); if(x) inp.value=x.n; },150); }
function fqCountryKey(e){
  var open=el('fqcountrymenu').classList.contains('on');
  if(e.key==='ArrowDown'){ if(!open){ fqCountryFilter(); } fqActive=Math.min(fqActive+1,fqShown.length-1); fqHighlight(); e.preventDefault(); }
  else if(e.key==='ArrowUp'){ fqActive=Math.max(fqActive-1,0); fqHighlight(); e.preventDefault(); }
  else if(e.key==='Enter'){ if(open&&fqShown.length){ fqCountryPick(fqShown[fqActive<0?0:fqActive]); e.preventDefault(); } }
  else if(e.key==='Escape'){ fqCountryClose(); }
}
async function freightQuote(){
  var b=el('fqbtn'); b.disabled=true;
  var out=el('fqout');
  var pid=(el('fqpid').value||'').trim();
  var country=((el('fqcountry').dataset.code||'GB').trim().toUpperCase());
  var qty=Math.max(1,Math.min(100,parseInt(el('fqqty').value,10)||1));
  out.className='msg muted'; out.textContent='Asking CJ for live freight on '+qty+'× to '+esc(country)+'…';
  try{
    var r=await api('/freight-quote',{pid:pid,country:country,qty:qty});
    if(!r.ok){ out.className='msg no'; out.textContent='Failed: '+(r.error||'unknown'); return; }
    if(!r.options.length){ out.className='msg no'; out.textContent='CJ returned no shipping lines to '+esc(r.country)+' for this product.'; return; }
    var rows=r.options.map(function(o){ return '<tr><td>'+esc(o.name)+'</td><td>$'+esc(o.usd.toFixed(2))+'</td><td>£'+esc(o.gbp.toFixed(2))+'</td><td class="muted">'+esc(o.days||'')+' days</td></tr>'; }).join('');
    out.className='msg';
    out.innerHTML='<strong>'+esc(r.product)+'</strong><br><span class="muted">'+esc(String(r.qty||qty))+'× · ships from '+esc(r.origin)+' → '+esc(r.country)+'</span>'
      +'<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px"><thead><tr><th style="text-align:left">Line</th><th style="text-align:left">USD</th><th style="text-align:left">GBP</th><th style="text-align:left">Aging</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){ out.className='msg no'; out.textContent='Failed: '+errText(e); }
  finally{ b.disabled=false; }
}
async function syncNow(){
  var btn=el('syncbtn'); btn.disabled=true;
  var failures=[];
  try{
    setMsg('syncmsg','Syncing prices & stock with CJ…','muted');
    syncBar('frac',0);
    var offset=0, done=0, attempted=0, total=0;
    for(;;){
      var r=await api('/sync',{phase:'inventory',offset:offset});
      if(!r.ok){ syncBar('off'); setMsg('syncmsg','Failed: '+(r.error||'unknown error'),'no'); return; }
      done+=r.synced; total=r.total;
      if(r.errors&&r.errors.length) failures=failures.concat(r.errors);
      attempted=(r.next==null)?total:r.next;
      syncBar('frac',total?attempted/total:1);
      setMsg('syncmsg','Synced '+done+' of '+total+' products… ('+attempted+' checked)','muted');
      if(r.next==null) break;
      offset=r.next;
    }
    setMsg('syncmsg','Topping up collections from the warehouse…','muted');
    syncBar('pulse');
    var promoted=0;
    for(;;){
      var p=await api('/sync',{phase:'refill'});
      if(!p.ok){ syncBar('off'); setMsg('syncmsg','Sync done ('+done+' products) - refill failed: '+(p.error||'unknown error'),'no'); return; }
      promoted+=p.imported;
      if(p.next==null) break;
    }
    syncBar('off');
    if(failures.length&&done<total){
      setMsg('syncmsg','Synced '+done+' of '+total+' - '+(total-done)+' failed. First error: '+failures[0],'no');
    } else {
      setMsg('syncmsg','Done ✓ '+done+' products synced'+(promoted?', '+promoted+' promoted from warehouse':'')+'.','ok');
    }
    loadInsights();
  }catch(e){ syncBar('off'); setMsg('syncmsg','Failed: '+errText(e),'no'); }
  finally{ btn.disabled=false; }
}
async function saveAddons(){
  setMsg('addmsg','Saving…','muted');
  try{
    var r=await api('/addons',{
      enabled:el('addon').value==='true',
      priceMinUsd:Number(el('addmin').value),
      priceMaxUsd:Number(el('addmax').value),
      poolSize:Number(el('addpool').value),
      suppressFromBrowse:el('addvis').value==='true'
    });
    if(r.ok){ setMsg('addmsg','Saved ✓','ok'); refresh(); }
    else setMsg('addmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('addmsg','Failed: '+errText(e),'no'); }
}
function setGbStatus(n,on){
  var elx=el('gb-profile-status'); if(!elx) return;
  n=Number(n)||0; elx.dataset.count=String(n);
  elx.textContent='GB Local profile: '+n+' GB-warehoused product'+(n===1?'':'s')+' · free UK shipping '+(on?'ON':'off');
}
async function saveGbFreeUk(){
  var on=el('gb-free-uk-chk').checked;
  try{
    var r=await api('/gb-free-uk',{on:on});
    if(r&&r.ok){ setGbStatus(el('gb-profile-status').dataset.count, on); }
    else { el('gb-free-uk-chk').checked=!on; }
  }catch(e){ el('gb-free-uk-chk').checked=!on; }
}
async function syncGbLocal(){
  var b=el('gb-sync-btn'); b.disabled=true; setMsg('gb-sync-msg','Syncing…','muted');
  try{
    var r=await api('/gb-sync',{});
    if(r&&r.ok){
      var res=r.result||{}; var profs=res.profiles||[];
      var anyChanged=profs.some(function(p){return p.added||p.removed;});
      setMsg('gb-sync-msg', profs.length&&anyChanged?'Synced':'No change','ok');
      var lines=profs.map(function(p){return p.sig+': '+p.zones+' zones (+'+p.added+'/-'+p.removed+')';});
      lines.push('GB isolated in its own zone: '+r.gbIsolated);
      el('gb-sync-result').textContent=lines.join('\\n');
    } else { setMsg('gb-sync-msg','Failed: '+((r&&r.error)||'unknown error'),'no'); }
  }catch(e){ setMsg('gb-sync-msg','Failed: '+errText(e),'no'); }
  finally{ b.disabled=false; }
}
async function saveCollections(){
  setMsg('mapmsg','Saving…','muted');
  try{
    var map={};
    var rows=el('maprows').querySelectorAll('.maprow');
    for(var i=0;i<rows.length;i++){
      var ins=rows[i].querySelectorAll('input');
      var h=ins[0].value.trim(), t=ins[1].value.trim();
      if(!h&&!t) continue;
      if(!h||!t){ setMsg('mapmsg','Each mapping needs both a handle and a tag.','no'); return; }
      map[h]={handle:h,tag:t};
    }
    var r=await api('/collections',map);
    if(r.ok){ setMsg('mapmsg','Saved ✓','ok'); refresh(); }
    else setMsg('mapmsg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('mapmsg','Failed: '+errText(e),'no'); }
}
var currentInboxCfg={enabled:true,labels:[]};
var INBOX_AGENTS=[
  ['shipping-returns','Shipping & Returns'],['order-status','Order Status'],
  ['product-question','Product Questions'],['lead','Sales Leads'],
  ['wholesale-b2b','Wholesale / Trade'],['affiliate','Affiliate / Partnership'],
  ['complaint','Complaints'],['other','General']
];
function renderAgents(cfg){
  var list=el('agents-list'); if(!list) return;
  var master=!!(cfg&&cfg.autosend); var agents=(cfg&&cfg.agents)||{};
  list.innerHTML='';
  INBOX_AGENTS.forEach(function(a){
    var key=a[0], name=a[1], on=!!(agents[key]&&agents[key].autosend);
    var row=document.createElement('div'); row.className='agents-row'+(master?'':' is-disabled');
    var lbl=document.createElement('span'); lbl.textContent=name;
    var sw=document.createElement('input'); sw.type='checkbox'; sw.checked=on; sw.disabled=!master;
    sw.setAttribute('data-agent',key);
    sw.onchange=function(){
      saveInboxSettings().then(function(ok){
        setMsg('inboxmsg', ok?(name+' auto-reply '+(sw.checked?'ON.':'OFF.')):'Could not save '+name+' - try again.', ok?'ok':'no');
        if(!ok){ sw.checked=!sw.checked; }
      });
    };
    row.appendChild(lbl); row.appendChild(sw); list.appendChild(row);
  });
}
function collectAgents(){
  var out={}; var rows=document.querySelectorAll('#agents-list input[data-agent]');
  for(var i=0;i<rows.length;i++){ out[rows[i].getAttribute('data-agent')]={autosend:!!rows[i].checked}; }
  return out;
}
function setReplyModeUI(on){
  var wrap=el('reply-mode'), st=el('reply-mode-state'), ds=el('reply-mode-desc');
  if(wrap) wrap.className='reply-mode'+(on?' is-auto':'');
  if(st) st.textContent=on?'Automatic - human review OFF':'Manual review';
  if(ds) ds.textContent=on
    ?'PawScout emails customers automatically when its confidence is at or above the threshold. No human review.'
    :'Drafts wait here for you to approve and send - nothing is emailed to customers automatically.';
  renderAgents({autosend:on,agents:collectAgents()});
}
async function onReplyModeToggle(){
  var chk=el('inbox-autosend-chk'); if(!chk) return;
  if(chk.checked && !confirm('Turn ON automatic replies?\\n\\nThis switches OFF human review: PawScout will email customers on its own when its confidence is high. You can turn it back off here anytime.')){
    chk.checked=false; setReplyModeUI(false); return;
  }
  setReplyModeUI(chk.checked);
  var ok=await saveInboxSettings();
  setMsg('inboxmsg', ok?('Reply mode set to '+(chk.checked?'Automatic.':'Manual.')):'Could not save reply mode - try the Save button in Inbox settings.', ok?'ok':'no');
}
async function loadInboxSettings(){
  try{
    var r=await api('/inbox/config',{});
    if(!r.ok||!r.inbox) return;
    var cfg=r.inbox;
    currentInboxCfg={enabled:cfg.enabled!==false,labels:Array.isArray(cfg.labels)?cfg.labels:[]};
    var chk=el('inbox-autosend-chk'); if(chk) chk.checked=!!cfg.autosend;
    setReplyModeUI(!!cfg.autosend);
    renderAgents(cfg);
    renderInboxAutoPill(cfg); // read-only automation pill in the Inbox workspace header
    var at=el('inbox-auto-thresh'); if(at&&cfg.autoConfidenceThreshold!=null) at.value=cfg.autoConfidenceThreshold;
    var it=el('inbox-intent-thresh'); if(it&&cfg.intentThreshold!=null) it.value=cfg.intentThreshold;
    var ae=el('inbox-alert-email'); if(ae&&cfg.alertEmail) ae.value=cfg.alertEmail;
    var gt=el('inbox-guidance-ta'); if(gt) gt.value=cfg.replyGuidance||'';
    var am=el('affiliate-mode'); if(am&&cfg.affiliateMode) am.value=cfg.affiliateMode;
    // Invoice settings
    var aichk=el('inbox-autoinvoice-chk'); if(aichk) aichk.checked=!!cfg.autoInvoice;
    var ict=el('inbox-invoice-conf-thresh'); if(ict&&cfg.invoiceConfidenceThreshold!=null) ict.value=cfg.invoiceConfidenceThreshold;
    var ivc=el('inbox-invoice-value-ceiling'); if(ivc&&cfg.invoiceValueCeiling!=null) ivc.value=cfg.invoiceValueCeiling;
    var irl=el('inbox-invoice-rate-limit'); if(irl&&cfg.invoiceRateLimit!=null) irl.value=cfg.invoiceRateLimit;
    var ssb=el('inbox-settings-save'); if(ssb) ssb.onclick=saveInboxSettings;
  }catch(e){ setMsg('inboxcfgmsg','Could not load inbox settings.','no'); }
}
async function saveInboxSettings(){
  setMsg('inboxcfgmsg','Saving…','muted');
  var chk=el('inbox-autosend-chk');
  var at=el('inbox-auto-thresh');
  var it=el('inbox-intent-thresh');
  var ae=el('inbox-alert-email');
  var gt=el('inbox-guidance-ta');
  var aichk=el('inbox-autoinvoice-chk');
  var ict=el('inbox-invoice-conf-thresh');
  var ivc=el('inbox-invoice-value-ceiling');
  var irl=el('inbox-invoice-rate-limit');
  try{
    var payload={
      enabled:currentInboxCfg.enabled,
      labels:currentInboxCfg.labels,
      autosend:!!(chk&&chk.checked),
      autoConfidenceThreshold:Number(at&&at.value||80),
      intentThreshold:Number(it&&it.value||70),
      alertEmail:(ae&&ae.value.trim())||'',
      replyGuidance:(gt&&gt.value)||'',
      autoInvoice:!!(aichk&&aichk.checked),
      invoiceConfidenceThreshold:Number(ict&&ict.value||95),
      invoiceValueCeiling:Number(ivc&&ivc.value||250),
      invoiceRateLimit:Math.max(1,parseInt((irl&&irl.value)||'2',10)||2),
      affiliateMode:(el('affiliate-mode')&&el('affiliate-mode').value)||'funnel_voucher',
      agents:collectAgents()
    };
    var r=await api('/inbox/config',payload);
    if(r.ok){ setMsg('inboxcfgmsg','Saved ✓','ok'); renderInboxAutoPill(payload); return true; }
    setMsg('inboxcfgmsg','Failed: '+esc(r.error||'unknown error'),'no'); return false;
  }catch(e){ setMsg('inboxcfgmsg','Failed: '+errText(e),'no'); return false; }
}
${inboxJs}
${glanceJs}
${auditJs}
${partnersJs}
refresh();
loadInsights();
loadGlance();
loadInboxThreads();
loadInboxSettings();
loadAudit();
loadPartners();
${routerJs}</script>
</body></html>`;
  // no-store: the console is a single server-rendered page that changes every
  // deploy - a cached copy after a release is exactly the stale-console bug the
  // owner had to hard-refresh around (Phase 2 cutover). Nothing here is cacheable.
  return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
}
