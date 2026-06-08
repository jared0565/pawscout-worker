// Subresource Integrity note:
// app-bridge.js is loaded WITHOUT SRI deliberately — it is EVERGREEN and Shopify
// ships updates continuously; an `integrity` hash would break it on the next update
// (Shopify's own guidance). App Bridge v4 exposes a global `shopify` and reads the
// API key from the <meta name="shopify-api-key"> tag, which MUST appear before the
// script. `host` is read from the URL by App Bridge itself — no createApp needed.
// For the Polaris stylesheet, either pin a versioned URL with integrity=… or
// self-host from the Worker's static assets (preferred — drops the CDN dependency).
//
// Feedback note: this app renders inside Shopify admin's cross-origin iframe, where
// window.alert()/confirm() are silently blocked. ALL user feedback must be inline
// (writing into DOM elements) — never alert(). Do not reintroduce alert() here.

export function consolePage(apiKey: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="shopify-api-key" content="${apiKey}">
<link rel="stylesheet" href="https://cdn.shopify.com/static/polaris/polaris.min.css">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
</head><body style="font-family:sans-serif;padding:1rem;max-width:640px">
<h1>PawScout</h1>
<section><h2>1. Connect CJ</h2>
  <input id="cj" placeholder="CJ API key (CJ&lt;email&gt;@api@&lt;token&gt;)" style="width:100%">
  <button id="cjbtn" onclick="connectCj()">Connect</button>
  <p id="cjstatus"></p></section>
<section><h2>2. Quality gates</h2>
  <label>Popularity floor <input id="pf" type="number" value="50"></label>
  <button onclick="saveGates()">Save gates</button> <span id="gatesmsg"></span></section>
<pre id="status"></pre>
<script>
function setMsg(id,t){ document.getElementById(id).textContent=t; }
function errText(e){ return e&&e.message?e.message:String(e); }
async function token(){ return await shopify.idToken(); }
async function api(path,body){ const t=await token(); const r=await fetch('/api'+path,{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json(); }
async function refresh(){ try{ const s=await api('/status'); document.getElementById('status').textContent=JSON.stringify(s,null,2); setMsg('cjstatus', s.cjConnected?'Connected ✓':'Not connected'); }catch(e){ setMsg('status','Error loading status: '+errText(e)); } }
async function connectCj(){
  const btn=document.getElementById('cjbtn'); btn.disabled=true; setMsg('cjstatus','Connecting…');
  try{
    const r=await api('/connect-cj',{apiKey:document.getElementById('cj').value.trim()});
    if(r.ok){ setMsg('cjstatus','Connected ✓'); refresh(); }
    else { setMsg('cjstatus','Failed: '+(r.error||'unknown error')); }
  }catch(e){ setMsg('cjstatus','Failed: '+errText(e)); }
  finally{ btn.disabled=false; }
}
async function saveGates(){
  setMsg('gatesmsg','Saving…');
  try{ await api('/gates',{popularityFloor:Number(document.getElementById('pf').value),priceMin:5,priceMax:80,relevance:'title'}); setMsg('gatesmsg','Saved ✓'); refresh(); }
  catch(e){ setMsg('gatesmsg','Failed: '+errText(e)); }
}
refresh();
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
