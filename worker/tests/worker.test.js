// Unit tests for the pure validation/CORS logic in worker/index.js.
// No network — these never call the real upstream or run inside the
// Workers runtime, just plain Node (node --test), same setup as the main
// project's tests/scoring.test.js.
//
// Run with:  node --test worker/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import worker, {
  ALLOWED_ORIGINS,
  ALLOWED_METHODS,
  isAllowedOrigin,
  buildCorsHeaders,
  jsonRpcError,
  validateParams,
  validateRequest,
  parseBatch,
  decideUpstreamRetry,
  MAX_UPSTREAM_ATTEMPTS,
  RETRY_DELAYS_MS,
  UPSTREAM_TIMEOUT_MS,
  HEALTH_CACHE_MS,
  resetHealthCache,
  RETRY_JITTER,
  jitteredDelay,
  CACHE_TTL_MS,
  STALE_IF_ERROR_MAX_AGE_MS,
  CACHE_HEADER,
  canonicalize,
  callIdentity,
  isCacheableMethod,
  cacheKeyRequest,
  classifyCacheAge,
} from "../index.js";

const SITE_ORIGIN = "https://conge.site";
const WORKER_URL = "https://rpc.conge.site/";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// --- Config sanity -----------------------------------------------------

test("ALLOWED_ORIGINS is exactly the site's origins, no wildcard", () => {
  assert.deepEqual(ALLOWED_ORIGINS, ["https://conge.site", "https://www.conge.site"]);
});

test("ALLOWED_METHODS is exactly the four read-only methods", () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode"].sort());
});

// --- CORS ----------------------------------------------------------------

test("isAllowedOrigin: only the configured origins pass", () => {
  // The old GitHub Pages origin is no longer allowed since the move to conge.site.
  assert.equal(isAllowedOrigin("https://agrarisai.github.io"), false);
  assert.equal(isAllowedOrigin("http://agrarisai.github.io"), false);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin("https://conge.site"), true);
  assert.equal(isAllowedOrigin("https://www.conge.site"), true);
  assert.equal(isAllowedOrigin("http://conge.site"), false); // wrong scheme
  assert.equal(isAllowedOrigin("https://rpc.conge.site"), false); // the Worker's own host isn't the site
  assert.equal(isAllowedOrigin("https://evil.conge.site"), false); // no subdomain wildcard
  assert.equal(isAllowedOrigin("https://conge.site.evil.example"), false);
  assert.equal(isAllowedOrigin(null), false);
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin(""), false);
});

test("buildCorsHeaders: allowed origin gets echoed back with no wildcard anywhere", () => {
  const headers = buildCorsHeaders("https://conge.site");
  assert.ok(headers);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://conge.site");
  for (const value of Object.values(headers)) {
    assert.doesNotMatch(String(value), /\*/, "no header value should contain a wildcard");
  }
});

test("buildCorsHeaders: disallowed origin returns null (caller must 403)", () => {
  assert.equal(buildCorsHeaders("https://evil.example"), null);
  assert.equal(buildCorsHeaders(null), null);
});

// --- jsonRpcError -----------------------------------------------------

test("jsonRpcError shape", () => {
  const err = jsonRpcError(5, -32601, "nope");
  assert.deepEqual(err, { jsonrpc: "2.0", id: 5, error: { code: -32601, message: "nope" } });
  assert.equal(jsonRpcError(undefined, -32600, "x").id, null);
  assert.equal(jsonRpcError(null, -32600, "x").id, null);
});

// --- validateParams: eth_chainId / eth_blockNumber ------------------------

test("validateParams: eth_chainId and eth_blockNumber take no params", () => {
  assert.equal(validateParams("eth_chainId", []).ok, true);
  assert.equal(validateParams("eth_blockNumber", []).ok, true);
  assert.equal(validateParams("eth_chainId", ["latest"]).ok, false);
  assert.equal(validateParams("eth_blockNumber", [1]).ok, false);
});

// --- validateParams: eth_getCode -------------------------------------

test("validateParams: eth_getCode requires a hex address and 'latest'", () => {
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS, "latest"]).ok, true);
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS, "pending"]).ok, false);
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS, "0x10"]).ok, false); // no block numbers, only "latest"
  assert.equal(validateParams("eth_getCode", ["not-hex", "latest"]).ok, false);
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS.slice(0, -2), "latest"]).ok, false); // too short
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS]).ok, false); // missing blockTag
  assert.equal(validateParams("eth_getCode", [VALID_ADDRESS, "latest", "extra"]).ok, false);
});

// --- validateParams: eth_call -------------------------------------------

test("validateParams: eth_call accepts a minimal valid call", () => {
  const result = validateParams("eth_call", [{ to: VALID_ADDRESS, data: "0xabcdef" }, "latest"]);
  assert.equal(result.ok, true);
});

test("validateParams: eth_call accepts 'input' as an alias for 'data'", () => {
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS, input: "0x" }, "latest"]).ok, true);
});

test("validateParams: eth_call requires a valid 'to' address", () => {
  assert.equal(validateParams("eth_call", [{ data: "0x" }, "latest"]).ok, false); // missing to
  assert.equal(validateParams("eth_call", [{ to: "not-hex" }, "latest"]).ok, false);
});

