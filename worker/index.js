// Conge RPC proxy — a thin, read-only JSON-RPC proxy for
// https://rpc.mainnet.chain.robinhood.com, deployed as a single-file
// Cloudflare Worker with no dependencies.
//
// Purpose: rpc.mainnet.chain.robinhood.com has been reported unreachable
// from some browsers (a TLS certificate problem, indistinguishable from a
// CORS failure once it reaches JS — see the main README's "Troubleshooting
// network connectivity" section). This Worker sits in front of it so the
// browser talks to a Cloudflare-fronted origin instead, restricted to:
//   - a fixed allow-list of read-only JSON-RPC methods,
//   - a fixed allow-list of request origins (this site only, no wildcard),
//   - "latest" block reads only (no historical state, no writes — writes
//     aren't possible via eth_call/eth_getCode/eth_chainId/eth_blockNumber
//     anyway, but this keeps the intent explicit).
// It holds no secrets, no state (no KV/D1), and never logs request bodies.
//
// Pure functions (no network, no Workers-runtime globals) are exported by
// name so tests/worker.test.js can exercise the validation/CORS logic
// under plain Node with `node --test` — see that file for how to run it.
// The default export is the Workers entry point.

// --- Configuration -----------------------------------------------------

const UPSTREAM_RPC = "https://rpc.mainnet.chain.robinhood.com";

// No wildcard — only this site may call the RPC-proxy endpoints. (Does
// NOT apply to GET /health — see handleHealth below for why.)
export const ALLOWED_ORIGINS = ["https://agrarisai.github.io"];

// Read-only methods only. Nothing here can move funds, change state, or
// sign anything.
export const ALLOWED_METHODS = ["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode"];

const MAX_BATCH_SIZE = 10;
const MAX_BODY_BYTES = 20 * 1024; // 20 KB
export const UPSTREAM_TIMEOUT_MS = 8000;

// The shared upstream RPC rate-limits (429) or is briefly overloaded (503)
// under load — retrying with backoff, all within the existing 8s overall
// timeout, absorbs a transient hit instead of failing the whole request
// outright. Up to 5 total attempts, backoff 400ms/800ms/1600ms/3200ms
// (one delay between each pair of attempts) — the full backoff sequence
// alone sums to 6s, so callUpstream also tracks a deadline (via
// decideUpstreamRetry below) and skips a retry — rather than starting a
// delay it can't finish — once there isn't enough of the 8s budget left,
// capping attempts to whatever actually fits and saying so in the 502
// body.
export const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 503]);
export const MAX_UPSTREAM_ATTEMPTS = 5;
export const RETRY_DELAYS_MS = [400, 800, 1600, 3200]; // delay before attempts 2, 3, 4, 5 respectively

// Pure decision for whether callUpstream should retry after getting
// `status` back on `attempt` (1-based), given `elapsedMs` already spent
// since the request started. No network, no timers — fully
// unit-testable, unlike callUpstream itself (which does the actual
// waiting/fetching). Returns { retry: true, delayMs } or
// { retry: false, reason: "not-retryable" | "exhausted-attempts" |
// "time-budget" } — `reason` is only meaningful when `retry` is false and
// `status` was itself retryable; callers use it to word the final 502
// correctly (out of attempts vs. stopped early to respect the timeout).
export function decideUpstreamRetry(status, attempt, elapsedMs) {
  if (!RETRYABLE_UPSTREAM_STATUSES.has(status)) {
    return { retry: false, reason: "not-retryable" };
  }
  if (attempt >= MAX_UPSTREAM_ATTEMPTS) {
    return { retry: false, reason: "exhausted-attempts" };
  }
  const nextDelay = RETRY_DELAYS_MS[attempt - 1];
  if (elapsedMs + nextDelay >= UPSTREAM_TIMEOUT_MS) {
    return { retry: false, reason: "time-budget" };
  }
  return { retry: true, delayMs: nextDelay };
}

