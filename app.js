import {
  createPublicClient,
  http,
  defineChain,
  isAddress,
  getAddress,
  formatUnits,
} from "https://esm.sh/viem@2.21.19";

// Single source of truth for chain/explorer/RPC configuration.
//
// The Blockscout API v2 (explorerApiUrl) is the PRIMARY data source for
// this site — it's what Network status and Scan a token rely on to work
// at all. rpcUrls is an OPTIONAL secondary source: if reachable, it adds
// extra data (e.g. a token's owner() call, or a cross-check of the chain
// ID), but the site must work fully with rpcUrls empty or unreachable.
// Only add an RPC endpoint here once you've verified it exists and
// allows browser (CORS) requests from this site's origin — see
// README.md for how to check.
const CONFIG = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  explorerApiUrl: "https://robinhoodchain.blockscout.com/api/v2",
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
};

const FETCH_TIMEOUT_MS = 10_000;
const BLOCKSCOUT_SOURCE = "Blockscout API v2";

const robinhoodChain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: CONFIG.rpcUrls },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: CONFIG.explorerUrl },
  },
});

// Only used for the optional RPC secondary source (currently: reading a
// token's owner()). Given a short timeout so a dead/unreachable RPC never
// makes the (Blockscout-driven) scan hang.
const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(CONFIG.rpcUrls[0], { timeout: FETCH_TIMEOUT_MS }),
});

// Only owner() is read over RPC now — every other token field comes from
// the Blockscout API (see scanToken below).
const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// --- Shared fetch/diagnostics helpers -----------------------------------

// Low-level fetch with a timeout, returning either the raw Response (plus
// parsed JSON body, if any) or a diagnostic describing exactly how the
// request failed. Used by both the Blockscout REST calls and the RPC
// JSON-RPC probe so error classification (network/CORS vs HTTP vs
// invalid body) is consistent across sources.
async function fetchRaw(url, options, label) {
  const diagnostic = { url, label, pageOrigin: window.location.origin };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      diagnostic.errorName = error.name;
      diagnostic.errorMessage = error.message;
      diagnostic.kind = error.name === "AbortError" ? "timeout" : "network-or-cors";
      return { ok: false, diagnostic };
    }

    diagnostic.httpStatus = response.status;
    diagnostic.httpStatusText = response.statusText;

    const rawText = await response.text();
    let body = null;
    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch {
      body = null;
    }

    return { ok: true, response, rawText, body, diagnostic };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Fetches a Blockscout API v2 JSON endpoint. Non-2xx and non-JSON bodies
// are reported as failures (with `status` attached so callers can special
// -case e.g. 404) with a diagnostic ready for the Technical details panel.
async function fetchBlockscout(path, label) {
  const url = `${CONFIG.explorerApiUrl}${path}`;
  const raw = await fetchRaw(url, { headers: { Accept: "application/json" } }, label);
  if (!raw.ok) {
    return raw;
  }

  const { response, rawText, body, diagnostic } = raw;

  if (!response.ok) {
    diagnostic.errorName = "HTTPError";
    diagnostic.errorMessage =
      (body && (body.message || (Array.isArray(body.errors) && body.errors[0]))) ||
      response.statusText ||
      rawText.slice(0, 200) ||
      `HTTP ${response.status}`;
    diagnostic.kind = "http";
    return { ok: false, status: response.status, body, diagnostic };
  }

  if (body === null) {
    diagnostic.errorName = "SyntaxError";
    diagnostic.errorMessage = `Response body was not valid JSON (first 200 chars): ${rawText.slice(0, 200)}`;
    diagnostic.kind = "invalid-response";
    return { ok: false, diagnostic };
  }

  return { ok: true, status: response.status, body, diagnostic };
}

