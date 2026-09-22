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
} from "../index.js";

const SITE_ORIGIN = "https://agrarisai.github.io";
const WORKER_URL = "https://conge-rpc.agrarisai.workers.dev/";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// --- Config sanity -----------------------------------------------------

test("ALLOWED_ORIGINS is exactly the site, no wildcard", () => {
  assert.deepEqual(ALLOWED_ORIGINS, ["https://agrarisai.github.io"]);
});

test("ALLOWED_METHODS is exactly the four read-only methods", () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode"].sort());
});

// --- CORS ----------------------------------------------------------------

test("isAllowedOrigin: only the configured origin passes", () => {
  assert.equal(isAllowedOrigin("https://agrarisai.github.io"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin("http://agrarisai.github.io"), false); // wrong scheme
  assert.equal(isAllowedOrigin(null), false);
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin(""), false);
});

test("buildCorsHeaders: allowed origin gets echoed back with no wildcard anywhere", () => {
  const headers = buildCorsHeaders("https://agrarisai.github.io");
  assert.ok(headers);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://agrarisai.github.io");
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
      : { jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] },
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

// --- Upstream rate-limit retry ---------------------------------------------
//
// The shared upstream RPC rate-limits (429) or is briefly overloaded (503)
// under load. callUpstream (internal, not exported — network code isn't
// unit-tested directly elsewhere in this file either) retries with backoff
// before giving up; these tests drive it the same way as the CORS/POST
// tests above, through the real `fetch(request)` entry point, so what's
// verified is the Worker's actual end-to-end behavior.

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

test("upstream 429 on every attempt: the Worker gives up after 3 tries and returns a clearly-labeled 502", async (t) => {
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

  assert.equal(callCount, 3, "should try 3 times total before giving up");
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.kind, "upstream-rate-limited");
  assert.match(body.detail, /rate limited/i);
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