test("validateParams: eth_call validates 'from' when present", () => {
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS, from: OTHER_ADDRESS }, "latest"]).ok, true);
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS, from: "bad" }, "latest"]).ok, false);
});

test("validateParams: eth_call rejects malformed hex data (odd length)", () => {
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS, data: "0xabc" }, "latest"]).ok, false);
});

test("validateParams: eth_call only allows the 'latest' block tag", () => {
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS }, "earliest"]).ok, false);
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS }, "0x123"]).ok, false);
});

test("validateParams: eth_call passes a third (state override) param through without validating it", () => {
  const weirdOverrides = { [VALID_ADDRESS]: { balance: "not even valid hex, doesn't matter" } };
  const result = validateParams("eth_call", [{ to: VALID_ADDRESS }, "latest", weirdOverrides]);
  assert.equal(result.ok, true);
});

test("validateParams: eth_call rejects wrong param counts", () => {
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS }]).ok, false); // missing blockTag
  assert.equal(validateParams("eth_call", [{ to: VALID_ADDRESS }, "latest", {}, "extra"]).ok, false); // too many
});

test("validateParams: unsupported method is rejected", () => {
  const result = validateParams("eth_sendTransaction", []);
  assert.equal(result.ok, false);
});

// --- validateRequest --------------------------------------------------

test("validateRequest: a well-formed eth_chainId request is accepted and normalized", () => {
  const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
});

test("validateRequest: missing params defaults to an empty array", () => {
  const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.params, []);
});

test("validateRequest: missing id normalizes to null rather than throwing", () => {
  const result = validateRequest({ jsonrpc: "2.0", method: "eth_chainId", params: [] });
  assert.equal(result.ok, true);
  assert.equal(result.request.id, null);
});

test("validateRequest: wrong jsonrpc version is Invalid Request (-32600)", () => {
  const result = validateRequest({ jsonrpc: "1.0", id: 1, method: "eth_chainId", params: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32600);
});

test("validateRequest: non-object / array bodies are Invalid Request (-32600)", () => {
  assert.equal(validateRequest(null).error.error.code, -32600);
  assert.equal(validateRequest("nope").error.error.code, -32600);
  assert.equal(validateRequest([1, 2, 3]).error.error.code, -32600);
});

test("validateRequest: disallowed method is Method not found (-32601), exactly as specified", () => {
  const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32601);
});

// Confirms the Worker already forwards eth_call's "from" field, end to
// end through the exact code path handleRpc() uses (validateRequest ->
// .request.params), without altering it. This is a *verification* test,
// not a regression test for a bug — see the "from" section of the main
// PR description for why this matters (a sell-simulation honeypot check
// needs to simulate a transfer as if a specific holder sent it).
test('validateRequest: eth_call\'s "from" field survives normalization unchanged, ready to forward upstream', () => {
  const result = validateRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: VALID_ADDRESS, from: OTHER_ADDRESS, data: "0xa9059cbb" }, "latest"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.params[0].from, OTHER_ADDRESS);
  assert.equal(result.request.params[0].to, VALID_ADDRESS);
  assert.equal(result.request.params[0].data, "0xa9059cbb");
});

test("validateRequest: every allowed method is actually accepted end-to-end", () => {
  const validParamsByMethod = {
    eth_chainId: [],
    eth_blockNumber: [],
    eth_getCode: [VALID_ADDRESS, "latest"],
    eth_call: [{ to: VALID_ADDRESS }, "latest"],
  };
  for (const method of ALLOWED_METHODS) {
    const result = validateRequest({ jsonrpc: "2.0", id: 1, method, params: validParamsByMethod[method] });
    assert.equal(result.ok, true, `${method} should validate`);
  }
});

test("validateRequest: params must be an array (-32602)", () => {
  const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32602);
});

test("validateRequest: bad method-specific params surface as -32602 with the request's id", () => {
  const result = validateRequest({ jsonrpc: "2.0", id: "abc", method: "eth_getCode", params: ["not-hex", "latest"] });
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32602);
  assert.equal(result.error.id, "abc");
});

// --- parseBatch ---------------------------------------------------------

test("parseBatch: a single object is not treated as a batch", () => {
  const result = parseBatch({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  assert.equal(result.ok, true);
  assert.equal(result.isBatch, false);
  assert.equal(result.items.length, 1);
});

test("parseBatch: an array is a batch", () => {
  const result = parseBatch([{ id: 1 }, { id: 2 }]);
  assert.equal(result.ok, true);
  assert.equal(result.isBatch, true);
  assert.equal(result.items.length, 2);
});

test("parseBatch: exactly 10 items is allowed", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  const result = parseBatch(items);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 10);
});

test("parseBatch: 11 items is rejected", () => {
  const items = Array.from({ length: 11 }, (_, i) => ({ id: i }));
  const result = parseBatch(items);
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32600);
});

test("parseBatch: an empty batch is rejected", () => {
  const result = parseBatch([]);
  assert.equal(result.ok, false);
  assert.equal(result.error.error.code, -32600);
});