// Plain fetch() JSON-RPC POST — deliberately bypasses viem's transport so
// the raw browser error (name/message), HTTP status, and response body
// are all directly inspectable for the RPC secondary source.
async function probeRpcUrl(url) {
  const raw = await fetchRaw(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
    },
    "RPC (secondary) — eth_chainId / eth_blockNumber",
  );
  if (!raw.ok) {
    return raw;
  }

  const { response, rawText, body, diagnostic } = raw;

  if (!response.ok) {
    const bodyError = body && (Array.isArray(body) ? body.find((entry) => entry.error)?.error : body.error);
    diagnostic.errorName = "HTTPError";
    diagnostic.errorMessage = bodyError
      ? bodyError.message
      : response.statusText || rawText.slice(0, 200) || `HTTP ${response.status}`;
    diagnostic.kind = "http";
    return { ok: false, diagnostic };
  }

  if (body === null) {
    diagnostic.errorName = "SyntaxError";
    diagnostic.errorMessage = `Response body was not valid JSON (first 200 chars): ${rawText.slice(0, 200)}`;
    diagnostic.kind = "invalid-response";
    return { ok: false, diagnostic };
  }

  const results = Array.isArray(body) ? body : [body];
  const chainIdEntry = results.find((entry) => entry.id === 1) ?? results[0];
  const blockNumberEntry = results.find((entry) => entry.id === 2) ?? results[1];

  if (chainIdEntry?.error) {
    diagnostic.errorName = "JSONRPCError";
    diagnostic.errorMessage = chainIdEntry.error.message;
    diagnostic.errorCode = chainIdEntry.error.code;
    diagnostic.kind = "jsonrpc";
    return { ok: false, diagnostic };
  }

  if (!chainIdEntry || typeof chainIdEntry.result !== "string") {
    diagnostic.errorName = "InvalidJSONRPCResponse";
    diagnostic.errorMessage = "Response did not include a valid eth_chainId result.";
    diagnostic.kind = "invalid-response";
    return { ok: false, diagnostic };
  }

  const chainId = parseInt(chainIdEntry.result, 16);
  const blockNumber =
    blockNumberEntry && !blockNumberEntry.error && typeof blockNumberEntry.result === "string"
      ? parseInt(blockNumberEntry.result, 16)
      : null;

  return { ok: true, chainId, blockNumber, diagnostic };
}

function friendlyMessageFor(diagnostic, sourceLabel) {
  switch (diagnostic.kind) {
    case "network-or-cors":
      return (
        `Could not reach ${sourceLabel} (browser reported a generic network failure). ` +
        "This is most often a CORS restriction, an invalid/expired TLS certificate, no network " +
        "connectivity, a DNS failure, or the endpoint being down. Browsers hide the exact reason " +
        "for security — see Technical details below."
      );
    case "timeout":
      return `${sourceLabel} did not respond within ${FETCH_TIMEOUT_MS / 1000}s. It may be overloaded or unreachable from your network.`;
    case "http":
      if (diagnostic.httpStatus === 429) {
        return `${sourceLabel} is rate-limiting requests (HTTP 429). Please wait a moment and retry.`;
      }
      if (diagnostic.httpStatus === 403) {
        return `${sourceLabel} rejected this request (HTTP 403 Forbidden). It may be blocking requests from browsers or from this origin.`;
      }
      if (diagnostic.httpStatus >= 500) {
        return `${sourceLabel} returned a server error (HTTP ${diagnostic.httpStatus}). It may be temporarily down.`;
      }
      return `${sourceLabel} returned HTTP ${diagnostic.httpStatus} ${diagnostic.httpStatusText || ""}.`.trim();
    case "jsonrpc":
      return `${sourceLabel} returned a JSON-RPC error: ${diagnostic.errorMessage}`;
    case "invalid-response":
      return `${sourceLabel} returned a response that couldn't be understood.`;
    default:
      return `${sourceLabel} connection error: ${diagnostic.errorMessage || "unknown error"}`;
  }
}

function renderTechnicalDetails(targetEl, attempts) {
  const lines = attempts.map((diagnostic) => {
    const parts = [
      diagnostic.label || diagnostic.url,
      `  URL:          ${diagnostic.url}`,
      `  Page origin:  ${diagnostic.pageOrigin}`,
      `  Result:       ${diagnostic.ok ? "ok" : (diagnostic.errorName ?? "—")}`,
    ];
    if (!diagnostic.ok) {
      parts.push(`  Error message: ${diagnostic.errorMessage ?? "—"}`);
    }
    parts.push(
      `  HTTP status:  ${diagnostic.httpStatus !== undefined ? `${diagnostic.httpStatus} ${diagnostic.httpStatusText || ""}`.trim() : "(no HTTP response — request failed before completion)"}`,
      `  Kind:         ${diagnostic.kind ?? "success"}`,
    );
    return parts.join("\n");
  });

  targetEl.textContent = lines.join("\n\n");
}

