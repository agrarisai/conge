import { isAddress, getAddress, formatUnits } from "https://esm.sh/viem@2.21.19";

import {
  scoreToken,
  addThousandsSeparators,
  formatCount,
  formatPriceUsd,
  formatCompactUsd,
  MARKET_DATA_ASSUMED_CURRENCY,
  isBurnOrZeroAddress,
  SELECTOR,
  padAddressArg,
  encodeTransferCallData,
  decodeAddressResult,
  decodeTransferOutcome,
} from "./scoring.js";

// Cloudflare Worker RPC proxy (see worker/) — a thin, read-only JSON-RPC
// proxy for rpc.mainnet.chain.robinhood.com, deployed and confirmed
// healthy at this URL. ALL RPC calls from this site go through it; the
// raw upstream RPC is never called directly from the browser, since it's
// been reported unreachable from some networks (see "Troubleshooting
// network connectivity" in README.md). Blockscout remains the primary
// data source — the Worker is only ever an optional secondary source
// (chain-ID cross-check, owner(), the sell-simulation honeypot check
// below); the site works fully with it unreachable too.
const WORKER_URL = "https://conge-rpc.agrarisai.workers.dev";

// Single source of truth for chain/explorer configuration. The Blockscout
// API v2 (explorerApiUrl) is the PRIMARY data source for this site — it's
// what Network status and Scan a token rely on to work at all.
const CONFIG = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  explorerApiUrl: "https://robinhoodchain.blockscout.com/api/v2",
};

const FETCH_TIMEOUT_MS = 10_000;
const BLOCKSCOUT_SOURCE = "Blockscout API v2";
const WORKER_SOURCE = "Worker";

// The Worker's own batch-size limit (see worker/index.js's MAX_BATCH_SIZE)
// — calls to it must be chunked to this size or smaller.
const WORKER_MAX_BATCH_SIZE = 10;

// The shared upstream RPC the Worker proxies to has a tight rate limit
// that a full scan's *burst* of sequential eth_call requests (owner, then
// pool detection per top holder, then baseline/sell-like transfers per
// pool) can still trip even with the Worker's own per-request retries
// (worker/index.js's callUpstream, up to 5 attempts with backoff). Three
// layers of resilience here, from smallest to largest scope:
//   - CHUNK_DELAY_MS: a pause between sequential batches *within* one
//     multi-batch call (never before the first one) — see
//     callWorkerChunked below.
//   - RATE_LIMIT_RETRY_DELAY_MS: if a single batch still comes back
//     rate-limited after the Worker's own retries, that one batch is
//     retried once here before giving up — see callWorkerChunked below.
//   - WHOLE_CHECK_RATE_LIMIT_RETRY_DELAY_MS: if an entire check (the
//     owner lookup, or the sell-simulation honeypot check as a whole —
//     not any single attempt within it) still ends up rate-limited after
//     all of the above, the whole check is retried once more — see
//     withWholeCheckRateLimitRetry below.
const CHUNK_DELAY_MS = 500;
const RATE_LIMIT_RETRY_DELAY_MS = 600;
const WHOLE_CHECK_RATE_LIMIT_RETRY_DELAY_MS = 1500;

// True if `diagnostics` (as returned by callWorkerChunked) shows the
// failure was specifically rate limiting — as opposed to, say, the
// Worker being fully unreachable — which is the one case worth retrying
// an entire check for rather than just showing Unknown immediately.
function hasRateLimitedDiagnostic(diagnostics) {
  return Array.isArray(diagnostics) && diagnostics.some((d) => d?.kind === "upstream-rate-limited");
}

