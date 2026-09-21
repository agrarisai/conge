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
  - CORS is restricted to `https://agrarisai.github.io` — no wildcard.
    Any other origin gets `403`, including the `OPTIONS` preflight.
  - The Worker enforces an 8 second timeout on the upstream call. If the
    upstream fails, times out, or returns something that isn't valid
    JSON, the Worker responds `502` with `{"error": "...", "detail":
    "..."}` describing what went wrong.
- **`GET /health`** — calls `eth_chainId` and `eth_blockNumber` upstream
  and reports whether the RPC is reachable right now. Unlike `POST /`,
  this endpoint is **not** origin-restricted — it's meant to be opened
  directly in a phone browser as a one-tap diagnostic (a plain top-level
  navigation isn't subject to CORS in the first place), and it returns no
  secrets, just status.
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

The allowed origin is `https://agrarisai.github.io`, so a plain `curl`
without an `Origin` header will get `403` — that's correct, not a bug.
Pass the header explicitly to test as the real site would:

```bash
curl -i -X POST https://conge-rpc.<your-subdomain>.workers.dev/ \
  -H "Origin: https://agrarisai.github.io" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

A batch works the same way, as a JSON array of up to 10 request objects.

## Rate limiting

This Worker has no built-in rate limiting of its own (Cloudflare's free
Workers plan doesn't include one out of the box, and adding home-grown
limiting would mean state — KV or Durable Objects — which this project
deliberately avoids for a thin proxy). If it ever needs one, add a
**Cloudflare WAF rate limiting rule** in front of it instead of changing
the code:

1. In the dashboard, open the zone/domain this Worker is routed on (or,
   for a plain `*.workers.dev` URL, Cloudflare rate limiting rules apply
   at the account/zone level — check what's available on your plan).
2. Go to **Security → WAF → Rate limiting rules** and create a rule
   matching this Worker's path, e.g. requests per IP per minute to
   `conge-rpc.<your-subdomain>.workers.dev/*`.
3. Set an action (block, or a challenge) once the threshold is exceeded.

This keeps rate limiting as infrastructure configuration, not application
code — the Worker itself stays a stateless, dependency-free proxy.

## Testing

Pure validation and CORS logic (no network, no Workers runtime needed) is
unit-tested with Node's built-in test runner:

```bash
node --test worker/tests/worker.test.js
```
