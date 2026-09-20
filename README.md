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
  ID matches the expected value, and shows the latest block number. Clear
  error messages are shown if the connection fails (CORS, rate limiting,
  downtime, etc).
- **Scan a token** — enter a contract address to check it has contract
  code, then read `name`, `symbol`, `decimals`, `totalSupply`, and
  `owner()` (when present) and display them in a result card. No risk
  scoring yet — this is planned for a future version.

## Tech

- Plain HTML, CSS, and JavaScript (ES modules) — no build step, no npm.
- [viem](https://viem.sh) is loaded from a version-pinned ES module CDN
  (`https://esm.sh/viem@2.21.19`) for RPC/contract calls.
- All chain/RPC configuration lives in a single `CONFIG` constant at the
  top of `app.js`.

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

## Security notes

- This is a **read-only** tool: it does not connect wallets, request
  signatures, or send transactions.
- No secrets or API keys are required or stored; the RPC endpoint is
  public.
- Always verify token information independently (e.g. via the block
  explorer) before making any decisions — Conge does not provide
  financial advice.