// Runs `runCheck` once; if the result looks rate-limited per `isRateLimited`,
// waits WHOLE_CHECK_RATE_LIMIT_RETRY_DELAY_MS and runs it exactly once
// more, returning whichever attempt's result (the retry's, win or lose —
// never more than one extra attempt, and the honest "Unknown" outcome and
// its real diagnostics are preserved either way, never hidden).
async function withWholeCheckRateLimitRetry(runCheck, isRateLimited) {
  const first = await runCheck();
  if (!isRateLimited(first)) return first;
  await sleep(WHOLE_CHECK_RATE_LIMIT_RETRY_DELAY_MS);
  return runCheck();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// An arbitrary, unfunded placeholder address with no special meaning to
// any token or protocol — used only as the baseline transfer-simulation
// recipient in the sell-simulation honeypot check below. eth_call never
// actually moves funds (it simulates against current state and discards
// the result), so this address never needs to be real or fundable; it
// just needs to be a plain, ordinary-looking recipient distinct from the
// zero/burn addresses (which some tokens special-case).
const PROBE_RECIPIENT_ADDRESS = "0x" + "ab".repeat(20);

// The address most recently scanned successfully (if any) — set in
// scanToken below. Used only by "Test Worker connection" to run its
// eth_call self-test against a real, already-confirmed contract instead
// of guessing at one; see testWorkerConnection.
let lastScannedTokenAddress = null;

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
    diagnostic.bodySnippet = rawText.slice(0, 300);
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

// The Worker's "/" POST route never proxies a raw non-2xx status from its
// upstream RPC — every non-2xx response it returns was generated by the
// Worker itself (see worker/index.js): 403 means the request's Origin
// isn't on its allow-list, 400/413 means it rejected the request as
// malformed or oversized before even reaching the upstream, and 502 means
// it reached out to its upstream RPC and that failed — either because the
// upstream was unreachable/erroring, or (body.kind === "upstream-rate-
// -limited") because the upstream rate-limited every retry the Worker
// already attempted on its own. Naming these distinctly (rather than a
// generic "http" kind) is what lets the UI and the "Test Worker
// connection" self-test tell a CORS/preflight failure (which never
// reaches this function — see the "network-or-cors" kind in fetchRaw
// above) apart from a same-origin request the Worker validated and
// rejected on its own terms.
function classifyWorkerHttpKind(status, body) {
  if (status === 403) return "origin-rejected";
  if (status === 400 || status === 413) return "validation-rejected";
  if (status === 502) return body?.kind === "upstream-rate-limited" ? "upstream-rate-limited" : "upstream-unreachable";
  return "http";
}

// Plain fetch() JSON-RPC POST to the Worker — deliberately bypasses any
// higher-level client so the raw browser error (name/message), HTTP
// status, and response body are all directly inspectable for the Worker
// secondary source.
async function probeWorker() {
  const raw = await fetchRaw(
    WORKER_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
    },
    `${WORKER_SOURCE} (secondary) — eth_chainId / eth_blockNumber`,
  );
  if (!raw.ok) {
    return raw;
  }

  const { response, rawText, body, diagnostic } = raw;

  if (!response.ok) {
    const bodyError = body && (Array.isArray(body) ? body.find((entry) => entry.error)?.error : body.error);
    diagnostic.errorName = "HTTPError";
    diagnostic.errorMessage =
      bodyError?.message || body?.detail || (typeof bodyError === "string" ? bodyError : null) || response.statusText || rawText.slice(0, 200) || `HTTP ${response.status}`;
    diagnostic.kind = classifyWorkerHttpKind(response.status, body);
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
    diagnostic.kind = "json-rpc-error";
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

// --- eth_call via the Worker (owner() read + sell-simulation honeypot) ---
//
// Sends up to WORKER_MAX_BATCH_SIZE eth_call requests to the Worker in
// one JSON-RPC batch POST. Returns { ok: true, results } if the Worker
// itself responded with a parseable JSON-RPC envelope — `results` has one
// entry per call, each { ok, result, errorMessage }, where `ok` reflects
// whether THAT SPECIFIC call succeeded (no JSON-RPC `error`), independent
// of the others. Returns { ok: false, diagnostic } only if the Worker
// itself couldn't be reached at all (network/timeout/non-JSON/non-2xx) —
// a deliberately different failure mode from a per-call revert, since the
// honeypot check needs to tell "the Worker is down" (Unknown) apart from
// "this specific call reverted" (a real, informative result).
async function callWorkerBatch(calls, label) {
  const requests = calls.map((call, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "eth_call",
    params: [
      call.from ? { to: call.to, data: call.data, from: call.from } : { to: call.to, data: call.data },
      "latest",
    ],
  }));

  const raw = await fetchRaw(
    WORKER_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requests.length === 1 ? requests[0] : requests),
    },
    label || `${WORKER_SOURCE} — eth_call batch`,
  );
  if (!raw.ok) {
    return { ok: false, diagnostic: raw.diagnostic };
  }

  const { response, rawText, body, diagnostic } = raw;

  if (!response.ok) {
    const bodyError = body && (Array.isArray(body) ? body.find((entry) => entry?.error)?.error : body.error);
    diagnostic.errorName = "HTTPError";
    diagnostic.errorMessage =
      bodyError?.message || body?.detail || (typeof bodyError === "string" ? bodyError : null) || response.statusText || `HTTP ${response.status}`;
    diagnostic.kind = classifyWorkerHttpKind(response.status, body);
    return { ok: false, diagnostic };
  }

  if (body === null) {
    diagnostic.errorName = "SyntaxError";
    diagnostic.errorMessage = `Worker response was not valid JSON (first 200 chars): ${rawText.slice(0, 200)}`;
    diagnostic.kind = "invalid-response";
    return { ok: false, diagnostic };
  }

  const resultsArray = Array.isArray(body) ? body : [body];
  const byId = new Map(resultsArray.filter((r) => r && typeof r === "object").map((r) => [r.id, r]));

  // Each call's own diagnostic starts from the shared batch-level one (same
  // URL/origin/HTTP status/body snippet — it was one HTTP request) with a
  // per-call kind/message layered on, so a Technical details panel for any
  // single call is self-contained without repeating the whole batch.
  const results = requests.map((req) => {
    const entry = byId.get(req.id);
    if (!entry) {
      const errorMessage = "The Worker returned no response for this call.";
      return { ok: false, result: null, errorMessage, diagnostic: { ...diagnostic, kind: "invalid-response", errorName: "MissingResult", errorMessage } };
    }
    if (entry.error) {
      const errorMessage = entry.error.message || "Call error.";
      return {
        ok: false,
        result: null,
        errorMessage,
        diagnostic: { ...diagnostic, kind: "json-rpc-error", errorName: "JSONRPCError", errorMessage, errorCode: entry.error.code },
      };
    }
    return { ok: true, result: entry.result, errorMessage: null, diagnostic: null };
  });

  return { ok: true, results, diagnostic };
}

// Splits `calls` into chunks of at most WORKER_MAX_BATCH_SIZE and sends
// each as its own batch, sequentially. If the Worker is unreachable for
// ANY chunk, the whole thing is treated as unreachable — a partial read
// here would be more confusing than useful for the honeypot check's
// "Worker or RPC unreachable" outcome.
//
// Two small resilience additions on top of the Worker's own upstream
// retries (see worker/index.js): a short CHUNK_DELAY_MS pause *between*
// sequential batches (never before the first one) so a multi-batch check
// doesn't hammer the shared upstream RPC back-to-back, and — if a batch
// still comes back rate-limited after the Worker's own retries — one
// extra retry of that same batch here before giving up. This is what
// keeps a normal scan (owner lookup, sell-simulation) from failing
// outright over what's usually a brief, temporary rate limit.
async function callWorkerChunked(calls, label) {
  const allResults = [];
  const diagnostics = [];
  for (let i = 0; i < calls.length; i += WORKER_MAX_BATCH_SIZE) {
    if (i > 0) {
      await sleep(CHUNK_DELAY_MS);
    }
    const chunk = calls.slice(i, i + WORKER_MAX_BATCH_SIZE);
    let outcome = await callWorkerBatch(chunk, label);
    if (!outcome.ok && outcome.diagnostic.kind === "upstream-rate-limited") {
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      outcome = await callWorkerBatch(chunk, label);
    }
    diagnostics.push(outcome.diagnostic);
    if (!outcome.ok) {
      return { ok: false, diagnostics };
    }
    allResults.push(...outcome.results);
  }
  return { ok: true, results: allResults, diagnostics };
}