// --- Section 1: Network status ---------------------------------------

const networkNameEl = document.getElementById("network-name");
const networkChainIdEl = document.getElementById("network-chain-id");
const networkBlockNumberEl = document.getElementById("network-block-number");
const networkSourceEl = document.getElementById("network-source");
const networkConnectionStatusEl = document.getElementById("network-connection-status");
const networkErrorEl = document.getElementById("network-error");
const networkTechDetailsEl = document.getElementById("network-tech-details");
const networkTechDetailsContentEl = document.getElementById("network-tech-details-content");
const networkRetryButton = document.getElementById("network-retry");
const explorerLink = document.getElementById("explorer-link");

explorerLink.href = CONFIG.explorerUrl;

async function fetchBlockscoutStats() {
  const result = await fetchBlockscout("/stats", `${BLOCKSCOUT_SOURCE} — GET /stats`);
  if (!result.ok) {
    return result;
  }
  const totalBlocks = result.body.total_blocks;
  if (totalBlocks === undefined || totalBlocks === null) {
    return {
      ok: false,
      diagnostic: {
        ...result.diagnostic,
        errorName: "MissingField",
        errorMessage: "Response did not include total_blocks.",
        kind: "invalid-response",
      },
    };
  }
  return { ok: true, totalBlocks, diagnostic: result.diagnostic };
}

function showNetworkTechDetails(attempts) {
  renderTechnicalDetails(networkTechDetailsContentEl, attempts.map((d) => ({ ...d, ok: !d.errorName })));
  networkTechDetailsEl.hidden = false;
}

async function checkNetworkStatus() {
  networkConnectionStatusEl.textContent = "Connecting…";
  networkConnectionStatusEl.className = "status-pending";
  networkErrorEl.hidden = true;
  networkTechDetailsEl.hidden = true;
  networkRetryButton.hidden = true;

  const attempts = [];

  const blockscoutResult = await fetchBlockscoutStats();
  attempts.push(blockscoutResult.diagnostic);

  const rpcUrl = CONFIG.rpcUrls[0];
  const rpcResult = rpcUrl ? await probeRpcUrl(rpcUrl) : null;
  if (rpcResult) {
    attempts.push(rpcResult.diagnostic);
  }

  networkNameEl.textContent = CONFIG.chainName;

  if (blockscoutResult.ok) {
    networkChainIdEl.textContent = String(CONFIG.chainId);
    networkBlockNumberEl.textContent = String(blockscoutResult.totalBlocks);

    if (rpcResult?.ok && rpcResult.chainId !== CONFIG.chainId) {
      networkSourceEl.textContent = `${BLOCKSCOUT_SOURCE} (RPC secondary ignored — chain ID mismatch)`;
      networkConnectionStatusEl.textContent = "Connected (RPC mismatch)";
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `RPC secondary returned chain ID ${rpcResult.chainId}, expected ${CONFIG.chainId}. Using ${BLOCKSCOUT_SOURCE} only.`;
      networkErrorEl.hidden = false;
      showNetworkTechDetails(attempts);
      networkRetryButton.hidden = false;
      return;
    }

    networkSourceEl.textContent = rpcResult?.ok ? `${BLOCKSCOUT_SOURCE} + RPC (secondary, confirmed)` : BLOCKSCOUT_SOURCE;
    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";

    // The primary source is fine — only surface the secondary's own
    // trouble for transparency, not as a page-level error.
    if (!rpcResult?.ok) {
      showNetworkTechDetails(attempts);
    }
    return;
  }

  // Blockscout (primary) failed — fall back to the optional RPC secondary
  // so the page can still work.
  if (rpcResult?.ok) {
    networkChainIdEl.textContent = String(rpcResult.chainId);
    networkBlockNumberEl.textContent = rpcResult.blockNumber !== null ? String(rpcResult.blockNumber) : "—";
    networkSourceEl.textContent = "RPC (secondary — Blockscout API unavailable)";

    if (rpcResult.chainId !== CONFIG.chainId) {
      networkConnectionStatusEl.textContent = "Unexpected chain ID";
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `The RPC endpoint returned chain ID ${rpcResult.chainId}, expected ${CONFIG.chainId}. Refusing to trust this endpoint.`;
      networkErrorEl.hidden = false;
      showNetworkTechDetails(attempts);
      networkRetryButton.hidden = false;
      return;
    }

    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";
    networkErrorEl.textContent = `${BLOCKSCOUT_SOURCE} is currently unreachable; showing data from the RPC secondary source instead.`;
    networkErrorEl.hidden = false;
    showNetworkTechDetails(attempts);
    return;
  }

  // Both sources failed.
  networkChainIdEl.textContent = String(CONFIG.chainId);
  networkBlockNumberEl.textContent = "—";
  networkSourceEl.textContent = "Unavailable";
  networkConnectionStatusEl.textContent = "Connection failed";
  networkConnectionStatusEl.className = "status-bad";
  networkErrorEl.textContent = friendlyMessageFor(blockscoutResult.diagnostic, BLOCKSCOUT_SOURCE);
  networkErrorEl.hidden = false;
  showNetworkTechDetails(attempts);
  networkRetryButton.hidden = false;
}

