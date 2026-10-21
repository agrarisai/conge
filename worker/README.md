# Conge RPC proxy (Cloudflare Worker)

A thin, read-only JSON-RPC proxy for `https://rpc.mainnet.chain.robinhood.com`,
so Conge's browser code never has to call that RPC directly. It exists
because the RPC has been reported unreachable from some networks (a TLS
certificate problem that a browser reports identically to a CORS
failure — see the main [README](../README.md#troubleshooting-network-connectivity)).
This Worker sits in front of it on Cloudflare's edge instead.

It is a single file (`index.js`), no dependencies, no build step, no
secrets, no KV/D1, and it never logs request bodies.

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
    `https://agrarisai.github.io`, `https://conge.site` and
    `https://www.conge.site` — with no wildcard. This is enforced **server-side**, not just through CORS
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

## Deploying (Cloudflare dashboard, no CLI needed)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign in
   (or create a free account).
2. In the sidebar, open **Workers & Pages**.
3. Click **Create**, then choose **Create Worker**.
4. Give it the name **`conge-rpc`** (this determines the URL:
   `https://conge-rpc.<your-subdomain>.workers.dev`) and start from the
   **Hello World** template.
5. Click **Deploy** to create the placeholder Worker.
6. Click **Edit code** to open the online editor.
7. Select all the placeholder code and delete it, then paste in the
   entire contents of [`index.js`](./index.js) from this folder.
8. Click **Deploy** (or **Save and deploy**) in the editor.
9. Your proxy is now live at `https://conge-rpc.<your-subdomain>.workers.dev`.

To update it later: repeat steps 6–8 with the new file contents — there's
no build step, so what you paste is exactly what runs.

If you ever need to change the allowed origin (e.g. testing from
`localhost`) or the upstream URL, edit the `ALLOWED_ORIGINS` and
`UPSTREAM_RPC` constants near the top of `index.js` before pasting.

## Reading `/health`

Open `https://conge-rpc.<your-subdomain>.workers.dev/health` in any
browser — phone or desktop, no special headers needed. You'll get JSON
back that looks like one of:

```json
{ "ok": true, "upstream": { "reachable": true, "chainId": 4663, "blockNumber": 1234567 } }
```

```json
{ "ok": false, "upstream": { "reachable": false }, "error": "Upstream did not respond within 8s" }
```

`ok: true` means the upstream RPC answered both `eth_chainId` and
`eth_blockNumber` successfully just now. Most phone browsers render JSON
readably by default; if yours doesn't, any "view source" / "raw" toggle
works too.

## Testing it yourself

The allowed origins are `https://agrarisai.github.io`, `https://conge.site`
and `https://www.conge.site`, so a plain `curl` without an `Origin` header
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

## Abuse protection and rate limiting

The upstream RPC is a shared, rate-limited resource, so the Worker and the
site protect it in layers:

- **Server-side origin check (in code).** Only the site's origins
  (`https://agrarisai.github.io`, `https://conge.site`,
  `https://www.conge.site`) are accepted. Any other `Origin`, or none, gets `403` before any upstream
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
> through it until that route is disabled.

1. Add your domain to Cloudflare, if it isn't already. The Free plan is
   enough.
2. Go to **Workers & Pages → `conge-rpc` → Settings → Domains & Routes →
   Add → Custom domain**, and enter a hostname such as
   `rpc.yourdomain.com`.
3. In the site's `app.js`, change `WORKER_URL` to that hostname. The
   Worker's `ALLOWED_ORIGINS` doesn't change: it lists the *site's* origin,
   not the Worker's.
4. Back in **Domains & Routes**, **disable the `workers.dev` route**.
   Otherwise the old `conge-rpc.<subdomain>.workers.dev` URL keeps working
   and bypasses the rule.

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

Pure validation and CORS logic (no network, no Workers runtime needed) is
unit-tested with Node's built-in test runner:

```bash
node --test worker/tests/worker.test.js
```