// Resolves after `ms`, or rejects with the same AbortError shape `fetch`
// itself would produce if `signal` aborts first — so a backoff delay never
// lets the overall UPSTREAM_TIMEOUT_MS budget run over.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

const BLOCK_TAG_LATEST = "latest";
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

// --- CORS ----------------------------------------------------------------

export function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

// Returns the CORS headers to send back for a request from `origin`, or
// null if that origin isn't allowed (caller should then respond 403).
export function buildCorsHeaders(origin) {
  if (!isAllowedOrigin(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// --- JSON-RPC request validation (pure) -----------------------------------

export function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Validates the method-specific params for an already-method-allow-listed
// request. Block tags are restricted to "latest" — this proxy only ever
// reads current state. eth_call's optional third parameter (state
// overrides) is intentionally NOT validated here; it's passed through to
// the upstream untouched, exactly as asked.
export function validateParams(method, params) {
  switch (method) {
    case "eth_chainId":
    case "eth_blockNumber":
      if (params.length !== 0) {
        return { ok: false, message: `${method} takes no params` };
      }
      return { ok: true };

    case "eth_getCode": {
      if (params.length !== 2) {
        return { ok: false, message: "eth_getCode requires exactly [address, blockTag]" };
      }
      const [address, blockTag] = params;
      if (typeof address !== "string" || !HEX_ADDRESS.test(address)) {
        return { ok: false, message: "eth_getCode: address must be a 0x-prefixed 20-byte hex address" };
      }
      if (blockTag !== BLOCK_TAG_LATEST) {
        return { ok: false, message: 'eth_getCode: block tag must be "latest"' };
      }
      return { ok: true };
    }

    case "eth_call": {
      if (params.length < 2 || params.length > 3) {
        return {
          ok: false,
          message: "eth_call requires [callObject, blockTag], optionally followed by a third state-override param",
        };
      }
      const [callObject, blockTag] = params;
      if (typeof callObject !== "object" || callObject === null || Array.isArray(callObject)) {
        return { ok: false, message: "eth_call: first param must be a call object" };
      }
      if (typeof callObject.to !== "string" || !HEX_ADDRESS.test(callObject.to)) {
        return { ok: false, message: 'eth_call: call object "to" must be a 0x-prefixed 20-byte hex address' };
      }
      if (callObject.from !== undefined && (typeof callObject.from !== "string" || !HEX_ADDRESS.test(callObject.from))) {
        return { ok: false, message: 'eth_call: call object "from" must be a 0x-prefixed 20-byte hex address' };
      }
      const data = callObject.data ?? callObject.input;
      if (data !== undefined && (typeof data !== "string" || !HEX_DATA.test(data))) {
        return { ok: false, message: 'eth_call: call object "data"/"input" must be 0x-prefixed hex (even length)' };
      }
      if (blockTag !== BLOCK_TAG_LATEST) {
        return { ok: false, message: 'eth_call: block tag must be "latest"' };
      }
      // params[2], if present, is the state-override object — passed
      // through untouched, not validated here (see module doc comment).
      return { ok: true };
    }

    default:
      return { ok: false, message: `Unsupported method: ${method}` };
  }
}

// Validates one JSON-RPC request object's shape, method, and params.
// Returns { ok: true, request: <normalized request> } or
// { ok: false, error: <JSON-RPC error envelope> } — never touches the
// network, so it's fully unit-testable.
export function validateRequest(item) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { ok: false, error: jsonRpcError(null, -32600, "Invalid Request: expected a JSON object") };
  }

  const { jsonrpc, method, params, id } = item;
  const requestId = id === undefined ? null : id;

  if (jsonrpc !== "2.0") {
    return { ok: false, error: jsonRpcError(requestId, -32600, 'Invalid Request: "jsonrpc" must be "2.0"') };
  }
  if (typeof method !== "string") {
    return { ok: false, error: jsonRpcError(requestId, -32600, 'Invalid Request: "method" must be a string') };
  }
  if (!ALLOWED_METHODS.includes(method)) {
    return { ok: false, error: jsonRpcError(requestId, -32601, `Method not found: ${method}`) };
  }

  const normalizedParams = params === undefined ? [] : params;
  if (!Array.isArray(normalizedParams)) {
    return { ok: false, error: jsonRpcError(requestId, -32602, 'Invalid params: "params" must be an array') };
  }

  const paramsCheck = validateParams(method, normalizedParams);
  if (!paramsCheck.ok) {
    return { ok: false, error: jsonRpcError(requestId, -32602, `Invalid params: ${paramsCheck.message}`) };
  }

  return { ok: true, request: { jsonrpc: "2.0", id: requestId, method, params: normalizedParams } };
}

// Splits a parsed POST body into a JSON-RPC batch array + whether the
// caller sent a batch (array) or a single object — or an error if the
// body isn't a valid (possibly-batched) JSON-RPC request at all.
export function parseBatch(parsedBody) {
  const isBatch = Array.isArray(parsedBody);
  const items = isBatch ? parsedBody : [parsedBody];

  if (items.length === 0) {
    return { ok: false, error: jsonRpcError(null, -32600, "Invalid Request: empty batch") };
  }
  if (items.length > MAX_BATCH_SIZE) {
    return { ok: false, error: jsonRpcError(null, -32600, `Invalid Request: batch too large (max ${MAX_BATCH_SIZE})`) };
  }

  return { ok: true, isBatch, items };
}

// --- JSON response helper -------------------------------------------------

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

// --- Upstream call (network — not covered by unit tests) -----------------

// On a 429/503 from the upstream RPC, retries up to MAX_UPSTREAM_ATTEMPTS
// times with the RETRY_DELAYS_MS backoff before giving up — see the
// constants above. Every other outcome (success, a different HTTP error,
// a network failure, or the overall timeout firing) returns immediately,
// exactly as before. A rate-limited failure that survives every retry —
// or that stops early because the 8s budget wouldn't cover another delay
// — is reported with `kind: "upstream-rate-limited"` so callers (and
// ultimately the UI) can show a specific "busy, try again" message
// instead of a generic one; the detail text says explicitly which case
// it was.
async function callUpstream(rpcRequests) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const startedAt = Date.now();
  const outgoingBody = rpcRequests.length === 1 ? rpcRequests[0] : rpcRequests;

  try {
    for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await fetch(UPSTREAM_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(outgoingBody),
          signal: controller.signal,
        });
      } catch (error) {
        const detail =
          error.name === "AbortError"
            ? `Upstream did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`
            : `Upstream request failed: ${error.message}`;
        return { ok: false, detail };
      }

      const decision = decideUpstreamRetry(response.status, attempt, Date.now() - startedAt);

      if (decision.retry) {
        try {
          await delay(decision.delayMs, controller.signal);
        } catch (error) {
          return { ok: false, detail: `Upstream did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s` };
        }
        continue;
      }

      if (RETRYABLE_UPSTREAM_STATUSES.has(response.status)) {
        // Give up either because every attempt is used up, or because
        // there isn't enough of the 8s budget left for another delay —
        // the detail text says which.
        const detail =
          decision.reason === "time-budget"
            ? `Upstream is rate limited (HTTP ${response.status}) — stopped after ${attempt} of ${MAX_UPSTREAM_ATTEMPTS} attempts to stay within the ${UPSTREAM_TIMEOUT_MS / 1000}s timeout`
            : `Upstream is rate limited (HTTP ${response.status}) after ${attempt} attempts`;
        return { ok: false, detail, kind: "upstream-rate-limited" };
      }

      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, detail: `Upstream returned a non-JSON response (HTTP ${response.status})` };
      }

      if (!response.ok) {
        return { ok: false, detail: `Upstream returned HTTP ${response.status}` };
      }

      return { ok: true, body };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Route handlers --------------------------------------------------------

