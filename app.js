import {
  createPublicClient,
  http,
  defineChain,
  isAddress,
  getAddress,
  formatUnits,
} from "https://esm.sh/viem@2.21.19";

// Single source of truth for chain/RPC configuration.
//
// rpcUrls is tried in order by checkNetworkStatus() (and used for the
// viem transport once a working one is found). Only add an endpoint here
// once you've verified it exists and actually allows browser (CORS)
// requests from this site's origin — see README.md for how to check.
const CONFIG = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  explorerUrl: "https://robinhoodchain.blockscout.com",
};

const RPC_TIMEOUT_MS = 10_000;

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

// The viem client is used for contract reads (Section 2). It's pointed at
// whichever RPC URL last proved reachable by the plain-fetch probe below,
// defaulting to the first configured URL until a probe succeeds.
let activeRpcUrl = CONFIG.rpcUrls[0];
let publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(activeRpcUrl),
});

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// --- Section 1: Network status ---------------------------------------

const networkNameEl = document.getElementById("network-name");
const networkChainIdEl = document.getElementById("network-chain-id");
const networkBlockNumberEl = document.getElementById("network-block-number");
const networkConnectionStatusEl = document.getElementById("network-connection-status");
const networkErrorEl = document.getElementById("network-error");
const networkTechDetailsEl = document.getElementById("network-tech-details");
const networkTechDetailsContentEl = document.getElementById("network-tech-details-content");
const networkRetryButton = document.getElementById("network-retry");
const explorerLink = document.getElementById("explorer-link");

explorerLink.href = CONFIG.explorerUrl;

// Does a plain fetch() JSON-RPC POST against `url`, bypassing viem's
// transport entirely, so the raw browser error (name/message), HTTP
// status, and response body are all directly inspectable. Sends
// eth_chainId and eth_blockNumber as a single JSON-RPC batch request.
async function probeRpcUrl(url) {
  const diagnostic = {
    rpcUrl: url,
    pageOrigin: window.location.origin,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
        ]),
        signal: controller.signal,
      });
    } catch (fetchError) {
      diagnostic.errorName = fetchError.name;
      diagnostic.errorMessage = fetchError.message;
      diagnostic.kind = fetchError.name === "AbortError" ? "timeout" : "network-or-cors";
      return { ok: false, diagnostic };
    }

    diagnostic.httpStatus = response.status;
    diagnostic.httpStatusText = response.statusText;

    const rawText = await response.text();
    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }

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

    // Normalize both batch (array) and non-batch (single object, for
    // endpoints that don't support JSON-RPC batching) responses.
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
  } finally {
    clearTimeout(timeoutId);
  }
}

function friendlyMessageFor(diagnostic) {
  switch (diagnostic.kind) {
    case "network-or-cors":
      return (
        "Could not reach the RPC endpoint (browser reported a generic network failure). " +
        "This is most often a CORS restriction (the endpoint didn't allow requests from this " +
        "site's origin), but can also be no internet connectivity, DNS failure, or the endpoint " +
        "being down. Browsers hide the exact reason for security — see Technical details below."
      );
    case "timeout":
      return `The RPC endpoint did not respond within ${RPC_TIMEOUT_MS / 1000}s. It may be overloaded or unreachable from your network.`;
    case "http":
      if (diagnostic.httpStatus === 429) {
        return "The RPC endpoint is rate-limiting requests (HTTP 429). Please wait a moment and retry.";
      }
      if (diagnostic.httpStatus === 403) {
        return "The RPC endpoint rejected this request (HTTP 403 Forbidden). It may be blocking requests from browsers or from this origin.";
      }
      if (diagnostic.httpStatus >= 500) {
        return `The RPC endpoint returned a server error (HTTP ${diagnostic.httpStatus}). It may be temporarily down.`;
      }
      return `The RPC endpoint returned HTTP ${diagnostic.httpStatus} ${diagnostic.httpStatusText || ""}.`.trim();
    case "jsonrpc":
      return `The RPC endpoint returned a JSON-RPC error: ${diagnostic.errorMessage}`;
    case "invalid-response":
      return "The RPC endpoint returned a response that couldn't be understood.";
    default:
      return `RPC connection error: ${diagnostic.errorMessage || "unknown error"}`;
  }
}