// Reads a token's owner() through the Worker (the one thing Blockscout has
// no generic field for). Returns { owner, diagnostics } — owner is null if
// the call failed for any reason (unverified/no owner(), reverted, Worker
// down); diagnostics (only present when owner is null) is a list of raw
// diagnostics for the "Owner unknown" finding's Technical details panel,
// so "the Worker is down" and "this contract has no owner()" both keep
// their real underlying error instead of collapsing into a bare "Unknown".
async function fetchOwnerViaWorker(tokenAddress) {
  const outcome = await callWorkerChunked([{ to: tokenAddress, data: SELECTOR.owner }], `${WORKER_SOURCE} — eth_call owner()`);
  if (!outcome.ok) return { owner: null, diagnostics: outcome.diagnostics };
  const result = outcome.results[0];
  if (!result.ok) return { owner: null, diagnostics: [result.diagnostic] };
  return { owner: decodeAddressResult(result.result), diagnostics: null };
}

// --- Sell-simulation honeypot check ---------------------------------------
//
// DEX-agnostic and read-only: never assumes a specific DEX, never invents
// factory/router addresses. Detects liquidity pools among the top 5
// holders (capped down from 10 — see the module doc comment on
// CHUNK_DELAY_MS above for why: this whole check's burst of sequential
// eth_call requests is what trips the shared RPC's rate limit) purely by
// asking each contract holder for token0()/token1() and checking whether
// one of those matches the scanned token — any contract that answers
// that way is treated as a pool, whichever DEX it belongs to. Then
// simulates, via eth_call (never a real transaction), a transfer from up
// to 2 plain-wallet top holders (capped down from 3, same reason) to (a)
// a fixed probe address and (b) each detected pool, to see whether
// "selling" looks blocked.
async function runSellSimulation(tokenAddress, holders) {
  const top5 = Array.isArray(holders) ? holders.slice(0, 5) : [];
  const contractHolders = top5.filter((h) => h.isContract === true);

  if (contractHolders.length === 0) {
    return { status: "no-pool", pools: [], holderAttempts: [] };
  }

  const poolCalls = contractHolders.flatMap((h) => [
    { to: h.address, data: SELECTOR.token0 },
    { to: h.address, data: SELECTOR.token1 },
  ]);

  const poolOutcome = await callWorkerChunked(poolCalls, `${WORKER_SOURCE} — eth_call token0()/token1() (pool detection)`);
  if (!poolOutcome.ok) {
    return { status: "unreachable", pools: [], holderAttempts: [], diagnostics: poolOutcome.diagnostics };
  }

  const pools = [];
  const tokenLower = tokenAddress.toLowerCase();
  contractHolders.forEach((h, i) => {
    const token0Result = poolOutcome.results[i * 2];
    const token1Result = poolOutcome.results[i * 2 + 1];
    const token0 = token0Result.ok ? decodeAddressResult(token0Result.result) : null;
    const token1 = token1Result.ok ? decodeAddressResult(token1Result.result) : null;
    if (!token0 || !token1) return;
    if (token0.toLowerCase() === tokenLower || token1.toLowerCase() === tokenLower) {
      pools.push({ address: h.address, token0, token1 });
    }
  });

  if (pools.length === 0) {
    return { status: "no-pool", pools: [], holderAttempts: [] };
  }

  const candidateHolders = (Array.isArray(holders) ? holders : [])
    .filter((h) => h.isContract === false && !isBurnOrZeroAddress(h.address))
    .filter((h) => {
      try {
        return BigInt(h.valueRaw) > 0n;
      } catch {
        return false;
      }
    })
    .slice(0, 2);

  if (candidateHolders.length === 0) {
    return { status: "no-holder", pools, holderAttempts: [] };
  }

  const simulationCalls = [];
  const callTags = [];
  for (const holder of candidateHolders) {
    const balance = BigInt(holder.valueRaw);
    const onePercent = balance / 100n;
    const amount = onePercent > 0n ? onePercent : 1n;

    simulationCalls.push({
      to: tokenAddress,
      data: encodeTransferCallData(PROBE_RECIPIENT_ADDRESS, amount),
      from: holder.address,
    });
    callTags.push({ holder: holder.address, kind: "baseline" });

    for (const pool of pools) {
      simulationCalls.push({ to: tokenAddress, data: encodeTransferCallData(pool.address, amount), from: holder.address });
      callTags.push({ holder: holder.address, kind: "sell", pool: pool.address });
    }
  }

  // A gap before the transfer-simulation batches too — pool detection
  // (above) and this are two separate callWorkerChunked calls run back
  // to back, so without this the delay CHUNK_DELAY_MS adds *within* each
  // one wouldn't do anything to space out the seam between them.
  await sleep(CHUNK_DELAY_MS);

  const simOutcome = await callWorkerChunked(simulationCalls, `${WORKER_SOURCE} — eth_call transfer() simulation`);
  if (!simOutcome.ok) {
    return { status: "unreachable", pools, holderAttempts: [], diagnostics: simOutcome.diagnostics };
  }

  const holderAttempts = candidateHolders.map((holder) => {
    const baselineIdx = callTags.findIndex((t) => t.holder === holder.address && t.kind === "baseline");
    const baseline = decodeTransferOutcome(simOutcome.results[baselineIdx]);

    const sells = pools.map((pool) => {
      const idx = callTags.findIndex((t) => t.holder === holder.address && t.kind === "sell" && t.pool === pool.address);
      return { pool: pool.address, ...decodeTransferOutcome(simOutcome.results[idx]) };
    });

    return { holder: holder.address, baseline, sells };
  });

  return { status: "simulated", pools, holderAttempts };
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
    case "origin-rejected":
      return `${sourceLabel} rejected this request (HTTP 403): this page's origin isn't on its allow-list. This is a validation rejection, not a CORS/preflight failure — the request did reach the Worker.`;
    case "validation-rejected":
      return `${sourceLabel} rejected this request as malformed or too large (HTTP ${diagnostic.httpStatus}): ${diagnostic.errorMessage}. This is a validation rejection, not a CORS/preflight failure — the request did reach the Worker.`;
    case "upstream-unreachable":
      return `${sourceLabel} reached the upstream RPC and that call failed (HTTP 502): ${diagnostic.errorMessage}`;
    case "upstream-rate-limited":
      return `The RPC is busy right now — the Worker already retried a few times (HTTP 502). Please try again in a moment.`;
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
    case "json-rpc-error":
      return `${sourceLabel} returned a JSON-RPC error: ${diagnostic.errorMessage}`;
    case "invalid-response":
      return `${sourceLabel} returned a response that couldn't be understood.`;
    default:
      return `${sourceLabel} connection error: ${diagnostic.errorMessage || "unknown error"}`;
  }
}

