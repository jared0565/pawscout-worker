// Subresource Integrity note:
// The two CDN assets below are loaded WITHOUT SRI deliberately.
// Shopify's app-bridge.js is EVERGREEN and MUST be loaded unpinned —
// an `integrity` hash breaks it the moment Shopify ships an update
// (this is Shopify's own guidance). Do NOT add SRI to app-bridge.js.
// For the Polaris stylesheet, either (a) pin a versioned Polaris CSS URL
// and add `integrity="sha384-…" crossorigin="anonymous"`, or (b) self-host
// the CSS from the Worker's static assets (preferred — removes the
// third-party CDN dependency entirely). Apply SRI/self-hosting to any
// pinnable third-party asset; App Bridge is the one deliberate exception.

export function consolePage(apiKey: string, host: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.shopify.com/static/polaris/polaris.min.css">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
</head><body style="font-family:sans-serif;padding:1rem;max-width:640px">
<h1>PawScout</h1>
<section><h2>1. Connect CJ</h2>
  <input id="cj" placeholder="CJ API key" style="width:100%"><button onclick="connectCj()">Connect</button>
  <p id="cjstatus"></p></section>
<section><h2>2. Quality gates</h2>
  <label>Popularity floor <input id="pf" type="number" value="50"></label>
  <button onclick="saveGates()">Save gates</button></section>
<pre id="status"></pre>
<script>
const host=${JSON.stringify(host)};
async function token(){ const ab=window['app-bridge']; const app=ab.createApp({apiKey:${JSON.stringify(apiKey)},host}); return await ab.actions.SessionToken.getToken(app); }
async function api(path,body){ const t=await token(); const r=await fetch('/api'+path,{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json(); }
async function refresh(){ const s=await api('/status'); document.getElementById('status').textContent=JSON.stringify(s,null,2); document.getElementById('cjstatus').textContent=s.cjConnected?'Connected ✓':'Not connected'; }
async function connectCj(){ const r=await api('/connect-cj',{apiKey:document.getElementById('cj').value}); if(!r.ok)alert(r.error); refresh(); }
async function saveGates(){ await api('/gates',{popularityFloor:Number(document.getElementById('pf').value),priceMin:5,priceMax:80,relevance:'title'}); refresh(); }
refresh();
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
