# Conge RPC proxy (Cloudflare Worker)

A thin, read-only JSON-RPC proxy for `https://rpc.mainnet.chain.robinhood.com`
(optionally a private node-provider endpoint first — see
[Private upstream](#private-upstream-optional)), so Conge's browser code
never has to call an RPC directly. It exists
because the RPC has been reported unreachable from some networks (a TLS
certificate problem that a browser reports identically to a CORS
failure — see the main [README](../README.md#troubleshooting-network-connectivity)).
This Worker sits in front of it on Cloudflare's edge instead.

It is a single file (`index.js`), no dependencies, no build step, no
KV/D1, and it never logs request bodies. Its only secret is the optional
private upstream URL, which lives in Cloudflare, never in this repo. The only thing it
keeps is a short-lived cache of public chain data (see
[Caching](#caching-and-stale-if-error)) — nothing about visitors.

## What it does and doesn't do

- **`POST /`** — accepts one JSON-RPC request, or a batch of up to 10, and
  forwards only the allowed ones upstream:
  - Allowed methods: `eth_chainId`, `eth_blockNumber`, `eth_call`,
    `eth_getCode`. Anything else gets a JSON-RPC `-32601` error back
    without ever reaching the upstream.
  - Params are validated: addresses and call data must be well-formed hex;
    the block tag must be exactly `"latest"` (no historical reads). For
    `eth_call`, an optional third parameter (state overrides) is passed
    through to the upstream untouched — it's not validated, since its
    shape is caller-defined.
  - Request bodies over 20 KB are rejected before they're parsed.
  - Requests are restricted to the site's exact origins —
    `https://conge.site` and `https://www.conge.site` — with no wildcard. This is enforced **server-side**, not just through CORS
    headers. Any POST whose `Origin` isn't exactly that, including one with
    no `Origin` at all (curl's default), gets `403` before the body is read
    or anything reaches the upstream. The `OPTIONS` preflight is checked the
    same way. CORS headers alone would only stop a *browser* from reading
    the response; they don't stop a script from sending the request.
  - The Worker enforces an 8 second timeout on the upstream call. If the
    upstream fails, times out, or returns something that isn't valid
    JSON, the Worker responds `502` with `{"error": "...", "detail":
    "..."}` describing what went wrong.
- **`GET /health`** — calls `eth_chainId` and `eth_blockNumber` upstream
  and reports whether the RPC is reachable. Unlike `POST /`, this endpoint
  is **not** origin-restricted, and it returns no secrets, just status. It's
  meant to be opened directly in a phone browser as a one-tap diagnostic: a
  plain top-level navigation isn't subject to CORS and sends no `Origin`.
  Because anyone can call it, one upstream check is shared by every
  `/health` request for 15 seconds, including requests that arrive while the
  check is still running. Hammering it therefore can't multiply load on the
  shared upstream RPC.
- It never holds funds, signs anything, or writes any state — the
  allowed methods are all reads.

## Caching and stale-if-error

The shared upstream RPC rate-limits (`429`) under bursts, and scanning
the same token twice used to repeat every upstream call. The Worker now
caches **each call on its own** in Cloudflare's edge cache (the Cache
API):

| Method | Fresh for | Notes |
|---|---|---|
| `eth_call` | 60 seconds | contract state can change any block |
| `eth_getCode` | 10 minutes | code almost never changes |
| `eth_chainId` | 1 hour | never changes |
| `eth_blockNumber` | not cached | always live |

- **Per call, not per batch.** In a batch, cached calls are answered
  straight from the cache and only the rest are sent upstream, then
  everything is put back in the caller's original order with the caller's
  own `id`s.
- **Identical calls are merged.** If one request contains the same call
  twice (same method, contract, `from`, call data and state override —
  letter case doesn't matter), it's sent upstream once and the answer is
  copied to both.
- **Only successes are cached.** A JSON-RPC error (e.g. a revert), a
  `429`/`5xx`, a timeout or any other upstream failure is never stored.
- **Stale-if-error.** If the upstream still fails after its retries, each
  call that needed it gets its cached answer if one is **at most 10
  minutes old**, and the response is marked `X-Conge-Cache: stale`. Stale
  data is never returned without that header. *Trade-off:* during an
  upstream outage a visitor may see a result up to 10 minutes old instead
  of "Unknown" for that check; on a read-only scanner, slightly old public
  data is more useful than nothing, and the header keeps it detectable.
- **One failure never hides another answer** (opt-in: the page posts to
  `/?partial=1`). When the upstream fails but
  some calls in the request were answered (fresh from the cache, or
  stale), the response is still `200`: the answered calls get their
  results, and each call that couldn't be answered gets its own JSON-RPC
  error — `{"code": -32005, "message": "Upstream RPC request failed: …",
  "data": {"kind": "upstream-rate-limited"}}` (or `-32603` with kind
  `upstream-unreachable` for any other upstream failure). Only when no
  call at all has an answer is the whole request failed with `502`,
  exactly as before. The site treats such a per-call error as "the RPC
  was busy", never as a revert: owner() and the Uniswap v4 balance keep
  whichever succeeded, while the sell simulation treats the whole batch
  as not completed, so a busy RPC can never look like "selling is
  blocked". Without `?partial=1` (an older copy of the page), a request
  that can't be fully answered fails with `502` as before (stale-if-error
  still applies when every call has a fallback), so an older page never
  sees an error it could misread. It's a query parameter, not a header,
  so the CORS preflight is unchanged and the page and the Worker can be
  updated in either order.
- **Response header.** Every `POST /` answer carries `X-Conge-Cache`:
  `hit` (all from cache), `partial`, `miss`, `stale`, or `bypass`
  (nothing cacheable, e.g. only `eth_blockNumber`). It's exposed to the
  browser via `Access-Control-Expose-Headers`.
- **What's stored, privacy-wise.** Only the `result` of a successful call,
  under a key that is a SHA-256 hash of the method and its call data —
  all public chain data. Nothing about the visitor (IP, origin, headers,
  timing) is part of the key or the entry, nothing is logged, and entries
  expire by themselves (kept at most 10 minutes, 1 hour for
  `eth_chainId`).
- **Custom domain only.** The Cache API only works on a custom domain,
  so caching is active on `rpc.conge.site`. On the `workers.dev` address
  it stores nothing and every call goes upstream (merging identical calls
  still works). Each Cloudflare data center has its own cache, so a
  visitor in another region may not get a hit.

**Retry jitter.** Each retry delay (`400ms, 800ms, 1600ms, 3200ms`) is
randomized by ±25%, so visitors rate-limited at the same moment don't all
retry in lockstep. The 8 second overall deadline is unchanged; the
deadline check uses the jittered delay.

## Private upstream (optional)

The public RPC rate-limits (`429`) traffic coming from Cloudflare's shared
IP addresses. If you have a private endpoint from a node provider (its URL
usually contains an API key), the Worker can use it first, with the public
RPC as a fallback.

**The URL lives only in a Cloudflare secret named `UPSTREAM_RPC_URL`** —
never in this repository, never in `index.js`.

- **Secret set to a valid `https://` URL:** that endpoint is tried first,
  with the normal retries (jittered backoff) for up to **5.5s**. If it
  still fails — rate limited, `5xx`, timeout, network error, rejected key —
  the Worker tries the public RPC **once**, with the remaining time (at
  least **2.5s**). Only after that does it fall back to stale cache or
  return an error. The overall limit stays **8s**.
- **Secret not set, empty, or not a valid `https://` URL:** it's ignored
  and only the public RPC is used, with the full 8s and retries, exactly
  as before.
- **Which one answered:** every `POST /` response carries
  `X-Conge-Upstream`, readable by the page:
  `private`, `public` (no private upstream set), `public-fallback` (the
  private one failed and the public one was tried) or `none` (everything
  came from the cache). `/health` reports the same as `upstream.source`.
  Neither ever contains the URL.
- **Never leaked.** The URL, or any part of it, is never put in a
  response, an error `detail`, a header or a log. Error details are
  written by the Worker itself (a status code and the kind of failure,
  never the runtime's raw error text, which could quote the URL). A
  provider's own per-call error messages are passed on (revert reasons are
  useful) with anything taken from the URL replaced by `[redacted]`;
  `/health` never echoes provider messages at all.
- **Nothing else changes:** the same allow-lists, `"latest"` rule and
  limits; the cache is shared between both upstreams and its key never
  includes the upstream URL.
- **Privacy:** the private provider receives exactly the same public
  chain calls the public RPC would (contract addresses and call data) —
  nothing about visitors: no IP, no origin, no headers are forwarded.

### Adding the secret in the Cloudflare dashboard (works on a phone)

1. Open **dash.cloudflare.com** and sign in. If the page is cramped, turn
   on your browser's **"Desktop site"** option.
2. Go to **Workers & Pages** and tap the **`conge-rpc`** Worker.
3. Open **Settings** → **Variables and Secrets**.
4. Tap **Add**.
5. Set **Type** to **Secret** (not Text — a secret's value is hidden
   after saving).
6. **Variable name:** `UPSTREAM_RPC_URL`
7. **Value:** paste the full `https://…` URL from your node provider.
8. Tap **Deploy** (or **Save and deploy**).

To remove it, delete the secret the same way; the Worker goes back to the
public RPC alone. With Wrangler instead:
`cd worker && npx wrangler secret put UPSTREAM_RPC_URL`.

### Checking it's used

Send any request with an `Origin` header and look at the
`x-conge-upstream` response header (use a call that isn't cached yet, or
you'll see `none`):

```bash
curl -s -o /dev/null -D - -X POST https://rpc.conge.site/ \
  -H "Origin: https://conge.site" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | grep -i x-conge-upstream
```

`private` means the secret is in use. `public` means it isn't set (or
isn't a valid `https://` URL). `public-fallback` means it's set but the
private endpoint failed just now — check the key with your provider. On a
phone, opening `https://rpc.conge.site/health` shows the same as
`"source": "private"`.

## Deploying

The Worker is deployed **manually through the Cloudflare dashboard**. It
is not connected to this repository, so merging a PR does **not** update
the live Worker. After a change to [`index.js`](./index.js) is merged,
deploy it by hand:

1. In [dash.cloudflare.com](https://dash.cloudflare.com), open **Workers &
   Pages** and select the **`conge-rpc`** Worker.
2. Click **Edit code**.
3. Select everything in the editor and replace it with the full contents of
   [`index.js`](./index.js) from `main`.
4. Click **Deploy**.

There's no build step: what you paste is exactly what runs. Routes and the
custom domain (`rpc.conge.site`) are configured in the dashboard and aren't
affected by pasting new code.

To confirm the deploy, run the `curl` check under
[Testing it yourself](#testing-it-yourself) against `https://rpc.conge.site/`,
or open `https://rpc.conge.site/health`.

To set up a brand-new copy of this Worker from scratch, create a Worker
named `conge-rpc` in **Workers & Pages → Create → Create Worker**, then
paste `index.js` in the editor as above. It will be live at
`https://conge-rpc.<your-subdomain>.workers.dev`.

If you ever need to change the allowed origins (e.g. testing from
`localhost`) or the public upstream URL, edit the `ALLOWED_ORIGINS` and
`PUBLIC_UPSTREAM_RPC` constants near the top of `index.js`, then deploy as
above. A private upstream is set as a secret instead (see above), never in
the code.

### Optional: deploying with Wrangler from your own machine

[`wrangler.toml`](./wrangler.toml) and [`package.json`](./package.json)
let you deploy from a terminal instead of pasting:
`cd worker && npm install && npx wrangler login && npm run deploy`. That's
optional, and nothing runs it automatically. If you do use it:

- **The name must match.** `name = "conge-rpc"` in `wrangler.toml` must be
  the Worker's name.
- **`workers_dev` is applied.** It's set to `true` in `wrangler.toml`, so a
  Wrangler deploy turns the `conge-rpc.<subdomain>.workers.dev` address
  (back) on. If you've switched that address off in the dashboard, set
  `workers_dev = false` first.
- **Secrets are kept.** The optional `UPSTREAM_RPC_URL` secret isn't in
  `wrangler.toml` (it must never be in the repo) and a Wrangler deploy
  leaves it in place. Set it with `npx wrangler secret put
  UPSTREAM_RPC_URL`. Plain (non-secret) dashboard variables would be
  dropped by a Wrangler deploy; the Worker has none.

## Reading `/health`

Open `https://conge-rpc.<your-subdomain>.workers.dev/health` in any
browser — phone or desktop, no special headers needed. You'll get JSON
back that looks like one of:

```json
{ "ok": true, "upstream": { "reachable": true, "source": "public", "chainId": 4663, "blockNumber": 1234567 } }
```

```json
{ "ok": false, "upstream": { "reachable": false }, "error": "Upstream did not respond within 8s" }
```

`ok: true` means the upstream RPC answered both `eth_chainId` and
`eth_blockNumber` successfully just now. `source` says which upstream
answered — `private`, `public` or `public-fallback` (see
[Private upstream](#private-upstream-optional)); the URL itself is never
shown. Most phone browsers render JSON
readably by default; if yours doesn't, any "view source" / "raw" toggle
works too.

## Testing it yourself

The allowed origins are `https://conge.site` and `https://www.conge.site`,
so a plain `curl` without an `Origin` header
will get `403` — that's correct, not a bug. Pass the header explicitly to
test as the real site would (this project's Worker is at
`https://rpc.conge.site`; a fresh deploy of your own starts on
`conge-rpc.<your-subdomain>.workers.dev`):

```bash
curl -i -X POST https://rpc.conge.site/ \
  -H "Origin: https://conge.site" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

A batch works the same way, as a JSON array of up to 10 request objects.

To see the cache work, send the same `eth_call` twice within a minute and
look at the `x-conge-cache` response header: `miss` the first time, `hit`
the second.

```bash
curl -s -o /dev/null -D - -X POST https://rpc.conge.site/ \
  -H "Origin: https://conge.site" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168","data":"0x18160ddd"},"latest"]}' \
  | grep -i x-conge-cache
```

## Abuse protection and rate limiting

The upstream RPC is a shared, rate-limited resource, so the Worker and the
site protect it in layers:

- **Server-side origin check (in code).** Only the site's origins
  (`https://conge.site`, `https://www.conge.site`) are accepted. Any other `Origin`, or none, gets `403` before any upstream
  work. `worker/tests/worker.test.js` covers forged origins on the actual
  POST: no Origin, `null`, look-alike domains, the wrong scheme, a trailing
  slash or path, a port, different letter case, and browser-like headers
  around a foreign Origin.
- **What the origin check can't do.** A script can send the *exact*
  allowed header, e.g. `Origin: https://conge.site`. No origin check
  can tell that apart from the real site, so a per-IP rate limit (below)
  is the backstop for scripted abuse.
- **`/health` is shared (in code).** One upstream check serves every
  `/health` request for 15 seconds.
- **Client cooldown (in the site).** After each scan, the Scan and Rescan
  buttons stay disabled for 3 seconds with a visible countdown. This
  prevents accidental rapid re-scans.
- **Per-IP rate limiting (Cloudflare dashboard, manual).** This is described
  below. The Worker has no built-in limiter of its own: that would need
  state (KV or Durable Objects), which this thin proxy deliberately avoids.

### Adding a Cloudflare Rate Limiting Rule (manual dashboard step)

> **This is a manual step in the Cloudflare dashboard. It is not deployed
> from this repository's code**, and nothing in the repo can create or
> change it. Re-check it if the Worker's hostname ever changes.

**Prerequisite: the Worker must be on a hostname in a zone you own.**
WAF rules, including rate limiting rules, attach to a *zone* (your own
domain). They can't be added to a `*.workers.dev` URL, because Cloudflare
owns that zone.

> **Status for this project:** steps 1–3 are done. The Worker is on
> `https://rpc.conge.site`, and `WORKER_URL` in `app.js` points there. Step
> 4 is **still open**: the old `conge-rpc.agrarisai.workers.dev` address
> still works, so a rate limiting rule on `conge.site` can be bypassed
> through it until it's turned off.

1. Add your domain to Cloudflare, if it isn't already. The Free plan is
   enough.
2. Go to **Workers & Pages → `conge-rpc` → Settings → Domains & Routes →
   Add → Custom domain**, and enter a hostname such as
   `rpc.yourdomain.com`.
3. In the site's `app.js`, change `WORKER_URL` to that hostname. The
   Worker's `ALLOWED_ORIGINS` doesn't change: it lists the *site's* origin,
   not the Worker's.
4. **Turn off the `workers.dev` address**: back in **Domains & Routes**,
   disable the `workers.dev` route. Otherwise the old
   `conge-rpc.<subdomain>.workers.dev` URL keeps working and bypasses the
   rule. (If you ever deploy with Wrangler instead of the dashboard editor,
   also set `workers_dev = false` in [`wrangler.toml`](./wrangler.toml),
   or that deploy turns the address back on.)

**Create the rule:**

5. Select your domain (the zone) in the dashboard, then go to
   **Security → WAF → Rate limiting rules → Create rule**. In the newer
   dashboard this is **Security → Security rules → Create rule → Rate
   limiting rule**.
6. **Rule name:** `conge-rpc per-IP limit`.
7. **If incoming requests match:** Field `Hostname`, operator `equals`,
   value `rpc.yourdomain.com`. This covers both `POST /` and `GET /health`.
8. **With the same characteristics:** `IP`. On the Free plan, IP is the
   only option.
9. **When rate exceeds:**
   - **Pro plan and above:** `20` requests per `1 minute`. This is the
     recommended starting point.
   - **Free plan:** the period is fixed at `10 seconds`, so use `10`
     requests per `10 seconds`. That allows one full scan with retries, but
     stops a script within seconds.
10. **Then take action:** `Block`, with a short **duration**: `1 minute` on
    paid plans, or `10 seconds` on Free, where it's fixed.
11. **Deploy.**

Plan limits change over time. If a field above isn't editable, the
dashboard's rule editor shows what your plan allows.

**Why these numbers.**
- **Normal scan:** about 3–4 POSTs to the Worker: the owner check, one
  pool-detection batch, and one or two sell-simulation batches.
- **Page load:** one connection probe.
- **Worst case:** with every client-side retry firing, a scan peaks at
  about 10–12 POSTs.
- **The 3-second cooldown** spaces out repeated scans from one visitor.

A real visitor won't hit either limit; a script looping requests will.

**What a blocked visitor sees.** Cloudflare's block response (HTTP 429)
carries no CORS headers, so the browser reports it as a network error. In
the site, the owner and sell-simulation checks show their honest "Unknown"
state with Technical details. That's the same degraded state as when the
upstream RPC itself is rate-limiting. Blockscout-based checks are
unaffected, because they don't go through this Worker.

## Testing

Validation, CORS, retry/jitter and caching logic (no network, no Workers
runtime needed — the upstream and the Cache API are replaced by in-memory
stand-ins) are unit-tested with Node's built-in test runner:

```bash
node --test worker/tests/worker.test.js
# or, from inside worker/:
npm test
```