// Renders a list of fetchRaw-style diagnostics as plain text: which call
// it was, the URL, the page's origin, the browser error name/message (if
// any), the HTTP status (if a response came back), the first 300 chars of
// the response body, and a `kind` classification — network/CORS, timeout,
// an HTTP-level rejection (further split into origin/validation/upstream
// for the Worker specifically — see classifyWorkerHttpKind above), or a
// JSON-RPC-level error. Shared by the network status panel, the scan
// Technical details panel, per-finding Technical details, and the "Test
// Worker connection" self-test, so every failure is described the same way.
function renderDiagnosticsText(attempts) {
  return attempts
    .map((diagnostic) => {
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
        `  Response body (first 300 chars): ${diagnostic.bodySnippet ? diagnostic.bodySnippet : "(none)"}`,
      );
      return parts.join("\n");
    })
    .join("\n\n");
}

function renderTechnicalDetails(targetEl, attempts) {
  targetEl.textContent = renderDiagnosticsText(attempts);
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
const workerTestButton = document.getElementById("worker-test-connection");
const workerTestResultEl = document.getElementById("worker-test-result");
const workerTestSummaryEl = document.getElementById("worker-test-summary");
const workerTestTechDetailsContentEl = document.getElementById("worker-test-tech-details-content");
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

  const workerResult = await probeWorker();
  attempts.push(workerResult.diagnostic);

  networkNameEl.textContent = CONFIG.chainName;

  if (blockscoutResult.ok) {
    networkChainIdEl.textContent = String(CONFIG.chainId);
    networkBlockNumberEl.textContent = String(blockscoutResult.totalBlocks);

    if (workerResult.ok && workerResult.chainId !== CONFIG.chainId) {
      networkSourceEl.textContent = `${BLOCKSCOUT_SOURCE} (${WORKER_SOURCE} secondary ignored — chain ID mismatch)`;
      networkConnectionStatusEl.textContent = `Connected (${WORKER_SOURCE} mismatch)`;
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `${WORKER_SOURCE} secondary returned chain ID ${workerResult.chainId}, expected ${CONFIG.chainId}. Using ${BLOCKSCOUT_SOURCE} only.`;
      networkErrorEl.hidden = false;
      showNetworkTechDetails(attempts);
      networkRetryButton.hidden = false;
      return;
    }

    networkSourceEl.textContent = workerResult.ok ? `${BLOCKSCOUT_SOURCE} + ${WORKER_SOURCE} (secondary, confirmed)` : BLOCKSCOUT_SOURCE;
    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";

    // The primary source is fine — only surface the secondary's own
    // trouble for transparency, not as a page-level error.
    if (!workerResult.ok) {
      showNetworkTechDetails(attempts);
    }
    return;
  }

  // Blockscout (primary) failed — fall back to the optional Worker
  // secondary so the page can still work.
  if (workerResult.ok) {
    networkChainIdEl.textContent = String(workerResult.chainId);
    networkBlockNumberEl.textContent = workerResult.blockNumber !== null ? String(workerResult.blockNumber) : "—";
    networkSourceEl.textContent = `${WORKER_SOURCE} (secondary — Blockscout API unavailable)`;

    if (workerResult.chainId !== CONFIG.chainId) {
      networkConnectionStatusEl.textContent = "Unexpected chain ID";
      networkConnectionStatusEl.className = "status-bad";
      networkErrorEl.textContent = `The ${WORKER_SOURCE} returned chain ID ${workerResult.chainId}, expected ${CONFIG.chainId}. Refusing to trust this endpoint.`;
      networkErrorEl.hidden = false;
      showNetworkTechDetails(attempts);
      networkRetryButton.hidden = false;
      return;
    }

    networkConnectionStatusEl.textContent = "Connected";
    networkConnectionStatusEl.className = "status-ok";
    networkErrorEl.textContent = `${BLOCKSCOUT_SOURCE} is currently unreachable; showing data from the ${WORKER_SOURCE} secondary source instead.`;
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

// --- Worker self-test ("Test Worker connection") --------------------------
//
// Independent of the network status probe above and of any token scan:
// sends two real POSTs to the Worker directly from the browser and shows
// the raw status/body of each, so a failure can be told apart between a
// CORS/preflight failure (the request never reaches the Worker at all —
// "network-or-cors"/"timeout") and a validation rejection (the request
// does reach the Worker, which rejects it on its own terms — see
// classifyWorkerHttpKind above). (a) a bare eth_chainId POST — the same
// shape the network status probe already sends successfully, if it's
// working. (b) an eth_call that includes a "from" field, targeting
// balanceOf() on the most recently scanned token (or, if none has been
// scanned yet, a harmless read against the fixed probe address itself —
// never a guessed/invented "real" contract address; eth_call against an
// address with no code simply returns empty data, which is a perfectly
// valid response for telling whether the request itself was accepted).
async function testWorkerConnection() {
  workerTestButton.disabled = true;
  workerTestResultEl.hidden = false;
  workerTestSummaryEl.textContent = "";
  const pending = document.createElement("p");
  pending.className = "status-pending";
  pending.textContent = "Testing…";
  workerTestSummaryEl.appendChild(pending);

  try {
    const chainIdRaw = await fetchRaw(
      WORKER_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      },
      "Self-test (a) — POST eth_chainId",
    );

    const balanceOfTarget = lastScannedTokenAddress || PROBE_RECIPIENT_ADDRESS;
    const ethCallRaw = await fetchRaw(
      WORKER_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: balanceOfTarget, data: SELECTOR.balanceOf + padAddressArg(PROBE_RECIPIENT_ADDRESS), from: PROBE_RECIPIENT_ADDRESS },
            "latest",
          ],
        }),
      },
      `Self-test (b) — POST eth_call with "from" (balanceOf on ${lastScannedTokenAddress ? "the scanned token" : "the probe address"})`,
    );

    renderWorkerTestResults([chainIdRaw, ethCallRaw]);
  } finally {
    workerTestButton.disabled = false;
  }
}