function handlePreflight(origin) {
  const cors = buildCorsHeaders(origin);
  if (!cors) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: cors });
}

async function handleRpc(request, origin) {
  const cors = buildCorsHeaders(origin);
  if (!cors) {
    return jsonResponse({ error: "Origin not allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(jsonRpcError(null, -32600, `Request body too large (max ${MAX_BODY_BYTES} bytes)`), 413, cors);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return jsonResponse(jsonRpcError(null, -32600, `Request body too large (max ${MAX_BODY_BYTES} bytes)`), 413, cors);
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, "Parse error: invalid JSON"), 400, cors);
  }

  const batch = parseBatch(parsedBody);
  if (!batch.ok) {
    return jsonResponse(batch.error, 400, cors);
  }

  const validated = batch.items.map((item) => ({ item, result: validateRequest(item) }));
  const toForward = validated.filter((v) => v.result.ok).map((v) => v.result.request);

  const resultById = new Map();
  if (toForward.length > 0) {
    const upstream = await callUpstream(toForward);
    if (!upstream.ok) {
      // A single failed upstream call fails the whole HTTP response, even
      // inside a batch — the upstream is unreachable/erroring, not any one
      // request in particular. `kind` is only present for a rate-limited
      // failure that survived every retry (see callUpstream) — callers use
      // it to show a specific "busy, try again" message instead of a
      // generic connectivity error.
      const body = { error: "Upstream RPC request failed", detail: upstream.detail };
      if (upstream.kind) body.kind = upstream.kind;
      return jsonResponse(body, 502, cors);
    }
    const upstreamResults = Array.isArray(upstream.body) ? upstream.body : [upstream.body];
    for (const r of upstreamResults) {
      if (r && typeof r === "object") resultById.set(JSON.stringify(r.id ?? null), r);
    }
  }

  const finalResults = validated.map(({ result }) => {
    if (!result.ok) return result.error;
    const key = JSON.stringify(result.request.id);
    return resultById.get(key) ?? jsonRpcError(result.request.id, -32603, "Upstream did not return a result for this request");
  });

  return jsonResponse(batch.isBatch ? finalResults : finalResults[0], 200, cors);
}

