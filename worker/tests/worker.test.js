// Unit tests for the pure validation/CORS logic in worker/index.js.
// No network — these never call the real upstream or run inside the
// Workers runtime, just plain Node (node --test), same setup as the main
// project's tests/scoring.test.js.
//
// Run with:  node --test worker/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ORIGINS,
  ALLOWED_METHODS,
  isAllowedOrigin,
  buildCorsHeaders,
  jsonRpcError,
  validateParams,
  validateRequest,
  parseBatch,
} from "../index.js";

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