// Classifies a raw fetchRaw() result from a direct Worker POST into a full
// diagnostic (ok/kind/errorName/errorMessage), exactly like callWorkerBatch
// does for a batch — but for a single bare request, and kept even on a
// genuine success, so both the summary line and the Technical details
// panel below agree on what happened. This is what actually distinguishes
// "never reached the Worker" (CORS/preflight — fetch() itself threw) from
// "reached the Worker, which rejected it" (an HTTP-level validation
// rejection) from "reached the Worker and got a real per-call JSON-RPC
// error" (e.g. a revert).
function classifyWorkerTestRaw(raw) {
  if (!raw.ok) {
    return { ...raw.diagnostic, ok: false };
  }
  const { response, body, diagnostic } = raw;
  if (!response.ok) {
    const bodyError = body && (Array.isArray(body) ? body.find((entry) => entry?.error)?.error : body?.error);
    return {
      ...diagnostic,
      ok: false,
      errorName: "HTTPError",
      errorMessage:
        bodyError?.message || body?.detail || (typeof bodyError === "string" ? bodyError : null) || response.statusText || `HTTP ${response.status}`,
      kind: classifyWorkerHttpKind(response.status, body),
    };
  }
  const entry = Array.isArray(body) ? body[0] : body;
  if (entry?.error) {
    return {
      ...diagnostic,
      ok: false,
      errorName: "JSONRPCError",
      errorMessage: entry.error.message,
      errorCode: entry.error.code,
      kind: "json-rpc-error",
    };
  }
  return { ...diagnostic, ok: true };
}

function renderWorkerTestResults(raws) {
  workerTestSummaryEl.textContent = "";
  const classified = raws.map(classifyWorkerTestRaw);

  for (const diagnostic of classified) {
    const p = document.createElement("p");
    if (diagnostic.ok) {
      p.className = "status-ok";
      p.textContent = `${diagnostic.label}: reached the Worker and succeeded — HTTP ${diagnostic.httpStatus}.`;
    } else if (diagnostic.kind === "network-or-cors" || diagnostic.kind === "timeout") {
      p.className = "status-bad";
      p.textContent = `${diagnostic.label}: never reached the Worker — ${diagnostic.kind} (${diagnostic.errorName}: ${diagnostic.errorMessage}). This is the signature of a CORS/preflight failure.`;
    } else if (diagnostic.kind === "upstream-rate-limited") {
      p.className = "status-bad";
      p.textContent = `${diagnostic.label}: reached the Worker, which is being rate-limited by its own upstream RPC (HTTP 502, already retried): ${diagnostic.errorMessage}. Not a CORS/preflight failure — try again in a moment.`;
    } else {
      p.className = "status-bad";
      p.textContent = `${diagnostic.label}: reached the Worker, which rejected it — ${diagnostic.kind} (HTTP ${diagnostic.httpStatus ?? "—"}): ${diagnostic.errorMessage}. This is a validation rejection, not a CORS/preflight failure.`;
    }
    workerTestSummaryEl.appendChild(p);
  }

  renderTechnicalDetails(workerTestTechDetailsContentEl, classified);
}

workerTestButton.addEventListener("click", () => {
  testWorkerConnection();
});

// --- Section 2: Scan a token -------------------------------------------

const scanForm = document.getElementById("scan-form");
const tokenAddressInput = document.getElementById("token-address");
const addressErrorEl = document.getElementById("address-error");
const scanButton = document.getElementById("scan-button");
const rescanButton = document.getElementById("rescan-button");
const scanErrorEl = document.getElementById("scan-error");
const scanResultEl = document.getElementById("scan-result");
const scanResultTitleEl = document.getElementById("scan-result-title");
const scanTechDetailsEl = document.getElementById("scan-tech-details");
const scanTechDetailsContentEl = document.getElementById("scan-tech-details-content");

const riskLevelValueEl = document.getElementById("risk-level-value");
const riskSummarySentenceEl = document.getElementById("risk-summary-sentence");
const riskFindingsEl = document.getElementById("risk-findings");