// --- Full request handler: real browser preflight + POST simulation ------
//
// Everything above tests the pure validation/CORS building blocks in
// isolation. These tests instead drive the actual `fetch(request)` entry
// point (the default export — what Cloudflare invokes for a real request)
// with real `Request` objects shaped exactly like a browser would send
// them: a genuine CORS preflight (OPTIONS + Access-Control-Request-Method
// + Access-Control-Request-Headers) followed by the real POST, including
// a full 10-item batch with an eth_call that carries a "from" field. This
// is the most direct way — short of a live deployment, which this
// sandboxed environment's egress allowlist blocks — to confirm the Worker
// doesn't have a CORS/validation bug: if either of these produced the
// wrong headers or an unexpected rejection, these tests would fail.
// globalThis.fetch is stubbed only for the upstream call inside
// callUpstream(); nothing here touches the real network.

test("full request handler: a real CORS preflight (OPTIONS + Access-Control-Request-*) from the site origin gets a correct 204", async () => {
  const request = new Request(WORKER_URL, {
    method: "OPTIONS",
    headers: {
      Origin: SITE_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const response = await worker.fetch(request);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), SITE_ORIGIN);
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.match(response.headers.get("access-control-allow-headers").toLowerCase(), /content-type/);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.doesNotMatch(response.headers.get("access-control-allow-origin"), /\*/);
});

test("full request handler: a preflight from a disallowed origin gets 403 with no CORS headers (no wildcard fallback)", async () => {
  const request = new Request(WORKER_URL, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const response = await worker.fetch(request);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test('full request handler: a real POST — a 10-item batch, one eth_call with "from" — from the site origin is accepted, forwarded upstream unchanged, and answered with CORS headers', async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamCalledWith = null;
  globalThis.fetch = async (url, init) => {
    upstreamCalledWith = { url, body: JSON.parse(init.body) };
    const requests = Array.isArray(upstreamCalledWith.body) ? upstreamCalledWith.body : [upstreamCalledWith.body];
    const results = requests.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x1" }));
    return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const batch = Array.from({ length: 10 }, (_, i) =>
    i === 0
      ? {
          jsonrpc: "2.0",
          id: i,
          method: "eth_call",
          params: [{ to: VALID_ADDRESS, from: OTHER_ADDRESS, data: "0xa9059cbb" }, "latest"],
        }
      : // Distinct calls: identical ones would be merged (see the dedupe tests).
        { jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: VALID_ADDRESS, data: "0x" + i.toString(16).padStart(8, "0") }, "latest"] },
  );

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  const response = await worker.fetch(request);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), SITE_ORIGIN);

  const body = await response.json();
  assert.equal(body.length, 10);

  // The Worker forwarded all 10 — none were rejected by validation — and
  // the eth_call's "from" field reached the upstream request unchanged.
  assert.ok(upstreamCalledWith);
  assert.equal(upstreamCalledWith.body.length, 10);
  assert.equal(upstreamCalledWith.body[0].params[0].from, OTHER_ADDRESS);
  assert.equal(upstreamCalledWith.body[0].params[0].to, VALID_ADDRESS);
});

test("full request handler: a real POST from a disallowed origin is rejected with 403 and never reaches the upstream fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamWasCalled = false;
  globalThis.fetch = async () => {
    upstreamWasCalled = true;
    throw new Error("upstream should never be called for a disallowed origin");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const response = await worker.fetch(request);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(upstreamWasCalled, false);
});

// --- Every allowed origin works end to end -------------------------------
//
// The site is moving from GitHub Pages to its own domain, so a real browser
// POST — and its preflight — from each allowed origin (old and new, with
// and without www) must be accepted and echoed back as its own
// Access-Control-Allow-Origin, never a different one and never "*".

for (const allowedOrigin of ALLOWED_ORIGINS) {
  test(`allowed origin works end to end (preflight + POST): ${allowedOrigin}`, async (t) => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const preflight = await worker.fetch(
      new Request(WORKER_URL, {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);

    const response = await worker.fetch(
      new Request(WORKER_URL, {
        method: "POST",
        headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: "0x1237" });
    assert.equal(upstreamCalls, 1);
  });
}

// --- Forged origins on the actual POST (not just the preflight) -----------
//
// CORS headers only stop a *browser* from reading a cross-origin response;
// a script or curl can send any Origin header (or none) and never does a
// preflight. So the origin check must be enforced server-side on the POST
// itself, before the body is read or any upstream work happens. Each case
// here is a direct, non-preflight POST that a script could send.

const FORGED_ORIGINS = [
  ["no Origin header at all (curl's default)", null],
  ['the literal "null" origin (sandboxed iframes, file://)', "null"],
  ["an unrelated site", "https://evil.example"],
  ["the old GitHub Pages origin (no longer allowed)", "https://agrarisai.github.io"],
  ["the old GitHub Pages origin over http", "http://agrarisai.github.io"],
  ["a different GitHub Pages user", "https://someone-else.github.io"],
  ["a localhost dev origin", "http://localhost:8080"],
  ["the right host over http", "http://conge.site"],
  ["a look-alike suffix domain", "https://conge.site.evil.example"],
  ["a look-alike prefix domain", "https://evil-conge.site"],
  ["an unlisted subdomain", "https://evil.conge.site"],
  ["the Worker's own custom domain", "https://rpc.conge.site"],
  ["the right origin with a trailing slash", "https://conge.site/"],
  ["the right origin with a path", "https://conge.site/index.html"],
  ["the right origin with a port", "https://conge.site:443"],
  ["different letter case", "https://Conge.site"],
];

for (const [label, forgedOrigin] of FORGED_ORIGINS) {
  test(`forged origin on a real (non-preflight) POST is rejected with 403 before any upstream work: ${label}`, async (t) => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls++;
      throw new Error("upstream must never be called for a forged origin");
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const headers = { "Content-Type": "application/json" };
    if (forgedOrigin !== null) headers.Origin = forgedOrigin;
    const response = await worker.fetch(
      new Request(WORKER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      }),
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), { error: "Origin not allowed" });
    assert.equal(upstreamCalls, 0);
  });
}

