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
// It holds no secrets and no database (no KV/D1), and never logs request
// bodies. The only thing it keeps is a short-lived edge cache of public
// chain data — successful read results keyed by a hash of the call — see
// "Per-call response cache" below.
//
// Pure functions (no network, no Workers-runtime globals) are exported by
// name so tests/worker.test.js can exercise the validation/CORS logic
// under plain Node with `node --test` — see that file for how to run it.
// The default export is the Workers entry point.

// --- Configuration -----------------------------------------------------

const UPSTREAM_RPC = "https://rpc.mainnet.chain.robinhood.com";

// No wildcard — only this site may call the RPC-proxy endpoints. (Does
// NOT apply to GET /health — see handleHealth below for why.) Exact
// origins only: the site's custom domain, with and without www. (The
// original https://agrarisai.github.io origin was removed once the move to
// conge.site was complete; that address now just redirects to conge.site.)
export const ALLOWED_ORIGINS = ["https://conge.site", "https://www.conge.site"];

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

// Each backoff delay is randomized by up to ±25% so that several visitors
// rate-limited at the same moment don't all retry in lockstep and hit the
// upstream together again. The 8s deadline check below uses the jittered
// delay, so the overall budget is unchanged.
export const RETRY_JITTER = 0.25;

// `random` returns a number in [0, 1); 0.5 means no jitter. Injectable so
// tests can pin it.
export function jitteredDelay(baseMs, random = Math.random) {
  const factor = 1 + (random() * 2 - 1) * RETRY_JITTER;
  return Math.round(baseMs * factor);
}

// Pure decision for whether callUpstream should retry after getting
// `status` back on `attempt` (1-based), given `elapsedMs` already spent
// since the request started. No network, no timers — fully
// unit-testable, unlike callUpstream itself (which does the actual
// waiting/fetching). Returns { retry: true, delayMs } or
// { retry: false, reason: "not-retryable" | "exhausted-attempts" |
// "time-budget" } — `reason` is only meaningful when `retry` is false and
// `status` was itself retryable; callers use it to word the final 502
// correctly (out of attempts vs. stopped early to respect the timeout).
export function decideUpstreamRetry(status, attempt, elapsedMs, random = Math.random) {
  if (!RETRYABLE_UPSTREAM_STATUSES.has(status)) {
    return { retry: false, reason: "not-retryable" };
  }
  if (attempt >= MAX_UPSTREAM_ATTEMPTS) {
    return { retry: false, reason: "exhausted-attempts" };
  }
  const nextDelay = jitteredDelay(RETRY_DELAYS_MS[attempt - 1], random);
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
    "Access-Control-Expose-Headers": "X-Conge-Cache",
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

// --- Per-call response cache ------------------------------------------------
//
// Identical read-only calls (the same token scanned twice, or the same
// call made by two visitors) are answered from Cloudflare's edge cache
// instead of the shared, rate-limited upstream. Each call in a batch is
// cached on its own, so a batch that's half cached only sends the other
// half upstream.
//
// What's stored: only the JSON-RPC `result` of a successful call — never
// an error, never a 429/5xx — under a key that is a SHA-256 hash of the
// method and its call data (contract address, optional `from`, calldata,
// optional state override). That's all public chain data; nothing about
// the visitor (no IP, no origin, no headers) is part of the key or the
// entry. Entries expire on their own (see CACHE_STORE_SECONDS).
//
// The Cache API only works on a custom domain (rpc.conge.site); on the
// workers.dev address it silently stores nothing, and every call simply
// goes upstream as before. Each Cloudflare data center has its own cache.

export const CACHE_TTL_MS = {
  eth_call: 60_000, // contract state can change any block, so keep it short
  eth_getCode: 10 * 60_000, // code almost never changes
  eth_chainId: 60 * 60_000, // never changes
  // eth_blockNumber: not cached — it's the one value that should be live.
};

// Stale-if-error: when the upstream still fails after every retry, a
// cached result up to this old is returned instead of an error, marked
// with the response header X-Conge-Cache: stale. Trade-off: a visitor may
// see data up to 10 minutes old during an upstream outage, instead of
// "Unknown" for that check. Stale data is never served without the header.
export const STALE_IF_ERROR_MAX_AGE_MS = 10 * 60_000;

// How long an entry is kept: long enough to serve as a stale fallback,
// and at least its own TTL.
function cacheStoreSeconds(method) {
  return Math.ceil(Math.max(CACHE_TTL_MS[method], STALE_IF_ERROR_MAX_AGE_MS) / 1000);
}

export const CACHE_HEADER = "X-Conge-Cache";

// Pages that understand per-call "upstream failed" errors (see
// resolveCalls) POST to "/?partial=1". Without it, a partly answerable
// request fails as a whole (502), as it always did — an older page would
// otherwise read such an error as a revert, e.g. a busy RPC as "selling is
// blocked". A query parameter rather than a header on purpose: a new
// header would change the CORS preflight, and an older Worker would then
// reject every request from a newer page; an older Worker simply ignores
// the query string.
export const ACCEPT_PARTIAL_PARAM = "partial";
const CACHED_AT_HEADER = "X-Conge-Cached-At";

// Stable JSON: object keys sorted (recursively), strings lowercased — hex
// addresses/data are case-insensitive, so "0xAbC" and "0xabc" share a key.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k.toLowerCase())}:${canonicalize(value[k])}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.toLowerCase());
  return JSON.stringify(value ?? null);
}