const resultAddressEl = document.getElementById("result-address");
const resultIsContractEl = document.getElementById("result-is-contract");
const resultNameEl = document.getElementById("result-name");
const resultSymbolEl = document.getElementById("result-symbol");
const resultDecimalsEl = document.getElementById("result-decimals");
const resultTotalSupplyEl = document.getElementById("result-total-supply");
const resultHoldersEl = document.getElementById("result-holders");
const resultVerifiedEl = document.getElementById("result-verified");
const resultOwnerEl = document.getElementById("result-owner");
const resultPriceEl = document.getElementById("result-price");
const resultVolumeEl = document.getElementById("result-volume");
const resultMarketCapEl = document.getElementById("result-market-cap");
const resultSourceEl = document.getElementById("result-source");

const UNAVAILABLE = "Unavailable";

// Findings are grouped by outcome, not just severity: a check that
// genuinely passed ("info" severity, known data) reads very differently
// from a check whose data simply wasn't available ("Unknown") — grouping
// them together would make Unknown look like a clean bill of health,
// which it isn't.
const GROUP_ORDER = ["high", "medium", "low", "passed", "unknown"];
const GROUP_LABEL = { high: "High risk", medium: "Medium risk", low: "Low risk", passed: "Passed", unknown: "Info / unknown" };

// A one-line, plain-language summary of the overall level — purely
// presentational (like GROUP_LABEL above): it doesn't change what's
// computed, only how the already-computed overallLevel reads at a
// glance above the findings list.
const SUMMARY_SENTENCE = {
  Low: "No major red flags turned up in these automated checks.",
  Medium: "A few things here are worth a closer look before you trust this token.",
  High: "Multiple serious red flags — treat this token with real caution.",
  "Insufficient data": "Not enough public data was available to reach a verdict.",
};

function groupKeyFor(finding) {
  if (finding.known === false) return "unknown";
  return finding.severity === "info" ? "passed" : finding.severity;
}

function resetScanUI() {
  addressErrorEl.hidden = true;
  scanErrorEl.hidden = true;
  scanResultEl.hidden = true;
  scanTechDetailsEl.hidden = true;
  riskFindingsEl.innerHTML = "";
  scanResultTitleEl.textContent = "Token";
}

function isBenignNotFound(result) {
  return Boolean(result) && !result.ok && result.status === 404;
}