test("forged origin: a POST that looks like a browser's (Referer, Sec-Fetch-*, User-Agent) but carries a foreign Origin is still rejected", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    throw new Error("upstream must never be called");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Only Origin is trusted for the decision — the other headers a script
  // can copy from a real browser request must not let it through.
  const response = await worker.fetch(
    new Request(WORKER_URL, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Referer: "https://conge.site/",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(upstreamCalls, 0);
});

// --- /health can't be used to amplify upstream load ------------------------
//
// /health is intentionally open to any caller (no Origin check — it's a
// one-tap diagnostic opened as a plain browser tab). It therefore shares a
// single upstream check for HEALTH_CACHE_MS, so hammering it can't turn
// into one upstream round-trip per hit.

function stubHealthyUpstream(t) {
  const originalFetch = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls++;
    return new Response(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: "0x1237" },
        { jsonrpc: "2.0", id: 2, result: "0x10" },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    resetHealthCache();
  });
  resetHealthCache();
  return state;
}

test("/health: 20 rapid requests from a script share one upstream check", async (t) => {
  const upstream = stubHealthyUpstream(t);
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => worker.fetch(new Request(`${WORKER_URL}health`))),
  );
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, upstream: { reachable: true, chainId: 4663, blockNumber: 16 } });
  }
  assert.equal(upstream.calls, 1);
  assert.equal(responses[0].headers.get("cache-control"), `public, max-age=${HEALTH_CACHE_MS / 1000}`);
});

test("/health: a fresh upstream check happens once the shared window has passed", async (t) => {
  const upstream = stubHealthyUpstream(t);
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  const start = realNow();
  Date.now = () => start;
  await worker.fetch(new Request(`${WORKER_URL}health`));
  Date.now = () => start + HEALTH_CACHE_MS - 1;
  await worker.fetch(new Request(`${WORKER_URL}health`));
  assert.equal(upstream.calls, 1);
  Date.now = () => start + HEALTH_CACHE_MS;
  await worker.fetch(new Request(`${WORKER_URL}health`));
  assert.equal(upstream.calls, 2);
});

// --- Upstream rate-limit retry ---------------------------------------------
//
// The shared upstream RPC rate-limits (429) or is briefly overloaded (503)
// under load. The retry/backoff *decision* (decideUpstreamRetry) is pure
// and tested directly below, with no real waiting — including the
// time-budget-capping case, which would otherwise need an 8s-long test.
// callUpstream itself (the network orchestration around that decision)
// is exercised end-to-end afterwards, through the real `fetch(request)`
// entry point, the same way as the CORS/POST tests above — but only for
// the fast cases, since a full 5-attempt exhaustion takes the real
// ~6s of backoff.

// random() === 0.5 means a jitter factor of exactly 1 — the base schedule.
const NO_JITTER = () => 0.5;

test("decideUpstreamRetry: retries a 429/503 with the documented backoff, while attempts and time budget allow", () => {
  assert.deepEqual(decideUpstreamRetry(429, 1, 0, NO_JITTER), { retry: true, delayMs: RETRY_DELAYS_MS[0] });
  assert.deepEqual(decideUpstreamRetry(503, 1, 0, NO_JITTER), { retry: true, delayMs: RETRY_DELAYS_MS[0] });
  assert.deepEqual(decideUpstreamRetry(429, 2, 500, NO_JITTER), { retry: true, delayMs: RETRY_DELAYS_MS[1] });
  assert.deepEqual(decideUpstreamRetry(429, 3, 2000, NO_JITTER), { retry: true, delayMs: RETRY_DELAYS_MS[2] });
  assert.deepEqual(decideUpstreamRetry(429, 4, 1000, NO_JITTER), { retry: true, delayMs: RETRY_DELAYS_MS[3] });
});

test("decideUpstreamRetry: never retries a non-retryable status, however early", () => {
  for (const status of [200, 400, 403, 500, 504]) {
    assert.deepEqual(decideUpstreamRetry(status, 1, 0), { retry: false, reason: "not-retryable" });
  }
});

test("decideUpstreamRetry: stops once MAX_UPSTREAM_ATTEMPTS is reached, even with time to spare", () => {
  assert.equal(MAX_UPSTREAM_ATTEMPTS, 5);
  assert.deepEqual(decideUpstreamRetry(429, MAX_UPSTREAM_ATTEMPTS, 0), { retry: false, reason: "exhausted-attempts" });
});