function renderTechnicalDetails(attempts) {
  const lines = attempts.map((diagnostic, index) => {
    const parts = [
      attempts.length > 1 ? `Attempt ${index + 1}` : "Attempt",
      `  RPC URL:      ${diagnostic.rpcUrl}`,
      `  Page origin:  ${diagnostic.pageOrigin}`,
      `  Error name:   ${diagnostic.errorName ?? "—"}`,
      `  Error message: ${diagnostic.errorMessage ?? "—"}`,
      `  HTTP status:  ${diagnostic.httpStatus !== undefined ? `${diagnostic.httpStatus} ${diagnostic.httpStatusText || ""}`.trim() : "(no HTTP response — request failed before completion)"}`,
      `  Failure kind: ${diagnostic.kind ?? "unknown"}`,
    ];
    return parts.join("\n");
  });

  networkTechDetailsContentEl.textContent = lines.join("\n\n");
}

async function checkNetworkStatus() {
  networkConnectionStatusEl.textContent = "Connecting…";
  networkConnectionStatusEl.className = "status-pending";
  networkErrorEl.hidden = true;
  networkTechDetailsEl.hidden = true;
  networkRetryButton.hidden = true;

  const attempts = [];

  for (const url of CONFIG.rpcUrls) {
    const result = await probeRpcUrl(url);
    attempts.push(result.diagnostic);

    if (!result.ok) {
      continue;
    }

    // This endpoint is reachable and speaking JSON-RPC — point viem's
    // client at it too, and stop trying further URLs in the list.
    activeRpcUrl = url;
    publicClient = createPublicClient({
      chain: robinhoodChain,
      transport: http(activeRpcUrl),
    });

    networkNameEl.textContent = CONFIG.chainName;
    networkChainIdEl.textContent = String(result.chainId);
    networkBlockNumberEl.textContent = result.blockNumber !== null ? String(result.blockNumber) : "—";

    if (result.chainId !== CONFIG.chainId) {
      networkConnectionStatusEl.textContent = "Unexpected chain ID";
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `The RPC endpoint returned chain ID ${result.chainId}, expected ${CONFIG.chainId}. Refusing to trust this endpoint.`;
      networkErrorEl.hidden = false;
      networkRetryButton.hidden = false;
      return;
    }

    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";
    return;
  }

  // Every configured RPC URL failed.
  networkConnectionStatusEl.textContent = "Connection failed";
  networkConnectionStatusEl.className = "status-bad";
  networkErrorEl.textContent = friendlyMessageFor(attempts[attempts.length - 1]);
  networkErrorEl.hidden = false;
  renderTechnicalDetails(attempts);
  networkTechDetailsEl.hidden = false;
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

const resultAddressEl = document.getElementById("result-address");
const resultNameEl = document.getElementById("result-name");
const resultSymbolEl = document.getElementById("result-symbol");
const resultDecimalsEl = document.getElementById("result-decimals");
const resultTotalSupplyEl = document.getElementById("result-total-supply");
const resultOwnerEl = document.getElementById("result-owner");

function resetScanUI() {
  addressErrorEl.hidden = true;
  scanErrorEl.hidden = true;
  scanResultEl.hidden = true;
}

function describeScanError(error) {
  const message = error && error.message ? error.message : String(error);

  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return "Could not reach the RPC endpoint. This may be a CORS restriction, a network issue, or the endpoint being temporarily down.";
  }
  if (message.toLowerCase().includes("429") || message.toLowerCase().includes("rate limit")) {
    return "The RPC endpoint is rate-limiting requests. Please wait a moment and retry.";
  }
  return `RPC connection error: ${message}`;
}

// Reads a single view function, returning a display value or a fallback
// when the call reverts (e.g. the token doesn't implement that function).
async function tryRead(address, functionName, fallback) {
  try {
    return await publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName,
    });
  } catch {
    return fallback;
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
    const bytecode = await publicClient.getCode({ address });

    if (!bytecode || bytecode === "0x") {
      scanErrorEl.textContent = "This address has no contract code. It looks like a regular wallet address, not a token contract.";
      scanErrorEl.hidden = false;
      return;
    }

    const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
      tryRead(address, "name", null),
      tryRead(address, "symbol", null),
      tryRead(address, "decimals", null),
      tryRead(address, "totalSupply", null),
      tryRead(address, "owner", null),
    ]);

    resultAddressEl.textContent = address;
    resultNameEl.textContent = name ?? "Not available";
    resultSymbolEl.textContent = symbol ?? "Not available";
    resultDecimalsEl.textContent = decimals === null ? "Not available" : String(decimals);

    if (totalSupply === null) {
      resultTotalSupplyEl.textContent = "Not available";
    } else if (decimals === null) {
      resultTotalSupplyEl.textContent = totalSupply.toString();
    } else {
      resultTotalSupplyEl.textContent = formatUnits(totalSupply, decimals);
    }

    resultOwnerEl.textContent = owner ?? "No owner() function (not present or reverted)";

    scanResultEl.hidden = false;
  } catch (error) {
    scanErrorEl.textContent = describeScanError(error);
    scanErrorEl.hidden = false;
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