// A link to this address on the block explorer, built with
// createElement/textContent only (never innerHTML — address strings come
// from Blockscout/Worker data).
function buildBlockscoutAddressLink(address) {
  const a = document.createElement("a");
  a.href = `${CONFIG.explorerUrl}/address/${address}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = address;
  return a;
}

// A "Technical details" collapsible for a finding whose underlying Worker
// call(s) failed to reach a real result — the owner-status and
// sell-simulation findings, when known: false because the Worker/RPC
// couldn't be reached or a specific call errored. Reuses the same
// diagnostic text as the network status and scan Technical details panels
// (see renderDiagnosticsText) so every failure looks the same wherever
// it's shown. Returns null if there's nothing to show.
function buildFindingTechnicalDetails(diagnostics) {
  const list = (diagnostics || []).filter(Boolean);
  if (list.length === 0) return null;

  const details = document.createElement("details");
  details.className = "risk-finding-evidence";

  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  details.appendChild(summary);

  const pre = document.createElement("pre");
  pre.textContent = renderDiagnosticsText(list.map((d) => ({ ...d, ok: false })));
  details.appendChild(pre);

  return details;
}

// The sell-simulation finding's "How this was checked" collapsible: which
// pools were detected, which holder(s) were used, and which calls
// succeeded or failed — each address linked to the block explorer.
function buildSellSimulationEvidence(simulation) {
  const details = document.createElement("details");
  details.className = "risk-finding-evidence";

  const summary = document.createElement("summary");
  summary.textContent = "How this was checked";
  details.appendChild(summary);

  const poolsPara = document.createElement("p");
  poolsPara.append("Pools detected: ");
  if (simulation.pools.length === 0) {
    poolsPara.append("none");
  } else {
    simulation.pools.forEach((pool, i) => {
      if (i > 0) poolsPara.append(", ");
      poolsPara.appendChild(buildBlockscoutAddressLink(pool.address));
    });
  }
  details.appendChild(poolsPara);

  if (simulation.holderAttempts.length === 0) {
    const note = document.createElement("p");
    note.textContent = "No transfer simulation was run.";
    details.appendChild(note);
    return details;
  }

  for (const attempt of simulation.holderAttempts) {
    const holderDiv = document.createElement("div");
    holderDiv.className = "evidence-holder";

    const holderPara = document.createElement("p");
    holderPara.append("Holder tested: ");
    holderPara.appendChild(buildBlockscoutAddressLink(attempt.holder));
    holderDiv.appendChild(holderPara);

    const list = document.createElement("ul");

    const baselineLi = document.createElement("li");
    baselineLi.textContent = `Baseline transfer to probe address — ${attempt.baseline.success ? "succeeded" : "failed"}: ${attempt.baseline.reason}`;
    list.appendChild(baselineLi);

    for (const sell of attempt.sells) {
      const li = document.createElement("li");
      li.append("Sell-like transfer to pool ");
      li.appendChild(buildBlockscoutAddressLink(sell.pool));
      li.append(` — ${sell.success ? "succeeded" : "failed"}: ${sell.reason}`);
      list.appendChild(li);
    }

    holderDiv.appendChild(list);
    details.appendChild(holderDiv);
  }

  return details;
}

// Renders the Risk Score v1 summary: an overall-level badge, the fixed
// disclaimer, then findings grouped by outcome (High/Medium/Low risk,
// then Passed, then Info / unknown — see groupKeyFor). Built with
// createElement/textContent only — nothing here is ever inserted as HTML,
// since finding text can echo Blockscout/RPC/Worker data. `sellSimulation`
// (optional) is the raw honeypot-check result, used only to build the
// "How this was checked" panel under that one finding.
function renderRiskSummary(overallLevel, findings, sellSimulation) {
  riskLevelValueEl.textContent = overallLevel;
  riskLevelValueEl.className = `risk-level-value risk-level-${overallLevel.toLowerCase().replace(/\s+/g, "-")}`;
  riskSummarySentenceEl.textContent = SUMMARY_SENTENCE[overallLevel] ?? "";

  riskFindingsEl.innerHTML = "";
  for (const groupKey of GROUP_ORDER) {
    const group = findings.filter((f) => groupKeyFor(f) === groupKey);
    if (group.length === 0) continue;

    const section = document.createElement("div");
    section.className = "risk-findings-group";

    const heading = document.createElement("h4");
    heading.textContent = `${GROUP_LABEL[groupKey]} (${group.length})`;
    section.appendChild(heading);

    for (const f of group) {
      const item = document.createElement("div");
      item.className = `risk-finding risk-finding-${groupKey}`;

      const title = document.createElement("p");
      title.className = "risk-finding-title";
      title.textContent = f.title;

      const detail = document.createElement("p");
      detail.className = "risk-finding-detail";
      detail.textContent = f.detail;

      item.append(title, detail);

      if (f.id === "sell-simulation" && sellSimulation && (sellSimulation.pools?.length || sellSimulation.holderAttempts?.length)) {
        item.appendChild(buildSellSimulationEvidence(sellSimulation));
      }

      if ((f.id === "owner-status" || f.id === "sell-simulation") && f.diagnostics?.length) {
        const techPanel = buildFindingTechnicalDetails(f.diagnostics);
        if (techPanel) item.appendChild(techPanel);
      }

      section.appendChild(item);
    }
    riskFindingsEl.appendChild(section);
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
  // Remembered so "Test Worker connection" (in the Network status card)
  // can run its eth_call self-test against a real, already-scanned
  // contract instead of guessing at one — see testWorkerConnection below.
  lastScannedTokenAddress = address;

  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  rescanButton.disabled = true;

  try {
    // fetchOwnerViaWorker is deliberately NOT in this Promise.all — see
    // the owner()/sell-simulation sequencing note below, right before
    // it's actually called.
    const [addressResult, tokenResult, contractResult, holdersResult] = await Promise.all([
      fetchBlockscout(`/addresses/${address}`, `${BLOCKSCOUT_SOURCE} — GET /addresses/{address}`),
      fetchBlockscout(`/tokens/${address}`, `${BLOCKSCOUT_SOURCE} — GET /tokens/{address}`),
      fetchBlockscout(`/smart-contracts/${address}`, `${BLOCKSCOUT_SOURCE} — GET /smart-contracts/{address}`),
      fetchBlockscout(`/tokens/${address}/holders`, `${BLOCKSCOUT_SOURCE} — GET /tokens/{address}/holders`),
    ]);

    // The creation transaction's timestamp (for token age) needs the
    // creation tx hash from /addresses first, so it's a follow-up call.
    const creationTxHash = addressResult.ok
      ? (addressResult.body.creation_transaction_hash ?? addressResult.body.creation_tx_hash ?? null)
      : null;
    const txResult = creationTxHash
      ? await fetchBlockscout(`/transactions/${creationTxHash}`, `${BLOCKSCOUT_SOURCE} — GET /transactions/{hash}`)
      : null;

    // Blockscout's proxy admin field name is unconfirmed from this
    // environment (see README) — this is a best-effort guess with a
    // graceful no-op fallback: if the field isn't there (likely), the
    // proxy-upgrade check simply falls back to its verified/unverified
    // rule without ever fabricating an admin-type escalation.
    const proxyAdmin = contractResult.ok ? (contractResult.body.proxy_admin ?? contractResult.body.admin ?? null) : null;
    const proxyAdminResult = proxyAdmin
      ? await fetchBlockscout(`/addresses/${proxyAdmin}`, `${BLOCKSCOUT_SOURCE} — GET /addresses/{proxy_admin}`)
      : null;
    const proxyAdminIsContract =
      proxyAdminResult?.ok && typeof proxyAdminResult.body.is_contract === "boolean"
        ? proxyAdminResult.body.is_contract
        : undefined;

    const allResults = [
      addressResult,
      tokenResult,
      contractResult,
      holdersResult,
      ...(txResult ? [txResult] : []),
      ...(proxyAdminResult ? [proxyAdminResult] : []),
    ];

    // 404 on everything but /addresses is an expected, valid answer ("not
    // a token" / "not verified" / "no holder data"), not a failure.
    const realFailures = allResults.filter((result) => {
      if (result.ok) return false;
      if (result === addressResult) return true;
      return !isBenignNotFound(result);
    });

    const isContract = addressResult.ok ? Boolean(addressResult.body.is_contract) : null;

    function showTechDetailsIfNeeded() {
      if (realFailures.length > 0) {
        renderTechnicalDetails(scanTechDetailsContentEl, allResults.map((r) => ({ ...r.diagnostic, ok: r.ok })));
        scanTechDetailsEl.hidden = false;
      }
    }

    if (isContract === false) {
      scanErrorEl.textContent =
        "This is a wallet address, not a token contract — it has no contract code on-chain, so there's nothing to scan. Double-check you copied the token's contract address rather than a wallet address.";
      scanErrorEl.hidden = false;
      showTechDetailsIfNeeded();
      return;
    }

    const isVerified = addressResult.ok && typeof addressResult.body.is_verified === "boolean"
      ? addressResult.body.is_verified
      : contractResult.ok
        ? true
        : isBenignNotFound(contractResult)
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
    const holdersCount = tokenBody?.holders_count ?? tokenBody?.holders ?? null;

    const holders = holdersResult.ok && Array.isArray(holdersResult.body.items)
      ? holdersResult.body.items
          .map((item) => ({
            address: item.address?.hash ?? item.address,
            valueRaw: item.value,
            isContract: typeof item.address?.is_contract === "boolean" ? item.address.is_contract : undefined,
          }))
          .filter((h) => typeof h.address === "string" && typeof h.valueRaw === "string")
      : null;

    const abi = contractResult.ok && Array.isArray(contractResult.body.abi) ? contractResult.body.abi : null;
    // Three-way like isVerified above: trust an explicit true/false from
    // whichever endpoint actually answered, and only fall back to
    // "unknown" (null) when neither did.
    const isProxy = contractResult.ok
      ? Boolean(contractResult.body.proxy_type)
      : addressResult.ok
        ? Boolean(addressResult.body.proxy_type)
        : null;

    const createdAtIso = txResult?.ok ? (txResult.body.timestamp ?? null) : null;

    const priceUsd = tokenBody?.exchange_rate ?? null;
    const volume24hUsd = tokenBody?.volume_24h ?? null;
    const marketCapUsd = tokenBody?.circulating_market_cap ?? null;

    // The owner() read and the sell-simulation honeypot check (pool
    // detection, then transfer simulations) are the only two things that
    // hit the Worker's eth_call route during a scan. They're run here,
    // sequentially with a gap between them (never in parallel with each
    // other), specifically to avoid bursting the shared upstream RPC's
    // tight rate limit — see the CHUNK_DELAY_MS doc comment near the top
    // of this file. Each is also individually retried once as a whole
    // (not just per-batch — see withWholeCheckRateLimitRetry) if it comes
    // back rate-limited even after the Worker's and callWorkerChunked's
    // own retries. If it's still rate-limited after that, the honest
    // "Unknown" outcome (with its real diagnostics) is what gets shown —
    // never hidden or silently swallowed.
    const ownerOutcome = await withWholeCheckRateLimitRetry(
      () => fetchOwnerViaWorker(address),
      (r) => r.owner === null && hasRateLimitedDiagnostic(r.diagnostics),
    );
    const { owner, diagnostics: ownerDiagnostics } = ownerOutcome;

    await sleep(CHUNK_DELAY_MS);

    const sellSimulation = await withWholeCheckRateLimitRetry(
      () => runSellSimulation(address, holders),
      (r) => r.status === "unreachable" && hasRateLimitedDiagnostic(r.diagnostics),
    );

    const { overallLevel, findings } = scoreToken({
      isVerified,
      abi,
      isProxy,
      proxyAdmin,
      proxyAdminIsContract,
      holders,
      totalSupplyRaw,
      holdersCount,
      createdAtIso,
      owner,
      ownerDiagnostics,
      sellSimulation,
      marketData: { priceUsd, volume24hUsd, marketCapUsd },
    });
    renderRiskSummary(overallLevel, findings, sellSimulation);

    scanResultTitleEl.textContent = name && symbol ? `${name} (${symbol})` : name || (symbol ? `(${symbol})` : "Token");

    resultAddressEl.textContent = address;
    resultIsContractEl.textContent = isContract === null ? UNAVAILABLE : isContract ? "Yes" : "No";
    resultNameEl.textContent = name ?? UNAVAILABLE;
    resultSymbolEl.textContent = symbol ?? UNAVAILABLE;
    resultDecimalsEl.textContent = decimals === null ? UNAVAILABLE : String(decimals);

    if (totalSupplyRaw === null) {
      resultTotalSupplyEl.textContent = isBenignNotFound(tokenResult) ? "Unavailable (not a recognized token)" : UNAVAILABLE;
    } else if (decimals === null) {
      resultTotalSupplyEl.textContent = `${addThousandsSeparators(totalSupplyRaw)} (raw units — decimals unavailable)`;
    } else {
      try {
        resultTotalSupplyEl.textContent = addThousandsSeparators(formatUnits(BigInt(totalSupplyRaw), decimals));
      } catch {
        resultTotalSupplyEl.textContent = `${addThousandsSeparators(totalSupplyRaw)} (raw units)`;
      }
    }

    resultHoldersEl.textContent = holdersCount === null ? UNAVAILABLE : formatCount(holdersCount);
    resultVerifiedEl.textContent = isVerified === null ? UNAVAILABLE : isVerified ? "Yes" : "No";
    resultOwnerEl.textContent = owner ? `${owner} (via ${WORKER_SOURCE})` : UNAVAILABLE;

    // Full-precision values here (vs. the compact $867.6M-style figures in
    // the risk finding above) — see MARKET_DATA_ASSUMED_CURRENCY for why
    // "$" is shown.
    const currencyPrefix = MARKET_DATA_ASSUMED_CURRENCY === "USD" ? "$" : "";
    resultPriceEl.textContent = priceUsd != null ? `${currencyPrefix}${formatPriceUsd(priceUsd)}` : UNAVAILABLE;
    resultVolumeEl.textContent =
      volume24hUsd != null ? `${currencyPrefix}${addThousandsSeparators(formatPriceUsd(volume24hUsd))}` : UNAVAILABLE;
    resultMarketCapEl.textContent =
      marketCapUsd != null ? `${currencyPrefix}${addThousandsSeparators(formatPriceUsd(marketCapUsd))}` : UNAVAILABLE;

    resultSourceEl.textContent = owner ? `${BLOCKSCOUT_SOURCE} + ${WORKER_SOURCE} (secondary, owner)` : BLOCKSCOUT_SOURCE;

    scanResultEl.hidden = false;

    showTechDetailsIfNeeded();
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = "Scan";
    rescanButton.disabled = false;
  }
}

scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  scanToken(tokenAddressInput.value);
});

// Re-runs the scan for the address already shown on the result card —
// no retyping needed. Only visible/clickable once a scan has actually
// rendered a result (rescan-button lives inside #scan-result, which
// resetScanUI hides at the start of every scan, including this one).
rescanButton.addEventListener("click", () => {
  if (lastScannedTokenAddress) {
    scanToken(lastScannedTokenAddress);
  }
});

// --- Init ---------------------------------------------------------------

checkNetworkStatus();