test("decideUpstreamRetry: stops early (before exhausting attempts) when the next delay would blow the 8s budget", () => {
  // At attempt 4 (about to try the 3200ms delay before attempt 5), having
  // already used most of the 8s budget, there isn't room for another
  // 3200ms wait — this is the "cap attempts to respect the timeout" case.
  const elapsedMs = UPSTREAM_TIMEOUT_MS - RETRY_DELAYS_MS[3] + 1; // 1ms short of enough room
  const decision = decideUpstreamRetry(429, 4, elapsedMs, NO_JITTER);
  assert.deepEqual(decision, { retry: false, reason: "time-budget" });
});

test("decideUpstreamRetry: does retry when there's exactly enough time left", () => {
  const elapsedMs = UPSTREAM_TIMEOUT_MS - RETRY_DELAYS_MS[3] - 1; // 1ms of room to spare
  const decision = decideUpstreamRetry(429, 4, elapsedMs, NO_JITTER);
  assert.deepEqual(decision, { retry: true, delayMs: RETRY_DELAYS_MS[3] });
});

test("RETRY_DELAYS_MS matches the documented backoff schedule (400ms, 800ms, 1600ms, 3200ms)", () => {
  assert.deepEqual(RETRY_DELAYS_MS, [400, 800, 1600, 3200]);
  // One delay per gap between MAX_UPSTREAM_ATTEMPTS attempts.
  assert.equal(RETRY_DELAYS_MS.length, MAX_UPSTREAM_ATTEMPTS - 1);
});

test("upstream 429 then success: the Worker retries and eventually returns 200", async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response("Too Many Requests", { status: 429 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const response = await worker.fetch(request);

  assert.equal(callCount, 2, "the Worker should have retried once after the 429");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, "0x1237");
});

// Real backoff, real timers — the full 5-attempt exhaustion takes
// ~6s (400+800+1600+3200ms) for real, which is the point: it confirms
// the actual end-to-end timing, not just the decision logic (already
// covered fast, above).
test("upstream 429 on every attempt: the Worker gives up after 5 tries and returns a clearly-labeled 502", async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response("Too Many Requests", { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const response = await worker.fetch(request);

  assert.equal(callCount, MAX_UPSTREAM_ATTEMPTS, `should try ${MAX_UPSTREAM_ATTEMPTS} times total before giving up`);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.kind, "upstream-rate-limited");
  assert.match(body.detail, /rate limited/i);
  assert.match(body.detail, new RegExp(`after ${MAX_UPSTREAM_ATTEMPTS} attempts`));
});

test("upstream 503 is retried the same way as 429", async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount < 2) return new Response("Service Unavailable", { status: 503 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const response = await worker.fetch(request);

  assert.equal(callCount, 2);
  assert.equal(response.status, 200);
});

test("a non-retryable upstream error (e.g. 500) fails immediately, with no retry and no rate-limited kind", async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response("Internal Server Error", { status: 500 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request(WORKER_URL, {
    method: "POST",
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const response = await worker.fetch(request);

  assert.equal(callCount, 1, "a non-retryable status should not be retried");
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.kind, undefined);
});

// --- Retry jitter ---------------------------------------------------------

test("jitteredDelay stays within ±25% of the base delay", () => {
  assert.equal(RETRY_JITTER, 0.25);
  assert.equal(jitteredDelay(400, () => 0), 300);
  assert.equal(jitteredDelay(400, () => 0.5), 400);
  assert.equal(jitteredDelay(400, () => 0.999999), 500);
  for (let i = 0; i < 2000; i++) {
    for (const base of RETRY_DELAYS_MS) {
      const d = jitteredDelay(base);
      assert.ok(d >= base * 0.75 && d <= base * 1.25, `${d} outside ±25% of ${base}`);
    }
  }
});

test("decideUpstreamRetry: the 8s deadline check uses the jittered delay", () => {
  // 3200ms base: +25% (4000ms) no longer fits where -25% (2400ms) still does.
  const elapsedMs = UPSTREAM_TIMEOUT_MS - 3000;
  assert.deepEqual(decideUpstreamRetry(429, 4, elapsedMs, () => 0), { retry: true, delayMs: 2400 });
  assert.deepEqual(decideUpstreamRetry(429, 4, elapsedMs, () => 0.999999), { retry: false, reason: "time-budget" });
});

test("decideUpstreamRetry: jitter never changes which statuses retry or the attempt cap", () => {
  for (const random of [() => 0, () => 0.999999]) {
    assert.deepEqual(decideUpstreamRetry(500, 1, 0, random), { retry: false, reason: "not-retryable" });
    assert.deepEqual(decideUpstreamRetry(429, MAX_UPSTREAM_ATTEMPTS, 0, random), { retry: false, reason: "exhausted-attempts" });
  }
});

// --- Cache keys -------------------------------------------------------------

test("cache TTLs: eth_call 60s, eth_getCode 10min, eth_chainId 1h, eth_blockNumber never cached", () => {
  assert.equal(CACHE_TTL_MS.eth_call, 60_000);
  assert.equal(CACHE_TTL_MS.eth_getCode, 600_000);
  assert.equal(CACHE_TTL_MS.eth_chainId, 3_600_000);
  assert.equal(isCacheableMethod("eth_blockNumber"), false);
  assert.equal(STALE_IF_ERROR_MAX_AGE_MS, 600_000);
});

test("canonicalize: key order and hex case don't matter", () => {
  assert.equal(canonicalize({ b: "0xAB", a: [1, "X"] }), canonicalize({ a: [1, "x"], b: "0xab" }));
});

test("callIdentity: normalizes case, ignores the JSON-RPC id, but includes from/data/override", () => {
  const base = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: VALID_ADDRESS, data: "0x8da5cb5b" }, "latest"] };
  const sameUpper = { ...base, id: "other", params: [{ to: VALID_ADDRESS.toUpperCase().replace("0X", "0x"), data: "0x8DA5CB5B" }, "latest"] };
  assert.equal(callIdentity(base), callIdentity(sameUpper));
  const viaInput = { ...base, params: [{ to: VALID_ADDRESS, input: "0x8da5cb5b" }, "latest"] };
  assert.equal(callIdentity(base), callIdentity(viaInput));
  const withFrom = { ...base, params: [{ to: VALID_ADDRESS, from: OTHER_ADDRESS, data: "0x8da5cb5b" }, "latest"] };
  assert.notEqual(callIdentity(base), callIdentity(withFrom));
  const otherData = { ...base, params: [{ to: VALID_ADDRESS, data: "0x70a08231" }, "latest"] };
  assert.notEqual(callIdentity(base), callIdentity(otherData));
  const withOverride = { ...base, params: [{ to: VALID_ADDRESS, data: "0x8da5cb5b" }, "latest", { [OTHER_ADDRESS]: { balance: "0x1" } }] };
  assert.notEqual(callIdentity(base), callIdentity(withOverride));
});

