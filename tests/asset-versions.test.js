// Fails when a page (or app.js) still points at an old ?v= of style.css or
// one of the site's scripts — i.e. someone edited the file but didn't run
// `node scripts/version-assets.mjs`. Stale versions are exactly how a phone
// ended up with new HTML and a cached old style.css.
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionAssets } from "../scripts/version-assets.mjs";

test("every CSS/JS reference carries the current content version", () => {
  assert.deepEqual(versionAssets({ check: true }), []);
});
