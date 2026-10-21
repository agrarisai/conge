// WCAG 2.x contrast audit for Conge's real text/background pairings.
// Reads the color tokens straight from style.css's :root, so it always
// reflects the current CSS. No browser, no dependencies:
//
//   node scripts/contrast-audit.mjs            # table
//   node scripts/contrast-audit.mjs --markdown # same, as a Markdown table
//
// Exit code 1 if any required pairing fails its threshold.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const tokens = {};
for (const m of root.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
const resolve = (v) => {
  let out = v;
  for (let i = 0; i < 5 && /var\(--/.test(out); i++) {
    out = out.replace(/var\(--([\w-]+)\)/g, (_, n) => tokens[n] ?? "");
  }
  return out;
};
const T = (name) => resolve(`var(--${name})`);

const hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
// fg at `alpha` over bg → the color actually seen.
const over = (fg, alpha, bg) => {
  const [a, b] = [hexToRgb(fg), hexToRgb(bg)];
  return "#" + a.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
};
const lum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const IVORY = T("color-bg");
const WHITE = T("color-surface");
// The debug overlay is rgb(0 0 0 / 86%) over whatever is behind it; the
// lightest thing behind it is the white card, so that's the worst case.
const DEBUG_BG = over("#000000", 0.86, WHITE);
// The hero ring texture draws --color-border lines on ivory behind the intro
// text, so text crossing a ring line sits on --color-border.
const RING = T("color-border");

// kind: "text" (4.5:1), "large" (3:1 — ≥24px, or ≥18.66px bold),
//       "ui" (3:1 non-text: focus rings, required graphics),
//       "info" (reported only — supplementary/decorative/unused; see note).
const rows = [
  // Body + secondary text
  ["Body text (ink) on ivory page", T("color-ink"), IVORY, "text"],
  ["Body text (ink) on white card", T("color-ink"), WHITE, "text"],
  ["Secondary text (slate) on ivory page", T("color-slate"), IVORY, "text"],
  ["Secondary text (slate) on white card", T("color-slate"), WHITE, "text"],
  ["Hero: ink text over a ring-texture line", T("color-ink"), RING, "text"],
  ["Hero: slate intro text over a ring-texture line", T("color-slate"), RING, "text"],
  // Footer
  ["Footer brand / links (ink) on ivory — default", T("color-ink"), IVORY, "text"],
  ["Footer links on hover/focus (ink text; underline is decoration)", T("color-ink"), IVORY, "text"],
  ["Footer link hover/focus underline (accent) vs ivory", T("color-accent"), IVORY, "ui"],
  ["Footer description / headings / fine print (slate) on ivory", T("color-slate"), IVORY, "text"],
  ["Footer fine-print + 'Full disclaimer' links (accent-text) on ivory", T("color-accent-text"), IVORY, "text"],
  // Gauge + verdict
  ["Verdict 'Low' (green text, 22px bold) on white card", T("tone-green-text"), WHITE, "large"],
  ["Verdict 'Medium' (amber text, 22px bold) on white card", T("tone-amber-text"), WHITE, "large"],
  ["Verdict 'High' (rose text, 22px bold) on white card", T("tone-rose-text"), WHITE, "large"],
  ["Verdict 'Low' on ivory page", T("tone-green-text"), IVORY, "large"],
  ["Verdict 'Medium' on ivory page", T("tone-amber-text"), IVORY, "large"],
  ["Verdict 'High' on ivory page", T("tone-rose-text"), IVORY, "large"],
  ["Verdict 'Low' text vs its zone color", T("tone-green-text"), T("tone-green-border"), "info"],
  ["Verdict 'Medium' text vs its zone color", T("tone-amber-text"), T("tone-amber-border"), "info"],
  ["Verdict 'High' text vs its zone color", T("tone-rose-text"), T("tone-rose-border"), "info"],
  ["'Insufficient data' / 'Finalizing…' (slate) on white card", T("color-slate"), WHITE, "text"],
  ["'RISK LEVEL' label (slate, 12px) on white card", T("color-slate"), WHITE, "text"],
  ["Gauge needle + hub (accent) on white card", T("color-accent"), WHITE, "ui"],
  ["Gauge needle + hub (accent) on ivory page", T("color-accent"), IVORY, "ui"],
  ["Gauge zone: low (green) on white card", T("tone-green-border"), WHITE, "info"],
  ["Gauge zone: medium (amber) on white card", T("tone-amber-border"), WHITE, "info"],
  ["Gauge zone: high (rose) on white card", T("tone-rose-border"), WHITE, "info"],
  ["Gauge zone: low (green) on ivory page", T("tone-green-border"), IVORY, "info"],
  ["Gauge zone: medium (amber) on ivory page", T("tone-amber-border"), IVORY, "info"],
  ["Gauge zone: high (rose) on ivory page", T("tone-rose-border"), IVORY, "info"],
  // Findings (signal list): text is ink/slate on the white card in every
  // severity; severity is carried by the group heading text + marker.
  ["Finding title (ink) on white card — every severity", T("color-ink"), WHITE, "text"],
  ["Finding detail (slate) on white card — every severity", T("color-slate"), WHITE, "text"],
  ["Finding group heading (slate, bold) on white card", T("color-slate"), WHITE, "text"],
  ["'Technical details' summary (ink at 85% opacity) on white card", over(T("color-ink"), 0.85, WHITE), WHITE, "text"],
  ["Severity marker: high (rose) on white card", T("tone-rose-border"), WHITE, "info"],
  ["Severity marker: medium (amber) on white card", T("tone-amber-border"), WHITE, "info"],
  ["Severity marker: low (green) on white card", T("tone-green-border"), WHITE, "info"],
  ["Severity marker: passed (neutral) on white card", T("tone-neutral-border"), WHITE, "info"],
  ["Severity marker: unknown on white card", T("tone-unknown-border"), WHITE, "info"],
  // Severity tint tokens: defined, only the rose pair is rendered (error box).
  ["Error message: rose text on rose tint", T("tone-rose-text"), T("tone-rose-bg"), "text"],
  ["High tint pair (rose text on rose tint)", T("tone-rose-text"), T("tone-rose-bg"), "text"],
  ["Medium tint pair (amber text on amber tint) — token, not rendered", T("tone-amber-text"), T("tone-amber-bg"), "text"],
  ["Low tint pair (green text on green tint) — token, not rendered", T("tone-green-text"), T("tone-green-bg"), "text"],
  ["Passed tint pair (neutral text on neutral tint) — token, not rendered", T("tone-neutral-text"), T("tone-neutral-bg"), "text"],
  ["Info/unknown tint pair (unknown text on unknown tint) — token, not rendered", T("tone-unknown-text"), T("tone-unknown-bg"), "text"],
  ["'Connection failed' status (rose text) on white card", T("tone-rose-text"), WHITE, "text"],
  // Blue accent
  ["Raw accent #0B84F3 as text on ivory (not used as text)", T("color-accent"), IVORY, "info"],
  ["Raw accent #0B84F3 as text on white (not used as text)", T("color-accent"), WHITE, "info"],
  ["Link/text-button text (accent-text) on ivory", T("color-accent-text"), IVORY, "text"],
  ["Link/text-button text (accent-text) on white card", T("color-accent-text"), WHITE, "text"],
  ["Primary button label (accent-ink) on accent background", T("color-accent-ink"), T("color-accent"), "text"],
  ["Primary button background (accent) vs white card", T("color-accent"), WHITE, "ui"],
  ["Focus ring (accent) on ivory", T("color-accent"), IVORY, "ui"],
  ["Focus ring (accent) on white card", T("color-accent"), WHITE, "ui"],
  ["Secondary button label (ink) on white card", T("color-ink"), WHITE, "text"],
  // Navigation
  ["Menu: current page (accent-text) on panel (ivory)", T("color-accent-text"), IVORY, "text"],
  ["Menu: other links (ink) on panel (ivory)", T("color-ink"), IVORY, "text"],
  // Input
  ["Input text (ink) on input background (ivory)", T("color-ink"), IVORY, "text"],
  ["Input placeholder (slate, full opacity) on input background (ivory)", T("color-slate"), IVORY, "text"],
  ["Input border (border-strong) vs white card", T("color-border-strong"), WHITE, "info"],
  // Debug overlay
  ["Debug panel text (#f2f2f2) on its dark background (worst case: over white)", "#f2f2f2", DEBUG_BG, "text"],
  ["Debug panel column headers (#b8b8b8) on its dark background", "#b8b8b8", DEBUG_BG, "text"],
  ["Debug panel focus ring (#ffd54a) on its dark background", "#ffd54a", DEBUG_BG, "ui"],
];

const need = { text: 4.5, large: 3, ui: 3, info: 3 };
const label = { text: "AA text 4.5", large: "AA large 3.0", ui: "non-text 3.0", info: "info (3.0 ref)" };
let failed = 0;
const out = rows.map(([name, fg, bg, kind]) => {
  const r = ratio(fg, bg);
  const ok = r >= need[kind];
  if (!ok && kind !== "info") failed++;
  return { name, fg, bg, ratio: r.toFixed(2), threshold: label[kind], result: ok ? "pass" : kind === "info" ? "below (info)" : "FAIL" };
});

if (process.argv.includes("--markdown")) {
  console.log("| Pairing | Foreground | Background | Ratio | Threshold | Result |");
  console.log("|---|---|---|---|---|---|");
  for (const o of out) console.log(`| ${o.name} | \`${o.fg}\` | \`${o.bg}\` | ${o.ratio}:1 | ${o.threshold} | ${o.result} |`);
} else {
  console.table(out);
}
if (failed) {
  console.error(`${failed} required pairing(s) below threshold.`);
  process.exitCode = 1;
}