test("cacheKeyRequest: a GET on the Worker's own host whose path is only a hash", async () => {
  const req = await cacheKeyRequest(callIdentity({ method: "eth_call", params: [{ to: VALID_ADDRESS, data: "0x01" }, "latest"] }), WORKER_URL);
  assert.equal(req.method, "GET");
  const url = new URL(req.url);
  assert.equal(url.host, "rpc.conge.site");
  assert.match(url.pathname, /^\/__cache\/v1\/[0-9a-f]{64}$/);
  // Nothing readable about the call (address, calldata) ends up in the key.
  assert.doesNotMatch(req.url.toLowerCase(), new RegExp(VALID_ADDRESS.slice(2).toLowerCase()));
});

test("classifyCacheAge: fresh within TTL, stale up to 10 minutes, then expired", () => {
  const now = 1_000_000_000;
  assert.equal(classifyCacheAge(now - 59_000, now, CACHE_TTL_MS.eth_call), "fresh");
  assert.equal(classifyCacheAge(now - 61_000, now, CACHE_TTL_MS.eth_call), "stale");
  assert.equal(classifyCacheAge(now - 600_000, now, CACHE_TTL_MS.eth_call), "stale");
  assert.equal(classifyCacheAge(now - 600_001, now, CACHE_TTL_MS.eth_call), "expired");
  assert.equal(classifyCacheAge(now - 9 * 60_000, now, CACHE_TTL_MS.eth_getCode), "fresh");
  assert.equal(classifyCacheAge(now - 59 * 60_000, now, CACHE_TTL_MS.eth_chainId), "fresh");
  assert.equal(classifyCacheAge(NaN, now, CACHE_TTL_MS.eth_call), "expired");
  assert.equal(classifyCacheAge(now + 5000, now, CACHE_TTL_MS.eth_call), "expired");
});

// --- Cache through the full request handler ---------------------------------
//
// An in-memory stand-in for the Workers Cache API (caches.default), keyed
// by URL like the real one; the upstream is a stubbed fetch that records
// every call it receives.

class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const hit = this.store.get(request.url);
    return hit ? hit.clone() : undefined;
  }
  async put(request, response) {
    this.store.set(request.url, response.clone());
  }
}

function setupCacheTest(t, { now = 1_800_000_000_000 } = {}) {
  const cache = new FakeCache();
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: cache };
  const state = { now, upstreamCalls: [], mode: "ok", results: (req) => "0x" + req.params?.[0]?.data?.slice(2, 10).padStart(64, "0") };
  t.mock.method(Date, "now", () => state.now);
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const items = Array.isArray(body) ? body : [body];
    state.upstreamCalls.push(items);
    if (state.mode === "500") return new Response("oops", { status: 500 });
    if (state.mode === "throw") throw new TypeError("network down");
    const out = items.map((r) =>
      state.errorFor?.(r) ? { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id: r.id, result: state.results(r) },
    );
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });
  return { cache, state };
}

const call = (id, data, extra = {}) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: VALID_ADDRESS, data, ...extra }, "latest"] });