// GET /health is deliberately NOT origin-restricted: it's meant to be
// opened directly in a browser tab (a top-level navigation, which isn't
// subject to CORS in the first place) as a one-tap diagnostic. It returns
// no secrets — just whether the upstream RPC is reachable right now.
async function handleHealth() {
  const outcome = await callUpstream([
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
  ]);

  const headers = { "Access-Control-Allow-Origin": "*" };

  if (!outcome.ok) {
    return jsonResponse({ ok: false, upstream: { reachable: false }, error: outcome.detail }, 200, headers);
  }

  const results = Array.isArray(outcome.body) ? outcome.body : [outcome.body];
  const chainIdResult = results.find((r) => r && r.id === 1);
  const blockNumberResult = results.find((r) => r && r.id === 2);
  const rpcError = chainIdResult?.error || blockNumberResult?.error;

  if (rpcError) {
    return jsonResponse(
      { ok: false, upstream: { reachable: true, chainId: null, blockNumber: null }, error: rpcError.message },
      200,
      headers,
    );
  }

  const chainId = typeof chainIdResult?.result === "string" ? parseInt(chainIdResult.result, 16) : null;
  const blockNumber = typeof blockNumberResult?.result === "string" ? parseInt(blockNumberResult.result, 16) : null;

  return jsonResponse({ ok: true, upstream: { reachable: true, chainId, blockNumber } }, 200, headers);
}

// --- Entry point -----------------------------------------------------------

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handlePreflight(origin);
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, { "Access-Control-Allow-Origin": "*" });
      }
      return handleHealth();
    }

    if (url.pathname === "/") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed, use POST" }, 405, buildCorsHeaders(origin) || undefined);
      }
      return handleRpc(request, origin);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
