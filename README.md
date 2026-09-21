# Conge

Conge is a read-only token risk scanner for EVM chains, built as a plain
static website. It never requests wallet access, signatures, or
transactions — it only reads public on-chain data over RPC.

The first supported chain is **Robinhood Chain mainnet**:

- Chain ID: `4663`
- RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`

## Features

- **Network status** — connects to the configured RPC, verifies the chain
  ID matches the expected value, and shows the latest block number. The
  connectivity check is a plain `fetch()` JSON-RPC POST (not viem's
  transport), with a 10s timeout, so failures can be classified precisely:
  network/CORS failure vs. an HTTP error (403/429/5xx) vs. a JSON-RPC
  error. If it fails, a collapsible **Technical details** section shows
  the raw error name/message, HTTP status (if any), the RPC URL that was
  tried, and the page's origin — see
  [Troubleshooting network connectivity](#troubleshooting-network-connectivity)
  below. A **Retry connection** button re-runs the check.
- **Scan a token** — enter a contract address to check it has contract
  code, then read `name`, `symbol`, `decimals`, `totalSupply`, and
  `owner()` (when present) and display them in a result card. No risk
  scoring yet — this is planned for a future version.

## Tech

- Plain HTML, CSS, and JavaScript (ES modules) — no build step, no npm.
- [viem](https://viem.sh) is loaded from a version-pinned ES module CDN
  (`https://esm.sh/viem@2.21.19`) for RPC/contract calls.
- All chain/RPC configuration lives in a single `CONFIG` constant at the
  top of `app.js`, including `rpcUrls` — a list of RPC endpoints tried in
  order (first reachable one wins, and is what viem uses afterwards). Only
  add an endpoint to this list once you've verified it exists and actually
  allows browser requests from this site's origin (see below) — don't add
  unverified URLs.

## Project structure

```
index.html   # page structure
style.css    # styling (mobile-first, light theme)
app.js       # app logic (ES module, imports viem from a CDN)
assets/      # place a logo here (e.g. assets/logo.svg)
```

## Local setup

No build step or dependencies are required. Because the page uses ES
modules, open it via a local HTTP server rather than the `file://`
protocol (browsers block module imports over `file://`).

Using Python:

```bash
python3 -m http.server 8000
```

Or using Node (no install needed):

```bash
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Deploying to GitHub Pages

1. Push this repository to GitHub (already done if you're reading this
   from the repo).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a
   branch**.
4. Select the branch to publish (e.g. `main`) and the root folder (`/`),
   then save.
5. GitHub Pages will publish the site at
   `https://<your-org-or-user>.github.io/<repo-name>/`.

No build step is needed since this is a static site — GitHub Pages serves
the files as-is.

## Adding a logo

Drop a logo file into `assets/` (e.g. `assets/logo.svg`) and it will
appear in the header automatically. If no logo is present, the header
simply omits the image.

## Troubleshooting network connectivity

If **Network status** shows "Connection failed", open **Technical details**
on the page — it shows the exact browser error name/message, the HTTP
status (if a response came back at all), the RPC URL that was tried, and
the page's origin. That's usually enough to tell what's wrong:

- **Error name `TypeError`, message `Failed to fetch` (or similar)** — the
  browser couldn't complete the request at all. The Fetch API doesn't
  expose *why* for security reasons, but it's one of: a CORS restriction
  (the RPC endpoint didn't return `Access-Control-Allow-Origin` for this
  page's origin), no network connectivity, a DNS failure, or the endpoint
  being down. To narrow it down, open the RPC URL directly in a new
  browser tab (or `curl` it, see below) — if that also fails, it's not
  CORS.
- **An HTTP status (403, 429, 5xx, …)** — the request reached the server,
  which rejected or failed it. 403 often means the endpoint blocks
  non-whitelisted origins/user agents; 429 means it's rate-limiting; 5xx
  means it's having problems server-side.
- **A JSON-RPC error** — the request and response both worked at the HTTP
  level, but the node itself returned a JSON-RPC `error` object (e.g. an
  unsupported method).

### Checking CORS from the command line

You can check whether an RPC endpoint sends CORS headers for this site's
origin with `curl`:

```bash
curl -i -X POST https://rpc.mainnet.chain.robinhood.com \
  -H "Content-Type: application/json" \
  -H "Origin: https://agrarisai.github.io" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Look for `Access-Control-Allow-Origin` in the response headers — if it's
missing (or doesn't include this site's origin / `*`), browsers will block
the response even though `curl` gets one fine, which is exactly why the
Fetch API only ever reports a generic `Failed to fetch` for this case.

> **Note on this repo's own testing:** the sandboxed environment this PR
> was prepared in has an egress allowlist that blocks direct connections
> to `rpc.mainnet.chain.robinhood.com` (and to `esm.sh`, `blockscout.com`,
> etc.) entirely — every attempt failed at the proxy/CONNECT level before
> a request ever reached those hosts. So the CORS check above could not be
> run from this environment, and no claim is made here about whether that
> endpoint actually sends CORS headers. Please run the `curl` command
> above (or open the site on a phone with a browser's remote devtools
> attached) to get the real answer — the new Technical details panel is
> designed to make that easy to read off directly from the failing
> device.

### If the public RPC blocks browser requests

If it turns out `rpc.mainnet.chain.robinhood.com` doesn't send CORS
headers (or otherwise blocks browser-originated requests), here are the
options, in rough order of effort — **do not** route around this with an
unofficial third-party CORS proxy (e.g. `corsproxy.io`), since that would
send every visitor's requests through an unaccountable third party:

1. **A provider with a free-tier API key, restricted to this domain**
   (e.g. Alchemy, Infura, or another RPC-as-a-service provider that
   supports Robinhood Chain and lets you restrict a key to an HTTP
   referrer/origin allowlist). Pros: reliable, provider-grade uptime, no
   infra to maintain. Cons: depends on a third party supporting this
   chain at all today; a leaked/unrestricted key could be abused (mitigate
   by restricting it to this domain, which most providers support for
   free-tier keys).
2. **A small Cloudflare Worker (or similar edge function) proxy** that
   forwards JSON-RPC POSTs to the official RPC and adds
   `Access-Control-Allow-Origin` for this site's origin. Pros: full
   control, no dependency on a third-party RPC provider, can add basic
   rate limiting. Cons: it's infrastructure this project now owns and
   must keep running/secure; it should only ever proxy read RPC calls and
   never accept or forward private keys/signatures (this site doesn't use
   them, and the proxy shouldn't either).
3. **The Blockscout API v2** (`https://robinhoodchain.blockscout.com/api/v2/...`)
   directly from the browser, as a fallback data source for things like
   latest block number, in place of (not instead of diagnosing) the RPC.
   Pros: no infra to run, official block explorer for this chain. Cons:
   unverified whether it sends CORS headers for browser origins (same
   caveat as above — this environment couldn't check), and it doesn't
   cover arbitrary `eth_call`s (so it can't replace the RPC for the token
   scanner in Section 2, only for basic chain-status display).

This PR implements diagnostics and the ordered-`rpcUrls` retry list, but
does **not** implement a Blockscout (or any other) fallback endpoint,
since its CORS behavior from a real browser origin couldn't be verified
from this environment. Verify option 3 with the `curl` check above (or
directly in a browser) before wiring it in.

## Security notes

- This is a **read-only** tool: it does not connect wallets, request
  signatures, or send transactions.
- No secrets or API keys are required or stored; the RPC endpoint is
  public.
- Always verify token information independently (e.g. via the block
  explorer) before making any decisions — Conge does not provide
  financial advice.