async function post(body, origin = SITE_ORIGIN) {
  const response = await worker.fetch(
    new Request(WORKER_URL, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: response.status, cacheHeader: response.headers.get(CACHE_HEADER), body: await response.json(), headers: response.headers };
}

test("cache: a repeated batch is answered from cache with the caller's own ids and order, and no upstream call", async (t) => {
  const { state } = setupCacheTest(t);
  const first = await post([call(7, "0x8da5cb5b"), call("b", "0x70a08231")]);
  assert.equal(first.status, 200);
  assert.equal(first.cacheHeader, "miss");
  assert.equal(state.upstreamCalls.length, 1);
  assert.equal(state.upstreamCalls[0].length, 2);

  state.now += 30_000;
  const second = await post([call("x", "0x8da5cb5b"), call(99, "0x70a08231")]);
  assert.equal(second.cacheHeader, "hit");
  assert.equal(state.upstreamCalls.length, 1, "no new upstream call");
  assert.deepEqual(second.body.map((r) => r.id), ["x", 99]);
  assert.deepEqual(second.body.map((r) => r.result), first.body.map((r) => r.result));
  assert.equal(second.headers.get("access-control-expose-headers"), "X-Conge-Cache");
});

test("cache: a partly cached batch sends only the misses upstream and merges results back in order", async (t) => {
  const { state } = setupCacheTest(t);
  await post([call(1, "0x8da5cb5b")]);
  const res = await post([call("a", "0x11111111"), call("b", "0x8da5cb5b"), call("c", "0x22222222")]);
  assert.equal(res.cacheHeader, "partial");
  const lastUpstream = state.upstreamCalls.at(-1);
  assert.deepEqual(lastUpstream.map((r) => r.params[0].data), ["0x11111111", "0x22222222"]);
  assert.deepEqual(res.body.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(
    res.body.map((r) => r.result),
    ["0x11111111", "0x8da5cb5b", "0x22222222"].map((d) => "0x" + d.slice(2).padStart(64, "0")),
  );
});

test("cache: eth_call entries expire after 60s", async (t) => {
  const { state } = setupCacheTest(t);
  await post(call(1, "0x8da5cb5b"));
  state.now += 61_000;
  const res = await post(call(2, "0x8da5cb5b"));
  assert.equal(res.cacheHeader, "miss");
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(res.body.id, 2);
});

test("cache: JSON-RPC errors are never cached", async (t) => {
  const { state } = setupCacheTest(t);
  state.errorFor = () => true;
  const first = await post(call(1, "0x8da5cb5b"));
  assert.equal(first.body.error.message, "execution reverted");
  state.errorFor = null;
  const second = await post(call(2, "0x8da5cb5b"));
  assert.equal(state.upstreamCalls.length, 2, "the error wasn't served from cache");
  assert.ok(second.body.result);
  assert.equal(second.body.id, 2);
});

test("cache: an upstream failure (HTTP 5xx) is never cached", async (t) => {
  const { state, cache } = setupCacheTest(t);
  state.mode = "500";
  const res = await post(call(1, "0x8da5cb5b"));
  assert.equal(res.status, 502);
  assert.equal(cache.store.size, 0);
});

test("cache: eth_blockNumber is never cached", async (t) => {
  const { state, cache } = setupCacheTest(t);
  state.results = () => "0x10";
  await post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  const res = await post({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] });
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(res.cacheHeader, "bypass");
  assert.equal(cache.store.size, 0);
});

test("cache: eth_getCode stays fresh for 10 minutes, eth_chainId for an hour", async (t) => {
  const { state } = setupCacheTest(t);
  state.results = () => "0x6080";
  const getCode = (id) => ({ jsonrpc: "2.0", id, method: "eth_getCode", params: [VALID_ADDRESS, "latest"] });
  const chainId = (id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] });
  await post([getCode(1), chainId(2)]);
  state.now += 9 * 60_000;
  assert.equal((await post([getCode(3), chainId(4)])).cacheHeader, "hit");
  state.now += 2 * 60_000; // 11 min: getCode expired, chainId still fresh
  const res = await post([getCode(5), chainId(6)]);
  assert.equal(res.cacheHeader, "partial");
  assert.equal(state.upstreamCalls.at(-1)[0].method, "eth_getCode");
});

test("stale-if-error: on upstream failure, a cached result up to 10 minutes old is served, marked stale", async (t) => {
  const { state } = setupCacheTest(t);
  const fresh = await post([call(1, "0x8da5cb5b"), call(2, "0x70a08231")]);
  state.now += 5 * 60_000; // past the 60s TTL, within 10 minutes
  for (const mode of ["500", "throw"]) {
    state.mode = mode;
    const res = await post([call("p", "0x70a08231"), call("q", "0x8da5cb5b")]);
    assert.equal(res.status, 200, mode);
    assert.equal(res.cacheHeader, "stale", mode);
    assert.deepEqual(res.body.map((r) => r.id), ["p", "q"]);
    assert.deepEqual(res.body.map((r) => r.result), [fresh.body[1].result, fresh.body[0].result]);
  }
});

test("stale-if-error: older than 10 minutes is not served — the failure is returned as before", async (t) => {
  const { state } = setupCacheTest(t);
  await post(call(1, "0x8da5cb5b"));
  state.now += 10 * 60_000 + 1;
  state.mode = "500";
  const res = await post(call(2, "0x8da5cb5b"));
  assert.equal(res.status, 502);
  assert.equal(res.cacheHeader, null);
});