networkRetryButton.addEventListener("click", () => {
  checkNetworkStatus();
});

// --- Section 2: Scan a token -------------------------------------------

const scanForm = document.getElementById("scan-form");
const tokenAddressInput = document.getElementById("token-address");
const addressErrorEl = document.getElementById("address-error");
const scanButton = document.getElementById("scan-button");
const scanErrorEl = document.getElementById("scan-error");
const scanResultEl = document.getElementById("scan-result");
const scanTechDetailsEl = document.getElementById("scan-tech-details");
const scanTechDetailsContentEl = document.getElementById("scan-tech-details-content");

const resultAddressEl = document.getElementById("result-address");
const resultIsContractEl = document.getElementById("result-is-contract");
const resultNameEl = document.getElementById("result-name");
const resultSymbolEl = document.getElementById("result-symbol");
const resultDecimalsEl = document.getElementById("result-decimals");
const resultTotalSupplyEl = document.getElementById("result-total-supply");
const resultHoldersEl = document.getElementById("result-holders");
const resultVerifiedEl = document.getElementById("result-verified");
const resultOwnerEl = document.getElementById("result-owner");
const resultSourceEl = document.getElementById("result-source");

const UNAVAILABLE = "Unavailable";

function resetScanUI() {
  addressErrorEl.hidden = true;
  scanErrorEl.hidden = true;
  scanResultEl.hidden = true;
  scanTechDetailsEl.hidden = true;
}

// Best-effort owner() read over the optional RPC secondary. Blockscout
// has no generic "owner" field, so this is the only source for it.
async function tryReadOwner(address) {
  try {
    return await publicClient.readContract({ address, abi: OWNER_ABI, functionName: "owner" });
  } catch {
    return null;
  }
}

