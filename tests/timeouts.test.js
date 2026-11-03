// The page's timeout for Worker requests must stay longer than the
// Worker's own upstream deadline, or the browser gives up ("signal is
// aborted without reason") while the Worker is still retrying. app.js
// can't be imported under Node (it loads viem from a CDN), so its
// constants are read from the source text.
//
// Run with:  node --test tests/timeouts.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UPSTREAM_TIMEOUT_MS } from "../worker/index.js";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function constantMs(name) {
  const m = appSource.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${name} not found in app.js`);
  // Only digits, underscores, + and other constants already resolved below.
  return m[1];
}

test("app.js mirrors the Worker's upstream deadline", () => {
  assert.equal(Number(constantMs("WORKER_UPSTREAM_DEADLINE_MS").replace(/_/g, "")), UPSTREAM_TIMEOUT_MS);
});

test("the page waits for Worker requests at least 3s longer than the Worker's own deadline", () => {
  const expr = constantMs("WORKER_FETCH_TIMEOUT_MS");
  const m = expr.match(/^WORKER_UPSTREAM_DEADLINE_MS \+ ([\d_]+)$/);
  assert.ok(m, `unexpected WORKER_FETCH_TIMEOUT_MS expression: ${expr}`);
  const margin = Number(m[1].replace(/_/g, ""));
  assert.ok(margin >= 3000, `margin ${margin}ms is too small`);
  assert.ok(UPSTREAM_TIMEOUT_MS + margin <= 15_000, "and not so long a dead Worker leaves the page hanging");
});

test("every Worker request in app.js uses the Worker timeout", () => {
  const workerCalls = appSource.match(/fetchRaw\(\s*WORKER_URL,[\s\S]*?\n\s*\)/g) ?? [];
  assert.ok(workerCalls.length >= 4, `expected the 4 Worker fetchRaw calls, found ${workerCalls.length}`);
  for (const c of workerCalls) assert.match(c, /timeoutMs: WORKER_FETCH_TIMEOUT_MS/);
});