test("upstream failure: a call with a stale fallback is still answered; the other gets its own error (one failure never hides the other)", async (t) => {
  const { state } = setupCacheTest(t);
  const primed = await post(call(1, "0x8da5cb5b"));
  state.now += 2 * 60_000;
  state.mode = "500";
  const res = await post([call(2, "0x8da5cb5b"), call(3, "0x99999999")]);
  assert.equal(res.status, 200);
  assert.equal(res.cacheHeader, "stale");
  assert.deepEqual(res.body.map((r) => r.id), [2, 3]);
  assert.equal(res.body[0].result, primed.body.result);
  assert.equal(res.body[1].result, undefined);
  assert.equal(res.body[1].error.code, -32603);
  assert.equal(res.body[1].error.data.kind, "upstream-unreachable");
  assert.match(res.body[1].error.message, /Upstream RPC request failed/);
});

test("upstream failure: a fresh cache hit is still returned next to a failed call, marked partial (not stale)", async (t) => {
  const { state } = setupCacheTest(t);
  const primed = await post(call(1, "0x8da5cb5b"));
  state.now += 10_000;
  state.mode = "throw";
  const res = await post([call("owner", "0x8da5cb5b"), call("bal", "0x70a08231")]);
  assert.equal(res.status, 200);
  assert.equal(res.cacheHeader, "partial");
  assert.equal(res.body[0].result, primed.body.result);
  assert.equal(res.body[1].error.data.kind, "upstream-unreachable");
});

test("upstreamCallError: rate-limited failures get -32005 and kind upstream-rate-limited", async () => {
  const { upstreamCallError } = await import("../index.js");
  assert.deepEqual(upstreamCallError({ ok: false, detail: "Upstream is rate limited (HTTP 429) after 5 attempts", kind: "upstream-rate-limited" }), {
    code: -32005,
    message: "Upstream RPC request failed: Upstream is rate limited (HTTP 429) after 5 attempts",
    data: { kind: "upstream-rate-limited" },
  });
  assert.equal(upstreamCallError({ ok: false, detail: "x" }).code, -32603);
});

test("upstream failure with nothing answered from cache: the whole request fails as before (502, no header)", async (t) => {
  const { state } = setupCacheTest(t);
  state.mode = "500";
  const res = await post([call(1, "0x8da5cb5b"), call(2, "0x70a08231")]);
  assert.equal(res.status, 502);
  assert.equal(res.cacheHeader, null);
});

test("stale data is only ever served with the X-Conge-Cache: stale header; a healthy upstream refreshes it", async (t) => {
  const { state } = setupCacheTest(t);
  await post(call(1, "0x8da5cb5b"));
  state.now += 5 * 60_000;
  const res = await post(call(2, "0x8da5cb5b"));
  assert.equal(res.cacheHeader, "miss", "stale entry not used while upstream is healthy");
  assert.equal(state.upstreamCalls.length, 2);
});

test("dedupe: identical calls in one batch go upstream once and each keeps its own id", async (t) => {
  const { state } = setupCacheTest(t);
  const res = await post([call(1, "0x8da5cb5b"), call(2, "0x70a08231"), call(3, "0x8DA5CB5B"), call(1, "0x8da5cb5b")]);
  assert.equal(state.upstreamCalls.length, 1);
  assert.equal(state.upstreamCalls[0].length, 2);
  assert.deepEqual(res.body.map((r) => r.id), [1, 2, 3, 1]);
  assert.equal(res.body[0].result, res.body[2].result);
  assert.equal(res.body[0].result, res.body[3].result);
});

test("dedupe works without a cache too (workers.dev, or no Cache API)", async (t) => {
  const { state } = setupCacheTest(t);
  globalThis.caches = undefined;
  const res = await post([call(1, "0x8da5cb5b"), call(2, "0x8da5cb5b")]);
  assert.equal(res.cacheHeader, "bypass");
  assert.equal(state.upstreamCalls[0].length, 1);
  assert.deepEqual(res.body.map((r) => r.id), [1, 2]);
});

test("cache doesn't loosen validation: disallowed methods and non-latest blocks are still rejected inside a cached batch", async (t) => {
  const { state } = setupCacheTest(t);
  await post(call(1, "0x8da5cb5b"));
  const res = await post([
    call("ok", "0x8da5cb5b"),
    { jsonrpc: "2.0", id: "send", method: "eth_sendRawTransaction", params: ["0xdead"] },
    { jsonrpc: "2.0", id: "old", method: "eth_call", params: [{ to: VALID_ADDRESS, data: "0x8da5cb5b" }, "0x1"] },
  ]);
  assert.equal(res.body[0].id, "ok");
  assert.ok(res.body[0].result);
  assert.equal(res.body[1].error.code, -32601);
  assert.equal(res.body[2].error.code, -32602);
  assert.equal(state.upstreamCalls.length, 1, "nothing new sent upstream");
});

test("cache doesn't loosen the origin check: a disallowed origin gets 403 even for a cached call", async (t) => {
  const { state } = setupCacheTest(t);
  await post(call(1, "0x8da5cb5b"));
  const res = await post(call(2, "0x8da5cb5b"), "https://evil.example");
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.cacheHeader, null);
  assert.equal(state.upstreamCalls.length, 1);
});