async function scanToken(rawAddress) {
  resetScanUI();

  const trimmed = rawAddress.trim();

  if (!isAddress(trimmed)) {
    addressErrorEl.textContent = "Enter a valid EVM address (0x followed by 40 hex characters).";
    addressErrorEl.hidden = false;
    return;
  }

  const address = getAddress(trimmed);

  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";

  try {
    const [addressResult, tokenResult, contractResult, owner] = await Promise.all([
      fetchBlockscout(`/addresses/${address}`, `${BLOCKSCOUT_SOURCE} — GET /addresses/{address}`),
      fetchBlockscout(`/tokens/${address}`, `${BLOCKSCOUT_SOURCE} — GET /tokens/{address}`),
      fetchBlockscout(`/smart-contracts/${address}`, `${BLOCKSCOUT_SOURCE} — GET /smart-contracts/{address}`),
      tryReadOwner(address),
    ]);

    // 404 on /tokens and /smart-contracts is an expected, valid answer
    // ("not a token" / "not verified"), not a failure to report.
    const tokenNotFound = !tokenResult.ok && tokenResult.status === 404;
    const contractNotVerified = !contractResult.ok && contractResult.status === 404;

    const realFailures = [addressResult, tokenResult, contractResult].filter((result) => {
      if (result.ok) return false;
      if (result === tokenResult && tokenNotFound) return false;
      if (result === contractResult && contractNotVerified) return false;
      return true;
    });

    const isContract = addressResult.ok ? Boolean(addressResult.body.is_contract) : null;

    if (isContract === false) {
      scanErrorEl.textContent =
        "This address has no contract code (per the Blockscout API). It looks like a regular wallet address, not a token contract.";
      scanErrorEl.hidden = false;
      if (realFailures.length > 0) {
        renderTechnicalDetails(
          scanTechDetailsContentEl,
          [addressResult, tokenResult, contractResult].map((r) => ({ ...r.diagnostic, ok: r.ok })),
        );
        scanTechDetailsEl.hidden = false;
      }
      return;
    }

    const isVerified = addressResult.ok && typeof addressResult.body.is_verified === "boolean"
      ? addressResult.body.is_verified
      : contractResult.ok
        ? true
        : contractNotVerified
          ? false
          : null;

    const tokenBody = tokenResult.ok ? tokenResult.body : null;
    const name = tokenBody?.name ?? (addressResult.ok ? addressResult.body.name : null) ?? null;
    const symbol = tokenBody?.symbol ?? null;

    const decimalsRaw = tokenBody?.decimals;
    const decimals =
      decimalsRaw === undefined || decimalsRaw === null || decimalsRaw === "" || Number.isNaN(Number(decimalsRaw))
        ? null
        : Number(decimalsRaw);

    const totalSupplyRaw = tokenBody?.total_supply ?? null;
    const holdersRaw = tokenBody?.holders_count ?? tokenBody?.holders ?? null;

    resultAddressEl.textContent = address;
    resultIsContractEl.textContent = isContract === null ? UNAVAILABLE : isContract ? "Yes" : "No";
    resultNameEl.textContent = name ?? UNAVAILABLE;
    resultSymbolEl.textContent = symbol ?? UNAVAILABLE;
    resultDecimalsEl.textContent = decimals === null ? UNAVAILABLE : String(decimals);

    if (totalSupplyRaw === null) {
      resultTotalSupplyEl.textContent = tokenNotFound ? "Unavailable (not a recognized token)" : UNAVAILABLE;
    } else if (decimals === null) {
      resultTotalSupplyEl.textContent = `${totalSupplyRaw} (raw units — decimals unavailable)`;
    } else {
      try {
        resultTotalSupplyEl.textContent = formatUnits(BigInt(totalSupplyRaw), decimals);
      } catch {
        resultTotalSupplyEl.textContent = `${totalSupplyRaw} (raw units)`;
      }
    }

    resultHoldersEl.textContent = holdersRaw === null ? UNAVAILABLE : String(holdersRaw);
    resultVerifiedEl.textContent = isVerified === null ? UNAVAILABLE : isVerified ? "Yes" : "No";
    resultOwnerEl.textContent = owner ? `${owner} (via RPC secondary)` : UNAVAILABLE;

    resultSourceEl.textContent = owner ? `${BLOCKSCOUT_SOURCE} + RPC (secondary, owner)` : BLOCKSCOUT_SOURCE;

    scanResultEl.hidden = false;

    if (realFailures.length > 0) {
      renderTechnicalDetails(
        scanTechDetailsContentEl,
        [addressResult, tokenResult, contractResult].map((r) => ({ ...r.diagnostic, ok: r.ok })),
      );
      scanTechDetailsEl.hidden = false;
    }
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = "Scan";
  }
}

scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  scanToken(tokenAddressInput.value);
});

// --- Init ---------------------------------------------------------------

checkNetworkStatus();
