import {
  createPublicClient,
  http,
  defineChain,
  isAddress,
  getAddress,
  formatUnits,
} from "https://esm.sh/viem@2.21.19";

// Single source of truth for chain/RPC configuration.
const CONFIG = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
};

const robinhoodChain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [CONFIG.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: CONFIG.explorerUrl },
  },
});

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(CONFIG.rpcUrl),
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
const networkRetryButton = document.getElementById("network-retry");
const explorerLink = document.getElementById("explorer-link");

explorerLink.href = CONFIG.explorerUrl;

function describeConnectionError(error) {
  const message = error && error.message ? error.message : String(error);

  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return "Could not reach the RPC endpoint. This may be a CORS restriction, a network issue, or the endpoint being temporarily down.";
  }
  if (message.toLowerCase().includes("429") || message.toLowerCase().includes("rate limit")) {
    return "The RPC endpoint is rate-limiting requests. Please wait a moment and retry.";
  }
  return `RPC connection error: ${message}`;
}

async function checkNetworkStatus() {
  networkConnectionStatusEl.textContent = "Connecting…";
  networkConnectionStatusEl.className = "status-pending";
  networkErrorEl.hidden = true;
  networkRetryButton.hidden = true;

  try {
    const [chainId, blockNumber] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
    ]);

    networkNameEl.textContent = CONFIG.chainName;
    networkChainIdEl.textContent = String(chainId);
    networkBlockNumberEl.textContent = blockNumber.toString();

    if (chainId !== CONFIG.chainId) {
      networkConnectionStatusEl.textContent = "Unexpected chain ID";
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `The RPC endpoint returned chain ID ${chainId}, expected ${CONFIG.chainId}. Refusing to trust this endpoint.`;
      networkErrorEl.hidden = false;
      networkRetryButton.hidden = false;
      return;
    }

    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";
  } catch (error) {
    networkConnectionStatusEl.textContent = "Connection failed";
    networkConnectionStatusEl.className = "status-bad";
    networkErrorEl.textContent = describeConnectionError(error);
    networkErrorEl.hidden = false;
    networkRetryButton.hidden = false;
  }
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
    scanErrorEl.textContent = describeConnectionError(error);
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
