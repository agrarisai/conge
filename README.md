# Conge

Conge is a read-only token risk scanner for EVM chains, built as a plain
static website. It never requests wallet access, signatures, or
transactions — it only reads public on-chain data.

The first supported chain is **Robinhood Chain mainnet**:

- Chain ID: `4663`
- Blockscout API (primary data source): `https://robinhoodchain.blockscout.com/api/v2`
- Explorer: `https://robinhoodchain.blockscout.com`
- RPC (optional secondary source): `https://rpc.mainnet.chain.robinhood.com`

**The Blockscout API v2 is the primary data source.** The RPC endpoint is
only an optional secondary source — the site works fully with it removed
or unreachable, and only uses it to add extra data (a token's `owner()`,
or a cross-check of the chain ID) when it happens to be reachable. This
split exists because `rpc.mainnet.chain.robinhood.com` has been reported
unreachable from some mobile devices (a TLS certificate error), while the
Blockscout API works fine from the same devices.

## Features

- **Network status** — fetches `GET /stats` from the Blockscout API and
  shows `total_blocks` as the latest block, alongside the chain ID and
  name from `CONFIG` (Blockscout's `/stats` doesn't return a chain ID, so
  that value is not independently verified unless the RPC secondary is
  also reachable). If the optional RPC is reachable too, its
  `eth_chainId` is cross-checked against `CONFIG.chainId` and flagged if
  it doesn't match. Every fetch (Blockscout and RPC) is a plain `fetch()`
  call with a 10s timeout — not viem's transport — so failures can be
  classified precisely: network/CORS/TLS failure vs. an HTTP error
  (403/429/5xx) vs. a JSON-RPC error vs. an unparseable body. The **Data
  source** row always says which source(s) the displayed values came
  from. If the primary source fails, a collapsible **Technical details**
  panel shows the raw error name/message, HTTP status (if any), the URL
  that was tried, and the page's origin for every source attempted — see
  [Troubleshooting network connectivity](#troubleshooting-network-connectivity)
  below. A **Retry connection** button re-runs the whole check.
- **Scan a token** — enter a contract address and Conge looks it up via
  Blockscout endpoints called in parallel: `GET /addresses/{address}` (is
  it a contract, is it verified), `GET /tokens/{address}` (name, symbol,
  decimals, total supply, holder count, market data — 404 here just means
  "not a recognized token", not an error), `GET /smart-contracts/{address}`
  (verification status and, when verified, the ABI), and
  `GET /tokens/{address}/holders` (top holder balances). A follow-up call
  to `GET /transactions/{creation_transaction_hash}` gets the contract's
  deployment timestamp. If the optional RPC secondary is reachable, it's
  additionally used for one thing Blockscout has no generic field for:
  reading the contract's `owner()`. Every field that couldn't be
  determined shows **"Unavailable"** rather than a guess, and the result
  card's **Data source** row says exactly which source(s) contributed.
  If any Blockscout request fails outright (not a "not found"), a
  collapsible **Technical details** panel shows the real error for each
  request that was made.
- **Risk Score v1** — every scan of a contract also runs a transparent,
  rule-based risk check (see below) and shows a summary card — overall
  level, then findings grouped by severity — above the token details.
  The result card's title shows the token's `Name (SYMBOL)` when both are
  known, falling back to whichever one is available, or "Token" if
  neither is.

## Risk Score v1

Every scan of an address that turns out to be a contract runs seven
checks, each producing one or more **findings** — a severity
(`info` / `low` / `medium` / `high`), a one-line title, and a short
"why it matters" explanation. Findings are transparent and rule-based:
no model, no hidden scoring, no weighting you can't read in
[`scoring.js`](./scoring.js). If a check's data isn't available, its
finding is marked **Unknown** (shown with a distinct dashed/gray style)
— Unknown is never counted as a pass, and never contributes evidence
toward a "Low" verdict.

The **overall level** — `Low` / `Medium` / `High` / `Insufficient data`
— is the worst known severity among the level-relevant findings (market
data is informational only and never affects it); if too few checks
produced any data at all, the verdict is `Insufficient data` rather than
a guess. Conge never uses the words "safe" or "secure", and always shows:
*"Automated checks can miss scams. Not financial advice. Verify
independently."*

| # | Check | Data source | Thresholds |
|---|-------|--------------|------------|
| 1 | Source code verified | Blockscout `is_verified` | Unverified → **High**; also blocks checks 5 (owner privileges) |
| 2 | Holder concentration (top 1 / top 10) | Blockscout `GET /tokens/{address}/holders`, zero/burn addresses excluded | Top 1 **>50% High**, **>20% Medium**; Top 10 **>80% Medium**. Shown as one finding with both percentages when top 1 and top 10 land on the same (Medium) severity — otherwise as two |
| 3 | Holder count | Blockscout `holders_count` | **<10 High**, **<100 Medium** |
| 4 | Token age | Creation tx timestamp (`GET /transactions/{hash}`) | **<24h High**, **<7 days Medium** |
| 5 | Owner privileges (verified contracts only) | ABI from `GET /smart-contracts/{address}` — name-matched for mint / pause / blacklist·blocklist / setFee·setTax / setMaxTx·setMaxWallet / upgradeTo, plus `proxy_type` | Each detected privilege listed as its own finding (severities in `THRESHOLDS.ownerPrivilegeSeverity`, tune freely — proxy upgrade defaults to High, most others Medium) |
| 6 | Owner status | RPC secondary `owner()` read | Informational: shows the owner, or "Ownership renounced" if it's the zero address |
| 7 | Market data | Blockscout `exchange_rate` / `volume_24h` / `circulating_market_cap` | Informational only — shown but never affects the overall level |

**Limits, by design:**
- Check 5 is a **name-based ABI scan, not a bytecode or semantics audit**
  — a differently-named function with the same effect won't be caught,
  and a function with an alarming name doesn't prove it's actually
  dangerous. It only runs at all when the contract is verified.
- Check 2 only looks at the first page of `/tokens/{address}/holders`
  (Blockscout's default page size), which comfortably covers "top 10"
  but isn't a full holder census.
- Check 6 depends entirely on the *optional* RPC secondary and on the
  contract exposing a standard `owner()` view function — very often
  "Unknown", which is expected and shown honestly rather than guessed.
- None of this is an audit or a guarantee. It's a fast, transparent
  read of public on-chain and block-explorer data — always verify
  independently before acting on it.

`scoring.js` is a standalone module of pure functions (no network calls,
no DOM) with a `THRESHOLDS` table at the top — edit the numbers there to
retune any check without touching `app.js`. See
[`tests/scoring.test.js`](./tests/scoring.test.js) for the full set of
sample inputs/outputs, runnable with:

```bash
node --test tests/scoring.test.js
```

(uses Node's built-in test runner — no npm install needed, consistent
with the rest of this project.)

## Tech

- Plain HTML, CSS, and JavaScript (ES modules) — no build step, no npm.
- [viem](https://viem.sh) is loaded from a version-pinned ES module CDN
  (`https://esm.sh/viem@2.21.19`), used only for its `isAddress` /
  `getAddress` / `formatUnits` utilities (pure functions, no network) and
  for the optional RPC secondary's `owner()` read.
- All chain/Blockscout/RPC configuration lives in a single `CONFIG`
  constant at the top of `app.js`: `explorerApiUrl` (the Blockscout API
  v2 base URL — the primary source) and `rpcUrls` (an optional secondary
  RPC endpoint list, tried in order, none of them required). Only add an
  RPC endpoint here once you've verified it exists and actually allows
  browser requests from this site's origin (see below) — don't add
  unverified URLs.
- Risk scoring logic lives in `scoring.js`, a separate module of pure
  functions imported by `app.js` — `app.js` gathers "facts" from
  Blockscout/RPC and hands them to `scoreToken()`, which does no I/O of
  its own (that's what makes it unit-testable without mocking a network).

## Project structure

```
index.html          # page structure
style.css            # styling (mobile-first, light theme)
app.js               # app logic (ES module, imports viem + scoring.js)
scoring.js           # Risk Score v1 — pure, rule-based scoring functions
tests/scoring.test.js  # unit tests for scoring.js (node --test)
assets/              # brand imagery — see "Branding assets" below
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

To run the risk-scoring unit tests: `node --test tests/scoring.test.js`
(see [Risk Score v1](#risk-score-v1) above).

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

This repo is currently deployed at `https://agrarisai.github.io/conge/`,
which is hardcoded into the absolute URLs in `index.html`'s Open Graph /
Twitter card tags (see [Branding assets](#branding-assets)). If you fork
or rename this repo, update those URLs to match the new address.

## Branding assets

All brand imagery lives in `assets/` and is used as-is (never modified by
this codebase):

- `assets/conge-mark.png` — the bird mark, shown in the header next to
  the "Conge" wordmark (`index.html`'s `.logo` image). It's non-square
  (858×494); the CSS only constrains height, so it keeps its aspect ratio
  rather than being stretched into a box.
- `assets/favicon-512.png` — the site favicon (`<link rel="icon">`).
- `assets/apple-touch-icon.png` — the icon iOS uses when the site is
  added to a home screen (`<link rel="apple-touch-icon">`).
- `assets/social-preview-1200x630.png` — the Open Graph / Twitter card
  image shown when a link to the site is shared. Referenced with an
  **absolute** URL (`https://agrarisai.github.io/conge/assets/...`), since
  the crawlers that read these tags don't resolve relative URLs against
  the page the way a browser does. If this site is ever moved to a
  different URL, update `og:url`/`og:image`/`twitter:image` in
  `index.html` to match.

To replace any of these, just overwrite the file in `assets/` — no code
changes needed as long as the filename stays the same.

## Troubleshooting network connectivity

If **Network status** shows "Connection failed" (both the Blockscout
primary and the RPC secondary failed), or a scan shows a Blockscout error,
open **Technical details** on the page — it shows, for every source that
was tried: the exact browser error name/message, the HTTP status (if a
response came back at all), the URL, and the page's origin. That's
usually enough to tell what's wrong:

- **Error name `TypeError`, message `Failed to fetch` (or similar)** — the
  browser couldn't complete the request at all. The Fetch API doesn't
  expose *why* for security reasons, but it's one of: a CORS restriction
  (the endpoint didn't return `Access-Control-Allow-Origin` for this
  page's origin), an invalid/expired TLS certificate, no network
  connectivity, a DNS failure, or the endpoint being down. **This is
  exactly the error a TLS certificate problem produces** — it's why
  `rpc.mainnet.chain.robinhood.com`'s reported TLS issue and a CORS
  problem look identical from inside the browser, and why the RPC is only
  ever an optional secondary here now. To narrow it down, open the URL
  directly in a new browser tab (or `curl` it, see below) — if that also
  fails, it's not CORS specifically (though a TLS cert error will fail
  both ways).
- **An HTTP status (403, 429, 5xx, …)** — the request reached the server,
  which rejected or failed it. 403 often means the endpoint blocks
  non-whitelisted origins/user agents; 429 means it's rate-limiting; 5xx
  means it's having problems server-side.
- **A JSON-RPC error** (RPC secondary only) — the request and response
  both worked at the HTTP level, but the node returned a JSON-RPC `error`
  object (e.g. an unsupported method).

### Checking CORS from the command line

You can check whether an endpoint sends CORS headers for this site's
origin with `curl`. For the Blockscout API (primary):

```bash
curl -i "https://robinhoodchain.blockscout.com/api/v2/stats" \
  -H "Origin: https://agrarisai.github.io"
```

For the RPC (optional secondary):

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

> **Important:** typing a URL into a browser's address bar (a direct
> navigation) is **not** subject to CORS — only a cross-origin `fetch()`
> initiated by a page's own JavaScript is. So confirming
> `https://robinhoodchain.blockscout.com/api/v2/stats` loads and shows
> JSON when opened directly in a mobile browser (as was done for this PR)
> does **not** by itself prove `fetch()` calls from `agrarisai.github.io`
> will succeed — only the `curl -H "Origin: ..."` check above (or the
> live site's own **Technical details** panel, if it still fails) proves
> that.

> **Note on this repo's own testing:** the sandboxed environment this PR
> was prepared in has an egress allowlist that blocks direct connections
> to `robinhoodchain.blockscout.com`, `rpc.mainnet.chain.robinhood.com`,
> `esm.sh`, and `docs.blockscout.com` entirely — every attempt (via `curl`
> and via a web-fetch tool) failed at the proxy/CONNECT level before a
> request ever reached those hosts. So neither the Blockscout CORS check
> above nor the exact Blockscout API v2 response field names could be
> verified from this environment. The field names used in `app.js`
> (`total_blocks`, `is_contract`, `is_verified`, `name`, `symbol`,
> `decimals`, `total_supply`, `holders_count`/`holders`, `exchange_rate`,
> `volume_24h`, `circulating_market_cap`, `creation_transaction_hash`/
> `creation_tx_hash`, `timestamp`, `abi`, `proxy_type`, and the
> `/tokens/{address}/holders` items' `address.hash`/`value`) are based on
> the documented/standard Blockscout API v2 schema, with defensive
> fallbacks where I was least confident. Every field that isn't present
> in the response is shown as "Unavailable" (or, for Risk Score v1,
> "Unknown" — see below) rather than guessed — please verify against the
> live API (`curl https://robinhoodchain.blockscout.com/api/v2/tokens/<address>`,
> `.../addresses/<address>`, `.../smart-contracts/<address>`,
> `.../tokens/<address>/holders`, and `.../transactions/<hash>` for a
> known creation tx) and adjust the field names in `app.js`'s
> `scanToken()` if any of them turn out to be wrong for this instance —
> `scoring.js` itself takes plain facts and doesn't need to change.

### If the Blockscout API also blocks browser requests

Both the Blockscout API and the RPC are official, first-party endpoints
for this chain, so if it turns out neither sends CORS headers for this
origin, here are the options, in rough order of effort — **do not** route
around this with an unofficial third-party CORS proxy (e.g.
`corsproxy.io`), since that would send every visitor's requests through an
unaccountable third party:

1. **A provider with a free-tier API key, restricted to this domain**
   (e.g. Alchemy, Infura, or another RPC-as-a-service provider that
   supports Robinhood Chain and lets you restrict a key to an HTTP
   referrer/origin allowlist). Pros: reliable, provider-grade uptime, no
   infra to maintain. Cons: depends on a third party supporting this
   chain at all today; a leaked/unrestricted key could be abused (mitigate
   by restricting it to this domain, which most providers support for
   free-tier keys). Would only restore RPC-level data (block number,
   chain ID, `owner()`), not Blockscout's indexed data (holders, verified
   source, etc.) — a Blockscout-blocking-CORS scenario would need its own
   proxy (option 2) to recover those.
2. **A small Cloudflare Worker (or similar edge function) proxy** in front
   of whichever endpoint(s) are blocking CORS, forwarding requests and
   adding `Access-Control-Allow-Origin` for this site's origin. Pros: full
   control, no dependency on a third-party provider, can add basic rate
   limiting. Cons: it's infrastructure this project now owns and must
   keep running/secure; it should only ever proxy read calls and never
   accept or forward private keys/signatures (this site doesn't use them,
   and the proxy shouldn't either).

This PR does not implement either option, since Blockscout CORS support
couldn't be verified from this environment (see the note above) — if the
`curl` check confirms Blockscout also blocks browser origins, come back to
this list.

## Security notes

- This is a **read-only** tool: it does not connect wallets, request
  signatures, or send transactions.
- No secrets or API keys are required or stored; both the Blockscout API
  and the RPC endpoint are public.
- Always verify token information independently (e.g. via the block
  explorer) before making any decisions — Conge does not provide
  financial advice.
