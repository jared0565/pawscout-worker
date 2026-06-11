// Subresource Integrity note:
// app-bridge.js is loaded WITHOUT SRI deliberately — it is EVERGREEN and Shopify
// ships updates continuously; an `integrity` hash would break it on the next update
// (Shopify's own guidance). App Bridge v4 exposes a global `shopify` and reads the
// API key from the <meta name="shopify-api-key"> tag, which MUST appear before the
// script. `host` is read from the URL by App Bridge itself — no createApp needed.
//
// Theme note: this renders inside Shopify admin's iframe, which is usually DARK (admin
// dark mode follows the OS color-scheme). The console must feel native, not alien — so
// it defaults to a DARK palette congruent with Polaris dark, and flips to LIGHT only
// when the environment prefers light (`@media (prefers-color-scheme: light)`). Colors
// are explicit in BOTH modes — never inherit, or text washes out. Keep both palettes in
// sync: every --token defined in :root must have a light counterpart in the media query.
//
// Feedback note: this app renders inside Shopify admin's cross-origin iframe, where
// window.alert()/confirm() are silently blocked. ALL user feedback must be inline
// (writing into DOM elements) — never alert(). Do not reintroduce alert() here.

export function consolePage(apiKey: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${apiKey}">
<meta name="color-scheme" content="dark light">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
  /* DARK is the default — it matches Shopify admin dark mode (the usual environment). */
  :root{
    color-scheme:dark light;
    --bg:#1a1a1a; --surface:#2a2a2b; --ink:#e3e3e3; --subdued:#a8abb0;
    --border:#444748; --accent:#e3e3e3; --accent-ink:#1a1a1a;
    --ok-bg:#11331f; --ok-ink:#8fe0a6; --no-bg:#3a1714; --no-ink:#f4a39c;
    --field:#1a1a1a; --field-border:#6a6e73; --code-bg:#1a1a1a; --shadow:rgba(0,0,0,.3);
  }
  /* LIGHT — only when the environment prefers it. Keep tokens in sync with the dark set. */
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f1f2f4; --surface:#ffffff; --ink:#1a1a1a; --subdued:#5c5f62;
      --border:#d2d5d8; --accent:#008060; --accent-ink:#ffffff;
      --ok-bg:#e3f1df; --ok-ink:#0c5132; --no-bg:#fff0f0; --no-ink:#8e1f0b;
      --field:#ffffff; --field-border:#8a8d91; --code-bg:#f1f2f4; --shadow:rgba(0,0,0,.04);
    }
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
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>PawScout</h1>
    <p class="sub">Supplier intelligence &amp; inventory population for your store.</p>
  </header>

  <section class="card">
    <h2><span class="step">1</span> Connect CJ</h2>
    <div class="row">
      <div class="grow">
        <label for="cj">CJ API key</label>
        <input id="cj" type="text" placeholder="CJ&lt;email&gt;@api@&lt;token&gt;" autocomplete="off" spellcheck="false">
      </div>
      <button id="cjbtn" onclick="connectCj()">Connect</button>
    </div>
    <p id="cjstatus" class="msg muted">Checking…</p>
  </section>

  <section class="card">
    <h2><span class="step">2</span> Quality gates</h2>
    <div class="row">
      <div class="grow">
        <label for="pf">Popularity floor</label>
        <input id="pf" type="number" value="50" min="0">
      </div>
      <div class="grow">
        <label for="pmin">Price min ($)</label>
        <input id="pmin" type="number" value="5" min="0" step="0.01">
      </div>
      <div class="grow">
        <label for="pmax">Price max ($)</label>
        <input id="pmax" type="number" value="80" min="0" step="0.01">
      </div>
    </div>
    <div class="row">
      <div class="grow">
        <label for="rel">Relevance</label>
        <select id="rel">
          <option value="loose">Loose — any keyword match</option>
          <option value="title" selected>Title — keyword in title</option>
          <option value="strict">Strict — all keywords in title</option>
        </select>
      </div>
      <div class="grow">
        <label for="tgt">Target per collection</label>
        <input id="tgt" type="number" value="16" min="1" max="200" step="1">
      </div>
      <button onclick="saveGates()">Save gates</button>
    </div>
    <p id="gatesmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2><span class="step">3</span> Collection map</h2>
    <p class="sub" style="margin:0 0 12px">Map each storefront collection handle to the supplier tag that fills it. Lowercase letters, digits and hyphens only.</p>
    <div id="maprows"></div>
    <div class="row">
      <button class="ghost" type="button" onclick="addMapRow('','')">Add mapping</button>
      <button type="button" onclick="saveCollections()">Save collections</button>
    </div>
    <p id="mapmsg" class="msg muted"></p>
  </section>

  <section class="card">
    <h2>Current configuration</h2>
    <div id="status"><p class="muted">Loading…</p></div>
  </section>
</div>

<script>
function el(id){ return document.getElementById(id); }
function setMsg(id,t,kind){ var n=el(id); if(!n) return; n.textContent=t; n.className='msg '+(kind||'muted'); }
function errText(e){ return e&&e.message?e.message:String(e); }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
async function token(){ return await shopify.idToken(); }
async function api(path,body){
  var t=await token();
  var r=await fetch('/api'+path,{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  return r.json();
}
function renderStatus(s){
  var g=s.gates||{};
  var rows=''
    +'<dt>CJ supplier</dt><dd><span class="badge '+(s.cjConnected?'ok':'no')+'">'+(s.cjConnected?'Connected':'Not connected')+'</span></dd>'
    +'<dt>Popularity floor</dt><dd>'+esc(g.popularityFloor)+'</dd>'
    +'<dt>Price range</dt><dd>$'+esc(g.priceMin)+' – $'+esc(g.priceMax)+'</dd>'
    +'<dt>Relevance</dt><dd>'+esc(g.relevance)+'</dd>'
    +'<dt>Target count</dt><dd>'+esc(s.target)+'</dd>';
  var cm=s.collectionMap||{}; var keys=Object.keys(cm);
  var cols = keys.length
    ? keys.map(function(k){ var v=cm[k]||{}; return '<li><strong>'+esc(v.handle||k)+'</strong> <span class="muted">← tag</span> <code>'+esc(v.tag)+'</code></li>'; }).join('')
    : '<li class="muted">No collections mapped</li>';
  el('status').innerHTML='<dl class="kv">'+rows+'</dl><hr><div class="muted" style="font-weight:550;color:var(--ink)">Collection map</div><ul class="cols">'+cols+'</ul>';
}
// Forms are populated from the server exactly once — refresh() after a save
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
  field('supplier tag (e.g. cj-cat-pet-toys)',tag);
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
    setMsg('cjstatus', s.cjConnected?'Connected ✓':'Not connected — enter your CJ API key above.', s.cjConnected?'ok':'muted');
  }catch(e){
    el('status').innerHTML='<p class="msg no">Could not load configuration: '+esc(errText(e))+'</p>';
    setMsg('cjstatus','Could not reach PawScout. Reload the page.','no');
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
refresh();
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
