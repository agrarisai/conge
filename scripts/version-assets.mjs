// Cache-busting for the site's own CSS/JS — no build step, no dependencies.
//
// Every reference to style.css / nav.js / scroll-fx.js / faq.js / app.js in
// the HTML pages (and app.js's import of scoring.js) carries a ?v=<hash> of
// that file's current contents. When a file changes, its URL changes, so a
// browser or CDN can never pair new HTML with a stale cached copy of the old
// CSS/JS — which is exactly what showed the inline header nav as raw, blue,
// underlined links on phones: new HTML (with the nav) + cached old style.css
// (without the .header-nav rules that hide it).
//
//   node scripts/version-assets.mjs           # rewrite the ?v= values
//   node scripts/version-assets.mjs --check   # exit 1 if any are stale
//
// Run it (without --check) after editing any of those files; the test in
// tests/asset-versions.test.js fails until you do.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "about.html", "how-it-works.html", "faq.html", "disclaimer.html"];
// scoring.js before app.js: app.js's import of scoring.js carries scoring's
// version, so app.js's own hash must be taken after that's been written.
const ASSETS = ["style.css", "nav.js", "scroll-fx.js", "faq.js", "scoring.js", "app.js"];

const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const hashOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rewrites every `<attr>="<asset>[?v=…]"` (or the quoted import specifier
// "./<asset>[?v=…]") in `text` to point at `<asset>?v=<version>`.
function stamp(text, asset, version) {
  const ref = new RegExp(`((?:href|src)="|from "\\./)${escape(asset)}(?:\\?v=[0-9a-f]*)?"`, "g");
  return text.replace(ref, `$1${asset}?v=${version}"`);
}

export function versionAssets({ check = false } = {}) {
  const files = new Map(PAGES.concat("app.js").map((f) => [f, read(f)]));
  const stale = [];

  for (const asset of ASSETS) {
    // app.js may have just been re-stamped (its scoring.js import), so hash
    // the in-memory version, not the file on disk.
    const content = files.has(asset) ? files.get(asset) : read(asset);
    const version = hashOf(content);
    for (const [file, text] of files) {
      if (file === asset) continue;
      const next = stamp(text, asset, version);
      if (next !== text) {
        stale.push(`${file}: ${asset} → ?v=${version}`);
        files.set(file, next);
      }
    }
  }

  if (!check) {
    for (const [file, text] of files) {
      if (text !== read(file)) writeFileSync(path.join(ROOT, file), text);
    }
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = versionAssets({ check });
  if (check && stale.length) {
    console.error("Asset versions are out of date — run: node scripts/version-assets.mjs\n  " + stale.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(stale.length ? `Updated:\n  ${stale.join("\n  ")}` : "All asset versions are up to date.");
  }
}