// The normalized identity of an already-validated request — two requests
// with the same identity always get the same answer from the chain at the
// same moment. Used for dedupe (every method) and, where the method is
// cacheable, as the input to the cache key. The JSON-RPC id is not part of
// it.
export function callIdentity(request) {
  const { method, params } = request;
  if (method === "eth_call") {
    const [call, , override] = params;
    return canonicalize({
      method,
      to: call.to,
      from: call.from ?? null,
      data: call.data ?? call.input ?? "0x",
      override: override ?? null,
    });
  }
  if (method === "eth_getCode") return canonicalize({ method, address: params[0] });
  return canonicalize({ method });
}

export function isCacheableMethod(method) {
  return Object.hasOwn(CACHE_TTL_MS, method);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// A GET Request on this Worker's own hostname (the Cache API keys on
// URLs). Requests from outside to this path just get the normal 404.
export async function cacheKeyRequest(identity, requestUrl) {
  const url = new URL(`/__cache/v1/${await sha256Hex(identity)}`, requestUrl);
  return new Request(url.toString(), { method: "GET" });
}

// "fresh" (serve it), "stale" (only as a stale-if-error fallback) or
// "expired" (ignore), from the entry's age.
export function classifyCacheAge(cachedAtMs, nowMs, ttlMs) {
  const age = nowMs - cachedAtMs;
  if (!Number.isFinite(age) || age < 0) return "expired";
  if (age <= ttlMs) return "fresh";
  if (age <= STALE_IF_ERROR_MAX_AGE_MS) return "stale";
  return "expired";
}

function getEdgeCache() {
  return globalThis.caches?.default ?? null;
}

async function readCacheEntry(cache, keyRequest) {
  try {
    const hit = await cache.match(keyRequest);
    if (!hit) return null;
    const cachedAt = Number(hit.headers.get(CACHED_AT_HEADER));
    const body = await hit.json();
    if (!body || !Object.hasOwn(body, "result")) return null;
    return { cachedAt, result: body.result };
  } catch {
    return null; // a cache problem is never a request failure
  }
}

function writeCacheEntry(cache, keyRequest, method, result, nowMs) {
  const response = new Response(JSON.stringify({ result }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${cacheStoreSeconds(method)}`,
      [CACHED_AT_HEADER]: String(nowMs),
    },
  });
  return cache.put(keyRequest, response).catch(() => {});
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

async function handleRpc(request, origin, ctx) {
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

  const validated = batch.items.map((item) => validateRequest(item));
  const outcome = await resolveCalls(
    validated.filter((v) => v.ok).map((v) => v.request),
    request.url,
    ctx,
    Date.now(),
    { acceptPartial: new URL(request.url).searchParams.get(ACCEPT_PARTIAL_PARAM) === "1" },
  );

  if (!outcome.ok) {
    // A single failed upstream call fails the whole HTTP response, even
    // inside a batch — the upstream is unreachable/erroring, not any one
    // request in particular. `kind` is only present for a rate-limited
    // failure that survived every retry (see callUpstream) — callers use
    // it to show a specific "busy, try again" message instead of a
    // generic connectivity error.
    const body = { error: "Upstream RPC request failed", detail: outcome.detail };
    if (outcome.kind) body.kind = outcome.kind;
    return jsonResponse(body, 502, cors);
  }

  // Back in the caller's original order, each with its own original id.
  let next = 0;
  const finalResults = validated.map((v) => (v.ok ? outcome.answers[next++] : v.error));

  return jsonResponse(batch.isBatch ? finalResults : finalResults[0], 200, {
    ...cors,
    [CACHE_HEADER]: outcome.cacheStatus,
  });
}

// The per-call error for a call the upstream couldn't answer, used when
// other calls in the same request do have an answer. `data.kind` matches
// the 502 body's `kind`, so the page can tell "rate limited" from other
// failures for this one call. -32005 is the conventional "limit exceeded"
// code; any other upstream failure is an internal error (-32603).
export function upstreamCallError(upstream) {
  const kind = upstream.kind ?? "upstream-unreachable";
  return {
    code: kind === "upstream-rate-limited" ? -32005 : -32603,
    message: `Upstream RPC request failed: ${upstream.detail}`,
    data: { kind },
  };
}

// Answers a list of already-validated requests, in order, using the cache
// where it can:
//   1. Identical calls (same identity — see callIdentity) are merged, so
//      each distinct call is looked up/sent once.
//   2. Fresh cache hits are answered directly.
//   3. Everything else goes upstream in one batch, with fresh internal ids
//      (so callers' ids, even duplicate ones, can't collide), and each
//      successful result is cached.
//   4. If the upstream fails after its retries, each call that needed it
//      gets its cached result if one is at most STALE_IF_ERROR_MAX_AGE_MS
//      old (the response is then marked "stale"). With `acceptPartial`
//      (the page posted to "/?partial=1"), a call with no such
//      fallback gets its own JSON-RPC error saying the upstream failed
//      (see upstreamCallError), so one failed call never hides another
//      call's answer; only when no call at all has an answer is the whole
//      request failed (502). Without it, every call needs a fallback or
//      the whole request fails (502), as before.
// Returns { ok: true, answers, cacheStatus } — answers carry each
// request's own id; cacheStatus is "hit" (all from cache), "miss" (none),
// "partial", "stale", or "bypass" (nothing cacheable) — or the upstream
// failure { ok: false, detail, kind? }.
export async function resolveCalls(requests, requestUrl, ctx, now = Date.now(), { acceptPartial = false } = {}) {
  const cache = getEdgeCache();
  const unique = new Map(); // identity -> { method, request, result?, stale?, keyRequest? }
  for (const req of requests) {
    const identity = callIdentity(req);
    if (!unique.has(identity)) unique.set(identity, { method: req.method, request: req });
  }

  let cacheable = 0;
  let hits = 0;
  await Promise.all(
    [...unique.values()].map(async (entry) => {
      if (!cache || !isCacheableMethod(entry.method)) return;
      cacheable++;
      entry.keyRequest = await cacheKeyRequest(callIdentity(entry.request), requestUrl);
      const cached = await readCacheEntry(cache, entry.keyRequest);
      if (!cached) return;
      const age = classifyCacheAge(cached.cachedAt, now, CACHE_TTL_MS[entry.method]);
      if (age === "fresh") {
        entry.answer = { result: cached.result };
        hits++;
      } else if (age === "stale") {
        entry.stale = { result: cached.result };
      }
    }),
  );

  const misses = [...unique.values()].filter((e) => !e.answer);
  let cacheStatus = cacheable === 0 ? "bypass" : hits === 0 ? "miss" : misses.length === 0 ? "hit" : "partial";

  if (misses.length > 0) {
    const outgoing = misses.map((e, i) => ({ ...e.request, id: i + 1 }));
    const upstream = await callUpstream(outgoing);

    if (!upstream.ok) {
      const answeredElsewhere = hits > 0 || misses.some((e) => e.stale);
      if (!answeredElsewhere) return upstream;
      if (!acceptPartial && !misses.every((e) => e.stale)) return upstream;
      let staleUsed = false;
      for (const e of misses) {
        if (e.stale) {
          e.answer = e.stale;
          staleUsed = true;
        } else {
          e.answer = { error: upstreamCallError(upstream) };
        }
      }
      cacheStatus = staleUsed ? "stale" : "partial";
    } else {
      const byId = new Map();
      for (const r of Array.isArray(upstream.body) ? upstream.body : [upstream.body]) {
        if (r && typeof r === "object") byId.set(r.id, r);
      }
      const writes = [];
      misses.forEach((e, i) => {
        const r = byId.get(i + 1);
        if (!r) {
          e.answer = { error: { code: -32603, message: "Upstream did not return a result for this request" } };
          return;
        }
        if (r.error || !Object.hasOwn(r, "result")) {
          e.answer = { error: r.error ?? { code: -32603, message: "Upstream returned neither a result nor an error" } };
          return; // errors are never cached
        }
        e.answer = { result: r.result };
        if (e.keyRequest) writes.push(writeCacheEntry(cache, e.keyRequest, e.method, r.result, now));
      });
      if (writes.length) {
        const all = Promise.all(writes);
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(all);
        else await all;
      }
    }
  }

  const answers = requests.map((req) => ({ jsonrpc: "2.0", id: req.id, ...unique.get(callIdentity(req)).answer }));
  return { ok: true, answers, cacheStatus };
}

// GET /health is deliberately NOT origin-restricted: it's meant to be
// opened directly in a browser tab (a top-level navigation, which isn't
// subject to CORS — and doesn't even send an Origin header — in the first
// place) as a one-tap diagnostic. It returns no secrets — just whether the
// upstream RPC is reachable right now.
//
// Because anyone can call it, it must not be a way to amplify load on the
// shared, rate-limited upstream RPC: one upstream check is shared by every
// /health request for HEALTH_CACHE_MS — including ones that arrive while
// that check is still in flight — so a burst of hits costs at most one
// pair of upstream calls per window (per Worker isolate), not two per hit.
export const HEALTH_CACHE_MS = 15_000;
let healthCheck = null; // { startedAt, promise } of the shared upstream check

// For tests only: forget the shared check so each test starts fresh.
export function resetHealthCache() {
  healthCheck = null;
}

async function checkUpstreamHealth() {
  const outcome = await callUpstream([
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
  ]);

  if (!outcome.ok) {
    return { ok: false, upstream: { reachable: false }, error: outcome.detail };
  }

  const results = Array.isArray(outcome.body) ? outcome.body : [outcome.body];
  const chainIdResult = results.find((r) => r && r.id === 1);
  const blockNumberResult = results.find((r) => r && r.id === 2);
  const rpcError = chainIdResult?.error || blockNumberResult?.error;

  if (rpcError) {
    return { ok: false, upstream: { reachable: true, chainId: null, blockNumber: null }, error: rpcError.message };
  }

  const chainId = typeof chainIdResult?.result === "string" ? parseInt(chainIdResult.result, 16) : null;
  const blockNumber = typeof blockNumberResult?.result === "string" ? parseInt(blockNumberResult.result, 16) : null;

  return { ok: true, upstream: { reachable: true, chainId, blockNumber } };
}

async function handleHealth(now = Date.now()) {
  if (!healthCheck || now - healthCheck.startedAt >= HEALTH_CACHE_MS) {
    // Never cache a rejection: an unexpected throw becomes an honest
    // "unreachable" body like any other upstream failure.
    const promise = checkUpstreamHealth().catch((error) => ({
      ok: false,
      upstream: { reachable: false },
      error: error?.message || String(error),
    }));
    healthCheck = { startedAt: now, promise };
  }
  const body = await healthCheck.promise;
  return jsonResponse(body, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": `public, max-age=${HEALTH_CACHE_MS / 1000}`,
  });
}

// --- Entry point -----------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
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
      return handleRpc(request, origin, ctx);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
