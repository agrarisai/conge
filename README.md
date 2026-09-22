# Conge

Conge is a read-only token risk scanner for EVM chains, built as a plain
static website. It never requests wallet access, signatures, or
transactions — it only reads public on-chain data.

The first supported chain is **Robinhood Chain mainnet**:

- Chain ID: `4663`
- Blockscout API (primary data source): `https://robinhoodchain.blockscout.com/api/v2`
- Explorer: `https://robinhoodchain.blockscout.com`
- RPC (optional secondary source, via the Worker proxy): `https://conge-rpc.agrarisai.workers.dev`

**The Blockscout API v2 is the primary data source.** RPC reads are only
an optional secondary source — the site works fully with them removed or
unreachable, and only uses them to add extra data (a token's `owner()`,
the sell-simulation honeypot check, or a cross-check of the chain ID)
when reachable. **The site never calls `rpc.mainnet.chain.robinhood.com`
directly** — that endpoint has been reported unreachable from some mobile
devices (a TLS certificate error). Instead, every RPC call from the
browser goes through the [Worker](#worker) proxy at
`WORKER_URL` (`https://conge-rpc.agrarisai.workers.dev`), which forwards
read-only calls to the upstream RPC from Cloudflare's edge and adds CORS
headers for this site's origin.

## Features

- **Network status** — fetches `GET /stats` from the Blockscout API and
  shows `total_blocks` as the latest block, alongside the chain ID and
  name from `CONFIG` (Blockscout's `/stats` doesn't return a chain ID, so
  that value is not independently verified unless the Worker secondary is
  also reachable). If the Worker is reachable too, its `eth_chainId` is
  cross-checked against `CONFIG.chainId` and flagged if it doesn't match.
  Every fetch (Blockscout and the Worker) is a plain `fetch()` call with a
  timeout — not viem's transport — so failures can be classified
  precisely: network/CORS/TLS failure vs. a Worker-side rejection (origin
  not allowed, malformed/oversized request, or its own upstream RPC
  failing — each shown as its own distinct kind, not a generic "HTTP
  error") vs. a JSON-RPC error vs. an unparseable body. The **Data
  source** row always says which source(s) the displayed values came
  from. If the primary source fails, a collapsible **Technical details**
  panel shows the raw error name/message, HTTP status (if any), the first
  300 characters of the response body, the URL that was tried, and the
  page's origin for every source attempted — see
  [Troubleshooting network connectivity](#troubleshooting-network-connectivity)
  below. A **Retry connection** button re-runs the whole check, and a
  **Test Worker connection** button runs an independent, on-demand
  self-test of the Worker specifically (see
  [Worker](#worker) below).
- **Scan a token** — enter a contract address and Conge looks it up via
  Blockscout endpoints called in parallel: `GET /addresses/{address}` (is
  it a contract, is it verified), `GET /tokens/{address}` (name, symbol,
  decimals, total supply, holder count, market data — 404 here just means
  "not a recognized token", not an error), `GET /smart-contracts/{address}`
  (verification status and, when verified, the ABI), and
  `GET /tokens/{address}/holders` (top holder balances). A follow-up call
  to `GET /transactions/{creation_transaction_hash}` gets the contract's
  deployment timestamp. If the Worker RPC secondary is reachable, it's
  additionally used for things Blockscout has no generic field for:
  reading the contract's `owner()`, and the
  [sell-simulation honeypot check](#sell-simulation-honeypot-check).
  Every field that couldn't be determined shows **"Unavailable"** rather
  than a guess, and the result card's **Data source** row says exactly
  which source(s) contributed. If any Blockscout request fails outright
  (not a "not found"), a collapsible **Technical details** panel shows the
  real error for each request that was made. The **Owner status** and
  **Sell-simulation honeypot check** findings each get their own
  collapsible **Technical details** too, specifically when their own
  Worker call failed — see [below](#sell-simulation-honeypot-check).
- **Risk Score v1** — every scan of a contract also runs a transparent,
  rule-based risk check (see below) and shows a summary card — overall
  level, then findings grouped by severity — above the token details.
  The result card's title shows the token's `Name (SYMBOL)` when both are
  known, falling back to whichever one is available, or "Token" if
  neither is.

## Risk Score v1

Every scan of an address that turns out to be a contract runs eight
checks, each producing one or more **findings** — a severity
(`info` / `low` / `medium` / `high`), a one-line title, and a short
"why it matters" explanation. Findings are transparent and rule-based:
no model, no hidden scoring, no weighting you can't read in
[`scoring.js`](./scoring.js). **Each finding's text is specific to its
outcome** — a check that passed never shows a warning explanation, and
vice versa (e.g. `"365,893 holders: wide distribution"` vs. `"2 holders:
very few holders"`, with entirely different "why it matters" text, not
just a different color on the same sentence).

Findings are grouped in the UI by outcome, in this order: **High risk**,
**Medium risk**, **Low risk**, **Passed** (a check ran and came back
clean — calm, neutral styling, not the brand green), then **Info /
unknown** (the check's data simply wasn't available). Unknown is never
grouped with Passed and never counted as a pass — it's excluded from the
overall-level math entirely.

The **overall level** — `Low` / `Medium` / `High` / `Insufficient data`
— is the worst known severity among the level-relevant findings (market
data is informational only and never affects it); if too few checks
produced any data at all, the verdict is `Insufficient data` rather than
a guess. Conge never uses the words "safe" or "secure", and always shows:
*"Automated checks can miss scams. Not financial advice. Verify
independently."*

| # | Check | Data source | Thresholds |
|---|-------|--------------|------------|
| 1 | Source code verified | Blockscout `is_verified` | Unverified → **High**; also blocks check 5b (ABI-detected privileges) |
| 2 | Holder concentration (top 1 / top 10) | Blockscout `GET /tokens/{address}/holders`, zero/burn addresses excluded | Top 1 **>50% High**, **>20% Medium**; Top 10 **>80% Medium**. Shown as one finding with both percentages when top 1 and top 10 land on the same (Medium) severity — otherwise as two. If Blockscout tags a top holder's address as a contract (`address.is_contract`), the finding says so — a pool/bridge/vault holding a large share reads differently than a single wallet doing the same |
| 3 | Holder count | Blockscout `holders_count` | **<10 High**, **<100 Medium** |
| 4 | Token age | Creation tx timestamp (`GET /transactions/{hash}`) | **<24h High**, **<7 days Medium** |
| 5a | Proxy upgrade (independent of verification — see below) | `proxy_type` (or an `upgradeTo`-style function in a verified ABI) | **Unverified source: High.** Verified source: **Medium** by default (common for regulated/compliant tokens), raised to **High** only if the upgrade admin is *confirmed* to be a plain wallet rather than a contract |
| 5b | Other owner privileges (verified contracts only) | ABI from `GET /smart-contracts/{address}` — name-matched for mint / pause / blacklist·blocklist / setFee·setTax / setMaxTx·setMaxWallet | Each detected privilege is its own finding (severities in `THRESHOLDS.ownerPrivilegeSeverity`, tune freely — mostly Medium, max-tx/wallet is Low) |
| 6 | Owner status | Worker RPC secondary, `owner()` read (selector `0x8da5cb5b`) | Informational: shows the owner, or "Ownership renounced" if it's the zero address; stays "Unknown" if the call fails or the Worker is unreachable |
| 7 | Sell-simulation honeypot check | Worker RPC secondary, `eth_call` simulation — see [below](#sell-simulation-honeypot-check) | **High** if selling appears blocked or transfers are restricted; **Passed** if both a baseline and a pool-directed transfer simulate successfully; **Info/Unknown** if no pool could be found among the top holders or the Worker is unreachable (never counted as a pass) |
| 8 | Market data | Blockscout `exchange_rate` / `volume_24h` / `circulating_market_cap` | Informational only — shown but never affects the overall level |

**Check 5a (proxy upgrade) in detail**, since it's the one check with a
conditional severity rule rather than a fixed threshold: being an
upgradeable proxy is detectable whether or not the source is verified
(via `proxy_type`, or an ABI `upgradeTo`-style function once verified),
so it runs independently of check 5b rather than being gated behind
verification like the rest of check 5. An unverified proxy is always
**High** — there's no way to independently confirm what upgraded logic
would do. A verified proxy is **Medium** by default: the owner/admin can
still change the logic, but at least the *current* logic is readable,
and this pattern is common for regulated/compliance-driven tokens (which
often need an upgrade path for legal reasons). It's only raised to
**High** when Blockscout exposes the proxy's upgrade-admin address *and*
that address is confirmed to be a plain wallet rather than a contract
(e.g. a multisig or timelock) — a single point of control with no
on-chain checks. **This admin-address lookup is opportunistic and
unverified**: `app.js` checks for a `proxy_admin`/`admin` field on the
`/smart-contracts/{address}` response as a best-effort guess (its exact
field name — if Blockscout exposes it at all — could not be confirmed
from this environment; see the field-names note below), and if it's not
there, the check simply falls back to the verified/unverified rule above
without ever fabricating an escalation.

**Limits, by design:**
- Check 5b is a **name-based ABI scan, not a bytecode or semantics
  audit** — a differently-named function with the same effect won't be
  caught, and a function with an alarming name doesn't prove it's
  actually dangerous. It only runs at all when the contract is verified.
- Check 2 only looks at the first page of `/tokens/{address}/holders`
  (Blockscout's default page size), which comfortably covers "top 10"
  but isn't a full holder census. The contract-vs-wallet note on a top
  holder is also opportunistic — only shown when Blockscout's response
  actually includes `is_contract` for that address.
- Check 6 depends entirely on the *optional* Worker RPC secondary and on
  the contract exposing a standard `owner()` view function — very often
  "Unknown", which is expected and shown honestly rather than guessed.
- Check 7 (the sell-simulation honeypot check) is an **indicator, not a
  guarantee** — see its own [Limits](#sell-simulation-honeypot-check)
  below for what it can and cannot detect.
- None of this is an audit or a guarantee. It's a fast, transparent
  read of public on-chain and block-explorer data — always verify
  independently before acting on it.

### Sell-simulation honeypot check

Check 7 tries to answer a narrower, harder question than the others:
*can a normal holder actually sell this token?* Some tokens look fine on
paper (verified, well distributed, no obvious privileged function) but
silently block transfers to a liquidity pool — a classic "honeypot". This
check is read-only and DEX-agnostic: it never assumes a specific router
or factory, and it never invents an address.

It runs three steps, entirely through the [Worker](#worker) RPC proxy:

1. **Pick holders to test.** From the top holders Blockscout already
   returned, pick up to 3 that are *not* contracts, have a balance above
   zero, and aren't zero/burn addresses.
2. **Detect liquidity pools.** Among the top 10 holders that *are*
   contracts, call `token0()` (`0x0dfe1681`) and `token1()`
   (`0xd21220a7`) on each one. A holder that returns two valid addresses,
   one of which is the scanned token itself, is treated as a pool — no
   assumption is made about which DEX it belongs to.
3. **Simulate a transfer with `eth_call`** (never a real transaction) for
   each selected holder: `from` the holder, `to` the token, `data` a
   `transfer(recipient, amount)` call encoded by hand (amount = 1% of
   that holder's balance, at least 1 raw unit) —
   a) a **baseline** simulation with a fixed, neutral probe address as
      recipient, and
   b) a **sell-like** simulation with each detected pool as recipient.
   Calls are batched (max 10 per JSON-RPC batch). A revert, an RPC
   error, or a returned value of `false` counts as failure; empty
   returndata counts as success (some tokens don't return a bool).

**Interpretation:**
- Baseline succeeds, every pool-directed transfer fails → **High**,
  "Selling appears blocked".
- The baseline itself fails → **High**, "Transfers are restricted"
  (consistent with a pause, blacklist, or allowlist).
- Both succeed → **Passed**, "Sell simulation passed" — shown with the
  caveat that this is an indicator, not proof, and cannot detect every
  trap.
- No pool found among the top holders → **Info/Unknown**, "No liquidity
  pool found among top holders, sell could not be simulated".
- The Worker or the upstream RPC is unreachable → **Info/Unknown**,
  never counted as a pass.

Every finding shows a **"How this was checked"** collapsible: which
holder(s) were used, which pool addresses were detected, and which calls
succeeded or failed — each address linked to its Blockscout page. When the
outcome is **Unknown because the Worker/RPC could not be reached** (or a
specific call to it errored), the finding also gets its own collapsible
**Technical details** — the same format as the network-status and scan
Technical details panels: which call it was (`owner()` / `token0()` /
`token1()` / the `transfer()` simulation), the URL, the page's origin, the
browser error name/message, the HTTP status (if any), the first 300
characters of the response body, and a `kind` classification
(`network-or-cors`, `timeout`, `origin-rejected`, `validation-rejected`,
`upstream-unreachable`, or `json-rpc-error` — see
[Worker](#worker) below for what each one means). This applies to the
**Owner status** finding too, for the same reason.

**Limits, by design:**
- It **cannot measure buy/sell tax** — a transfer can succeed while still
  taking a cut; this check only detects an outright block, not a fee.
- It **cannot see rules that only trigger inside a router's `swap`
  call** — some tokens only misbehave when the caller is a specific
  router contract mid-swap, which a direct `transfer()` simulation from
  the holder doesn't reproduce.
- **Time- or amount-based traps can slip through** — a token that only
  blocks transfers above a threshold, or after/before a certain time
  window, may pass this simulation while still being a honeypot in
  practice.
- It only runs at all when at least one eligible holder and one detected
  pool exist; the pure interpretation logic lives in `scoreSellSimulation`
  in `scoring.js`, unit-tested against fixtures for every outcome above
  (blocked, restricted, passed, no pool, no holder, Worker unreachable).

### Number formatting

Counts (holders) and raw token amounts use thousands separators
everywhere (`365,893`, not `365893`); `scoring.js`'s
`addThousandsSeparators` does this on the *string* form of large token
amounts specifically so it never loses precision by round-tripping
through a JS `Number`. Prices use "sensible" decimals — 2 for values
$1 and up, more for sub-$1 prices so small values aren't rounded to
`$0.00`. Volume and market cap are shown **compact** in the risk finding
(`$867.6M`, `$3.24B`) and in **full**, with separators, in the details
table. The `$` is only added for `priceUsd`/`volume24hUsd`/
`marketCapUsd` specifically, based on Blockscout's documented convention
that `exchange_rate` (and the related volume/market-cap fields) are
USD-denominated platform-wide — see
`MARKET_DATA_ASSUMED_CURRENCY` in `scoring.js` for the exact reasoning
and the same could-not-verify-from-this-sandbox caveat as everything
else Blockscout-shaped in this README.

`scoring.js` is a standalone module of pure functions (no network calls,
no DOM) with a `THRESHOLDS` table at the top — edit the numbers there to
retune any check without touching `app.js`. It also holds small,
hand-rolled ABI helpers (4-byte selectors, 32-byte arg padding, and
address/bool return decoding) used by the owner check and the
sell-simulation honeypot check — no ABI-encoding library is used. See
[`tests/scoring.test.js`](./tests/scoring.test.js) for the full set of
sample inputs/outputs — including a **USDG-like fixture** (verified,
upgradeable proxy, 365,893 holders, 139 days old, top holder 12.6%, top
10 = 50%, which must score Medium at most) and an **Agraris-like
fixture** (unverified, a single holder owning 100% of only 2 holders
total, which must score High) — both fixtures also confirm that a
blocked-sell or restricted-transfers honeypot outcome never scores lower
than High, and that an unreachable Worker never lowers the overall level
— runnable with:

```bash
node --test tests/scoring.test.js
```

(uses Node's built-in test runner — no npm install needed, consistent
with the rest of this project.)

## Tech

- Plain HTML, CSS, and JavaScript (ES modules) — no build step, no npm.
- [viem](https://viem.sh) is loaded from a version-pinned ES module CDN
  (`https://esm.sh/viem@2.21.19`), used *only* for its `isAddress` /
  `getAddress` / `formatUnits` utilities (pure functions, no network). It
  is not used as an RPC client — all RPC calls go through the Worker via
  plain `fetch()` and hand-rolled JSON-RPC/ABI encoding in `app.js` and
  `scoring.js`.
- All chain/Blockscout configuration lives in a single `CONFIG` constant
  at the top of `app.js`: `chainId`, `chainName`, `explorerUrl`, and
  `explorerApiUrl` (the Blockscout API v2 base URL — the primary source).
  The Worker RPC proxy's URL is a separate `WORKER_URL` constant next to
  `CONFIG` — the single place every RPC call in the app is routed
  through. **The site never constructs a request to
  `rpc.mainnet.chain.robinhood.com` directly.**
- Risk scoring logic lives in `scoring.js`, a separate module of pure
  functions imported by `app.js` — `app.js` gathers "facts" from
  Blockscout/the Worker and hands them to `scoreToken()`, which does no
  I/O of its own (that's what makes it unit-testable without mocking a
  network).

## Project structure

```
index.html          # page structure
style.css            # styling (mobile-first, light theme)
app.js               # app logic (ES module, imports viem utils + scoring.js)
scoring.js           # Risk Score v1 — pure, rule-based scoring + ABI helpers
tests/scoring.test.js  # unit tests for scoring.js (node --test)
assets/              # brand imagery — see "Branding assets" below
worker/              # Cloudflare Worker RPC proxy — see "Worker" below
  index.js             # the Worker itself (single file, no dependencies)
  README.md            # deploy steps, /health, rate limiting
  tests/worker.test.js # unit tests for its validation/CORS logic (node --test)
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
primary and the Worker RPC secondary failed), or a scan shows a
Blockscout error, open **Technical details** on the page — it shows, for
every source that was tried: the exact browser error name/message, the
HTTP status (if a response came back at all), the URL, and the page's
origin. That's usually enough to tell what's wrong:

- **Error name `TypeError`, message `Failed to fetch` (or similar)** — the
  browser couldn't complete the request at all. The Fetch API doesn't
  expose *why* for security reasons, but it's one of: a CORS restriction
  (the endpoint didn't return `Access-Control-Allow-Origin` for this
  page's origin), an invalid/expired TLS certificate, no network
  connectivity, a DNS failure, or the endpoint being down. This is why the
  site talks to the Worker (`WORKER_URL`) instead of
  `rpc.mainnet.chain.robinhood.com` directly — that raw endpoint has been
  reported unreachable from some mobile devices (a TLS certificate error),
  while the Worker sits in front of it on Cloudflare's own edge and
  explicitly adds CORS headers for this site's origin. To narrow down a
  Worker failure, open `https://conge-rpc.agrarisai.workers.dev/health`
  directly in a browser tab (it's not origin-restricted, see
  [Worker](#worker) below) — if that also fails, the Worker itself or its
  upstream RPC is down, not a CORS issue.
- **An HTTP status (403, 429, 5xx, …)** — the request reached the server,
  which rejected or failed it. 403 from the Worker specifically means the
  request's `Origin` isn't `https://agrarisai.github.io` (by design); 429
  means rate-limiting; 5xx/502 means the Worker or its upstream is having
  problems.
- **A JSON-RPC error** (Worker RPC secondary only) — the request and
  response both worked at the HTTP level, but the node returned a
  JSON-RPC `error` object (e.g. an unsupported method).

### Checking CORS from the command line

You can check whether an endpoint sends CORS headers for this site's
origin with `curl`. For the Blockscout API (primary):

```bash
curl -i "https://robinhoodchain.blockscout.com/api/v2/stats" \
  -H "Origin: https://agrarisai.github.io"
```

For the Worker (RPC secondary):

```bash
curl -i -X POST https://conge-rpc.agrarisai.workers.dev \
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
> `esm.sh`, `docs.blockscout.com`, and `conge-rpc.agrarisai.workers.dev`
> entirely — every attempt (via `curl` and via a web-fetch tool) failed at
> the proxy/CONNECT level before a request ever reached those hosts. So
> neither the Blockscout/Worker CORS checks above nor the exact
> Blockscout API v2 response field names could be verified from this
> environment; the sell-simulation honeypot check and the Worker's
> `eth_call` `"from"` handling were instead verified by reading
> `worker/index.js` directly and with a mocked-`fetch()` Playwright
> harness (never committed) exercising every interpretation outcome. The
> field names used in `app.js`
> (`total_blocks`, `is_contract`, `is_verified`, `name`, `symbol`,
> `decimals`, `total_supply`, `holders_count`/`holders`, `exchange_rate`,
> `volume_24h`, `circulating_market_cap`, `creation_transaction_hash`/
> `creation_tx_hash`, `timestamp`, `abi`, `proxy_type`, the
> `/tokens/{address}/holders` items' `address.hash`/`address.is_contract`/
> `value`, and the proxy-admin guess `proxy_admin`/`admin` on
> `/smart-contracts/{address}`) are based on the documented/standard
> Blockscout API v2 schema, with defensive fallbacks where I was least
> confident — the proxy-admin field name in particular is a low-confidence
> guess (see Risk Score v1's check 5a above), wired up to gracefully no-op
> if wrong rather than ship dead-on-arrival. Every field that isn't
> present in the response is shown as "Unavailable" (or, for Risk Score
> v1, "Unknown" — see above) rather than guessed — please verify against
> the live API (`curl https://robinhoodchain.blockscout.com/api/v2/tokens/<address>`,
> `.../addresses/<address>`, `.../smart-contracts/<address>`,
> `.../tokens/<address>/holders`, and `.../transactions/<hash>` for a
> known creation tx) and adjust the field names in `app.js`'s
> `scanToken()` if any of them turn out to be wrong for this instance —
> `scoring.js` itself takes plain facts and doesn't need to change.

### If the Blockscout API also blocks browser requests

Both the Blockscout API and the RPC are official, first-party endpoints
for this chain. The RPC's CORS gap is already handled by the Worker (see
below); if it turns out Blockscout *also* doesn't send CORS headers for
this origin, here are the options, in rough order of effort — **do not**
route
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
   and the proxy shouldn't either). **This option is now implemented** —
   see [Worker](#worker) below — but as an RPC proxy specifically, not a
   Blockscout API proxy; if Blockscout itself ever turns out to block
   browser origins, the same pattern (a Worker forwarding to Blockscout
   with CORS headers added) would need to be built separately.

This section otherwise does not implement option 1, since Blockscout CORS
support couldn't be verified from this environment (see the note above) —
if the `curl` check confirms Blockscout also blocks browser origins, come
back to this list.

## Worker

[`worker/`](./worker) holds a small, dependency-free Cloudflare Worker
(`worker/index.js`, a single file) that proxies read-only JSON-RPC calls
to `rpc.mainnet.chain.robinhood.com` — the raw RPC endpoint, which this
site never calls directly (see
[Troubleshooting network connectivity](#troubleshooting-network-connectivity)
above for why that endpoint can fail from some networks). It:

- only forwards `eth_chainId`, `eth_blockNumber`, `eth_call`, and
  `eth_getCode`, all restricted to the `"latest"` block (no historical
  reads, nothing that could write or sign) — `eth_call`'s optional `from`
  field is validated and forwarded untouched, which the owner check and
  the sell-simulation honeypot check both rely on;
- validates addresses/call data as hex before forwarding;
- only accepts requests from `https://agrarisai.github.io` (no wildcard
  CORS);
- **retries a rate-limited or overloaded upstream call** (HTTP `429`/`503`
  from `rpc.mainnet.chain.robinhood.com` — the RPC is shared, so this
  happens under load) up to 3 times total, with exponential backoff
  starting around 300ms, all within the existing 8s overall timeout — see
  [Rate limiting](#rate-limiting) below;
- times out upstream calls after 8s and reports `502` with a real reason
  if the upstream still fails after retries, rather than hanging;
- exposes `GET /health` as a one-tap, no-CORS diagnostic you can open
  directly in a phone browser to check whether the upstream RPC is
  reachable right now;
- holds no secrets and no state (no KV, no D1) and never logs request
  bodies.

See [`worker/README.md`](./worker/README.md) for how to deploy it via the
Cloudflare dashboard (no CLI needed) and how to read `/health`. Its pure
validation/CORS logic has its own unit tests, runnable with
`node --test worker/tests/worker.test.js`.

**The Worker is deployed and wired into `app.js`** as the `WORKER_URL`
constant (`https://conge-rpc.agrarisai.workers.dev`, next to `CONFIG` —
see [Tech](#tech) above). Every RPC call the site makes — the network
status chain-ID cross-check, the owner check, and the sell-simulation
honeypot check — goes through it; there is no direct-to-upstream code
path left in `app.js`. If you deploy your own copy of the Worker (a
different Cloudflare account/subdomain), update `WORKER_URL` to match.

### Diagnosing a Worker connection problem

`GET /health` opened directly in a browser tab is a **top-level
navigation, not subject to CORS** — it only proves the Worker itself is up
and can reach its upstream RPC. It does **not** prove that a cross-origin
`fetch()` POST from `https://agrarisai.github.io` (what the site actually
does) succeeds, since CORS is a browser-side restriction that only applies
to that kind of request. If Network status, the owner check, or the
sell-simulation check report the Worker/RPC as unreachable while `/health`
works fine in a browser tab, use these in order:

1. **The "Test Worker connection" button**, in the Network status card.
   It sends two real POSTs straight from your browser: (a) a bare
   `eth_chainId`, and (b) an `eth_call` that includes a `"from"` field
   (`balanceOf()` on the most recently scanned token, or on the fixed
   probe address if nothing's been scanned yet — never a guessed "real"
   contract address). Each result is shown as either *"never reached the
   Worker"* (the signature of a CORS/preflight failure — the browser
   blocked the request before it left, or it timed out) or *"reached the
   Worker, which rejected it"* (a validation rejection — the request
   arrived and the Worker's own logic said no), with a **Technical
   details** panel underneath showing the exact status/body/error for
   each.
2. **Any per-finding Technical details** — on the Owner status and
   Sell-simulation findings themselves, whenever they're Unknown because
   of a failed Worker call (see [above](#sell-simulation-honeypot-check)).
3. **The `kind` classification** in any Technical details panel tells you
   which of these happened:
   - `network-or-cors` / `timeout` — the request **never reached the
     Worker at all**. This is what a CORS/preflight rejection, an invalid
     TLS certificate, or the Worker being fully down all look like from
     inside the browser (it can't tell them apart — see
     [Troubleshooting network connectivity](#troubleshooting-network-connectivity)
     above).
   - `origin-rejected` — the request reached the Worker, which returned
     `403` because the `Origin` header wasn't `https://agrarisai.github.io`.
   - `validation-rejected` — the request reached the Worker, which
     rejected it as malformed or oversized (`400`/`413`) — a bug in the
     request, not a CORS problem.
   - `upstream-unreachable` — the Worker itself is fine and accepted the
     request, but its own call to `rpc.mainnet.chain.robinhood.com`
     failed (`502`) for a reason other than rate limiting.
   - `upstream-rate-limited` — the Worker accepted the request and reached
     the upstream RPC, but the upstream rate-limited it (`502`) even after
     the Worker's own retries — see [Rate limiting](#rate-limiting) below.
     Not a CORS problem, and usually resolves itself on retry.
   - `json-rpc-error` — the Worker accepted the request and got a real
     answer from upstream, but that specific call reverted or otherwise
     errored (e.g. a contract with no `owner()` function) — not a
     connectivity problem at all.

**On the reported symptom** (Owner and sell-simulation both Unknown, while
`/health` works): this PR reviewed `worker/index.js` line by line for
anything that could cause a real browser POST to fail — CORS headers,
origin matching, preflight handling, batch/param validation — and found
nothing wrong against the CORS/JSON-RPC spec. To go further than reading
the code, [`worker/tests/worker.test.js`](./worker/tests/worker.test.js)
now drives the Worker's **actual `fetch(request)` entry point** (not just
its internal pure functions) with real `Request` objects shaped exactly
like a browser: a genuine preflight (`OPTIONS` with `Origin` +
`Access-Control-Request-Method` + `Access-Control-Request-Headers`)
followed by a real 10-item POST batch including an `eth_call` with a
`"from"` field — both succeed with correct headers, and a same-origin
check confirms a disallowed origin is still cleanly rejected with no
wildcard fallback. **No code change was needed or made to
`worker/index.js` in this PR** — it already behaves correctly for every
scenario these tests (and manual code review) could construct.

Since the code checks out but the live symptom is real, the most likely
explanations are outside this file:
- **The live deployment may not exactly match this repository's
  `worker/index.js`** (a dashboard paste can silently diverge from the
  repo over time). As a precaution, re-copy the current
  `worker/index.js` into the Cloudflare dashboard and redeploy — see
  [`worker/README.md`](./worker/README.md) for the exact steps (Workers &
  Pages → your Worker → Edit code → paste → Save and deploy). This is
  harmless either way: if the live code already matched, redeploying
  changes nothing.
- **A Cloudflare zone-level security feature** (e.g. Bot Fight Mode,
  Browser Integrity Check) could in principle block a `fetch()`-originated
  request while allowing a real top-level navigation like opening
  `/health` in a tab. These are dashboard settings, not something this
  code controls — check **Security** in the Cloudflare dashboard for the
  zone this Worker is deployed under if the problem persists after a
  redeploy.
- Whatever the cause turns out to be, the "Test Worker connection" button
  and the new per-finding Technical details above will now show the real
  browser error, HTTP status, and response body directly, rather than a
  bare "could not be reached" — please re-test on the live site and share
  what they show if the issue isn't resolved by a redeploy.

**Update — root cause found.** Exactly this diagnostic path (the "Test
Worker connection" self-test's Technical details) identified the real
cause on the live site: `eth_chainId` succeeded, but an `eth_call` with a
`"from"` field came back `502` with detail `"Upstream returned HTTP 429"`
— the shared upstream RPC rate-limiting the Worker, not a CORS or
validation problem at all. See [Rate limiting](#rate-limiting) below for
the fix. This is a good example of the diagnostics above doing their job:
the `kind` classification (`upstream-unreachable` at the time, now further
split out as `upstream-rate-limited`) pointed straight at the real cause
instead of leaving it as an unexplained "could not be reached".

### Rate limiting

`rpc.mainnet.chain.robinhood.com` is a shared, third-party endpoint and
can rate-limit (`429`) or briefly overload (`503`) under load — the
Worker proxies to it, so a Worker call can fail for this reason even
though nothing about CORS, origin, or validation is wrong. Two layers of
resilience handle this, both within the project's existing constraints
(no new dependencies, no secrets/state):

- **In the Worker** (`callUpstream` in `worker/index.js`): a `429`/`503`
  from the upstream is retried up to 3 times total, with exponential
  backoff starting around 300ms (300ms, then 600ms between attempts) —
  all within the existing 8s overall `UPSTREAM_TIMEOUT_MS` budget, so a
  request never hangs longer than it already could. If every attempt is
  still rate-limited, the Worker returns `502` with a body that clearly
  says so: `{"error": "Upstream RPC request failed", "detail": "Upstream
  is rate limited (HTTP 429) after 3 attempts", "kind":
  "upstream-rate-limited"}` — that `kind` field is what lets `app.js` (and
  the Technical details panels) show a specific "the RPC is busy, please
  try again" message instead of a generic connectivity error. Any other
  upstream HTTP error is *not* retried and fails immediately, exactly as
  before.
- **In `app.js`**, for the owner check and the sell-simulation honeypot
  check specifically — the two checks that can make several *sequential*
  Worker batches for one scan (`callWorkerChunked`): a small delay
  (`CHUNK_DELAY_MS`, 250ms) is inserted *between* sequential batches
  (never before the first one) to spread the load out and make hitting
  the rate limit less likely in the first place, and if a batch still
  comes back with `kind: "upstream-rate-limited"` after the Worker's own
  retries, that one batch is retried once more (after
  `RATE_LIMIT_RETRY_DELAY_MS`, 600ms) before the check gives up and shows
  Unknown. This is what keeps a normal scan from failing outright over
  what's usually a brief, transient rate limit — the network status
  probe (a single, simple batch) doesn't need this since it isn't making
  sequential batches.

`worker/tests/worker.test.js` covers this against the real
`fetch(request)` handler: a `429` followed by a success (confirms the
retry happens and the Worker still returns `200`), a `429` on every
attempt (confirms it gives up after exactly 3 tries and returns the
`upstream-rate-limited`-labeled `502`), a `503` retried the same way as
`429`, and a non-retryable error like `500` failing immediately with no
retry — runnable with `node --test worker/tests/worker.test.js`.

## Security notes

- This is a **read-only** tool: it does not connect wallets, request
  signatures, or send transactions.
- No secrets or API keys are required or stored; both the Blockscout API
  and the RPC endpoint are public.
- Always verify token information independently (e.g. via the block
  explorer) before making any decisions — Conge does not provide
  financial advice.
