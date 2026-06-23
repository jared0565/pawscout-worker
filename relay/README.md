# PawScout CJ Relay

A ~60-line authenticated relay that forwards CJdropshipping API calls from a
**dedicated egress IP** on Fly.io.

**Why it exists:** CJ allows at most **3 API accounts per source IP**
(`code 1600200: "one ip limit 3 users"`). Cloudflare Workers send outbound
traffic from a shared egress pool already saturated with other CJ users, so
direct Worker→CJ calls get HTTP 429 regardless of our own request rate. This
relay's static egress IP has exactly one CJ user: us.

The Worker rewrites any `https://developers.cjdropshipping.com/...` request to
`https://<this-app>.fly.dev/cj/...` with an `X-Relay-Token` header (see
`relayedFetch` in `src/cj.ts`). The relay forwards only to CJ's origin -
it is not a general-purpose proxy.

## Deploy (one-time, ~5 minutes)

```bash
# 1. Install flyctl and log in (https://fly.io/docs/flyctl/install/)
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From this directory:
cd relay
fly launch --no-deploy        # accepts this fly.toml; pick/confirm a unique app name

# 3. Set the shared secret (SAVE THIS VALUE - the worker needs it too)
fly secrets set RELAY_TOKEN=$(openssl rand -hex 32)

# 4. Deploy, then allocate the dedicated egress IP ($3.60/mo)
fly deploy
fly ips allocate-egress -r lhr

# 5. Verify
curl https://<your-app-name>.fly.dev/healthz     # -> ok
```

## Point the Worker at it

```bash
cd ..   # back to pawscout-worker
wrangler secret put CJ_RELAY_URL     # https://<your-app-name>.fly.dev
wrangler secret put CJ_RELAY_TOKEN   # the RELAY_TOKEN value from step 3
npm run deploy
```

Without these two secrets the Worker falls back to direct CJ calls (useful for
local dev; broken in production because of the IP rule above).
