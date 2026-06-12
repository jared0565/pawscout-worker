// PawScout CJ relay — see relay/README.md for why this exists.
// Zero-dependency Node server: forwards /cj/* to CJ's origin from this
// machine's dedicated egress IP. Refuses everything else.
import http from 'node:http';

const CJ_ORIGIN = 'https://developers.cjdropshipping.com';
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.RELAY_TOKEN;

if (!TOKEN) {
  console.error('RELAY_TOKEN is not set — refusing to start an open proxy.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.headers['x-relay-token'] !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
    return;
  }
  if (!req.url.startsWith('/cj/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"unknown path"}');
    return;
  }

  const target = CJ_ORIGIN + req.url.slice('/cj'.length);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const h of ['content-type', 'cj-access-token', 'accept', 'user-agent']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json'
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `relay upstream failure: ${e.message}` }));
  }
});

server.listen(PORT, () => console.log(`pawscout-relay listening on :${PORT}`));
