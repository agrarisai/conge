// Unit tests for scoring.js, using Node's built-in test runner (no npm
// dependency needed, in keeping with this project's no-build-step setup).
//
// Run with:  node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEVERITY,
  THRESHOLDS,
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  isBurnOrZeroAddress,
  computeHolderPercentage,
  formatCount,
  addThousandsSeparators,
  formatPriceUsd,
  formatCompactUsd,
  scoreVerification,
  scoreHolderConcentration,
  scoreHolderCount,
  scoreTokenAge,
  detectAbiPrivileges,
  abiLooksLikeProxy,
  scoreProxyUpgrade,
  scoreOwnerPrivileges,
  scoreOwnerStatus,
  scoreMarketData,
  computeOverallLevel,
  scoreToken,
} from "../scoring.js";

// --- isBurnOrZeroAddress / computeHolderPercentage --------------------

test("isBurnOrZeroAddress recognizes the zero and dead addresses, case-insensitively", () => {
  assert.equal(isBurnOrZeroAddress(ZERO_ADDRESS), true);
  assert.equal(isBurnOrZeroAddress(ZERO_ADDRESS.toUpperCase().replace("0X", "0x")), true);
  assert.equal(isBurnOrZeroAddress(DEAD_ADDRESS), true);
  assert.equal(isBurnOrZeroAddress("0x000000000000000000000000000000000000dEaD"), true);
  assert.equal(isBurnOrZeroAddress("0x1111111111111111111111111111111111111a"), false);
  assert.equal(isBurnOrZeroAddress(null), false);
});

test("computeHolderPercentage computes exact percentages for large integers", () => {
  assert.equal(computeHolderPercentage("500000000000000000000", "1000000000000000000000"), 50);
  assert.equal(computeHolderPercentage("1", "3"), 33.333333);
  assert.equal(computeHolderPercentage("0", "1000"), 0);
  assert.equal(computeHolderPercentage("100", "0"), 0);
});

// --- Number formatting -----------------------------------------------------

test("formatCount adds thousands separators", () => {
  assert.equal(formatCount(365893), "365,893");
  assert.equal(formatCount(2), "2");
  assert.equal(formatCount(1000000), "1,000,000");
});

test("addThousandsSeparators is precision-safe for huge decimal strings", () => {
  assert.equal(addThousandsSeparators("1000000.5"), "1,000,000.5");
  assert.equal(addThousandsSeparators("999"), "999");
  assert.equal(
    addThousandsSeparators("123456789012345678901234567890.123456789012345678"),
    "123,456,789,012,345,678,901,234,567,890.123456789012345678",
  );
});

test("formatPriceUsd uses sensible decimals for the value's magnitude", () => {
  assert.equal(formatPriceUsd(1.23456), "1.23");
  assert.equal(formatPriceUsd(0), "0.00");
  assert.equal(formatPriceUsd(0.05), "0.0500");
  assert.equal(formatPriceUsd(0.0000123), "0.0000123");
});

test("formatCompactUsd matches the product brief's examples", () => {
  assert.equal(formatCompactUsd(867_600_000), "867.6M");
  assert.equal(formatCompactUsd(3_240_000_000), "3.24B");
  assert.equal(formatCompactUsd(500), "500.00");
});

// --- Check 1: verification ----------------------------------------------

test("scoreVerification: unverified is a high finding", () => {
  const f = scoreVerification(false);
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.equal(f.known, true);
});

test("scoreVerification: verified is an info finding", () => {
  const f = scoreVerification(true);
  assert.equal(f.severity, SEVERITY.INFO);
});

test("scoreVerification: null is Unknown, not a pass", () => {
  const f = scoreVerification(null);
  assert.equal(f.known, false);
  assert.equal(f.severity, SEVERITY.INFO);
  assert.match(f.title, /unknown/i);
});

// --- Check 2: holder concentration ---------------------------------------

test("scoreHolderConcentration: unknown when holders or supply missing", () => {
  const [top1, top10] = scoreHolderConcentration(null, "1000");
  assert.equal(top1.known, false);
  assert.equal(top10.known, false);

  const [top1b] = scoreHolderConcentration([{ address: "0xabc", valueRaw: "1" }], null);
  assert.equal(top1b.known, false);
});

test("scoreHolderConcentration: top1 > 50% is high", () => {
  const holders = [
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "600" },
    { address: "0x2222222222222222222222222222222222222b", valueRaw: "400" },
  ];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.HIGH);
  assert.match(top1.title, /60%/);
  assert.match(top1.title, /high concentration/);
});

test("scoreHolderConcentration: top1 between 20% and 50% is medium", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "300" }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.MEDIUM);
  assert.match(top1.title, /30%/);
});

test("scoreHolderConcentration: matches the product brief's example almost exactly (12.6%, below the concern threshold)", () => {
  // Real-world USDG figures: top1 = 12.6%.
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "126" }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.INFO);
  assert.equal(top1.title, "Largest holder owns 12.6% of supply: below the concern threshold");
  // A passed check must never carry the warning explanation.
  assert.doesNotMatch(top1.detail, /coordinated selling|move the price sharply/i);
});

test("scoreHolderConcentration: zero and burn addresses are excluded from ranking", () => {
  const holders = [
    { address: ZERO_ADDRESS, valueRaw: "900" },
    { address: DEAD_ADDRESS, valueRaw: "50" },
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "30" },
    { address: "0x2222222222222222222222222222222222222b", valueRaw: "20" },
  ];
  // Excluding burn/zero, remaining holders sum to 50 out of 1000 total
  // supply; top1 = 30/1000 = 3%, well under any threshold.
  const [top1, top10] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.INFO);
  assert.match(top1.title, /3%/);
  assert.equal(top10.severity, SEVERITY.INFO);
});

test("scoreHolderConcentration: top10 > 80% is medium", () => {
  const holders = Array.from({ length: 10 }, (_, i) => ({
    address: `0x${(i + 1).toString().padStart(40, "1")}`,
    valueRaw: "90",
  }));
  const [, top10] = scoreHolderConcentration(holders, "1000");
  assert.equal(top10.severity, SEVERITY.MEDIUM);
});

test("scoreHolderConcentration: top10 just under the concern threshold (50.1%) is not called 'well distributed'", () => {
  // A single holder at 50.1% is deliberately unrealistic for a *real*
  // top-10 spread, but it's the simplest way to land just under the 80%
  // threshold and pin the exact wording for that boundary.
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "501" }];
  const [, top10] = scoreHolderConcentration(holders, "1000");
  assert.equal(top10.severity, SEVERITY.INFO);
  assert.equal(top10.title, "Top 10 holders own 50.1% of supply: below the concern threshold");
  assert.doesNotMatch(top10.title, /well distributed/);
  assert.doesNotMatch(top10.detail, /well distributed/);
});

test("scoreHolderConcentration: merges top1 and top10 into one finding when both are medium", () => {
  const holders = [
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "300" },
    ...Array.from({ length: 9 }, (_, i) => ({
      address: "0x" + (100 + i).toString(16).padStart(40, "0"),
      valueRaw: "60",
    })),
  ];
  // top1 = 300/1000 = 30% (medium, >20%); top10 = (300 + 9*60)/1000 = 84% (medium, >80%).
  const findings = scoreHolderConcentration(holders, "1000");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "holder-concentration");
  assert.equal(findings[0].severity, SEVERITY.MEDIUM);
  assert.match(findings[0].title, /30%/);
  assert.match(findings[0].title, /84%/);
});

test("scoreHolderConcentration: does not merge when severities differ (high top1, medium top10)", () => {
  const holders = [
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "600" },
    { address: "0x2222222222222222222222222222222222222b", valueRaw: "400" },
  ];
  const findings = scoreHolderConcentration(holders, "1000");
  assert.equal(findings.length, 2);
  assert.equal(findings[0].id, "holder-top1");
  assert.equal(findings[1].id, "holder-top10");
});

test("scoreHolderConcentration: does not merge two clean (info) findings — nothing was exceeded", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "50" }];
  const findings = scoreHolderConcentration(holders, "1000");
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, SEVERITY.INFO);
  assert.equal(findings[1].severity, SEVERITY.INFO);
});

test("scoreHolderConcentration: notes when the largest holder is tagged as a contract", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "300", isContract: true }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.match(top1.detail, /tagged as a contract/i);
  assert.match(top1.detail, /pool, bridge, or vault/i);
});

test("scoreHolderConcentration: says nothing about contracts when the API didn't provide that data", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "300" }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.doesNotMatch(top1.detail, /contract/i);
});

test("scoreHolderConcentration: counts how many of the top 10 are tagged as contracts", () => {
  const holders = [
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "10", isContract: true },
    { address: "0x2222222222222222222222222222222222222b", valueRaw: "10", isContract: true },
    { address: "0x3333333333333333333333333333333333333c", valueRaw: "10", isContract: false },
  ];
  const [, top10] = scoreHolderConcentration(holders, "1000");
  assert.match(top10.detail, /2 of the top 3 holders are tagged as a contract/i);
});

// --- Check 3: holder count ------------------------------------------------

test("scoreHolderCount thresholds", () => {
  assert.equal(scoreHolderCount(null).known, false);
  assert.equal(scoreHolderCount(5).severity, SEVERITY.HIGH);
  assert.equal(scoreHolderCount(9).severity, SEVERITY.HIGH);
  assert.equal(scoreHolderCount(10).severity, SEVERITY.MEDIUM);
  assert.equal(scoreHolderCount(99).severity, SEVERITY.MEDIUM);
  assert.equal(scoreHolderCount(100).severity, SEVERITY.INFO);
  assert.equal(scoreHolderCount(10000).severity, SEVERITY.INFO);
});

test("scoreHolderCount: matches the product brief's example exactly (365,893 holders: wide distribution)", () => {
  const f = scoreHolderCount(365893);
  assert.equal(f.title, "365,893 holders: wide distribution");
  // A passed check must never carry the warning explanation.
  assert.doesNotMatch(f.detail, /thinly distributed|moved by a small number/i);
});

test("scoreHolderCount: a warning finding never uses the passed check's wording", () => {
  const f = scoreHolderCount(2);
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.match(f.title, /very few holders/i);
  assert.doesNotMatch(f.detail, /wide distribution|enough independent holders/i);
});

// --- Check 4: token age ----------------------------------------------------

test("scoreTokenAge thresholds", () => {
  const now = new Date("2024-01-08T00:00:00Z");

  assert.equal(scoreTokenAge(null, now).known, false);
  assert.equal(scoreTokenAge("not-a-date", now).known, false);

  const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
  assert.equal(scoreTokenAge(oneHourAgo, now).severity, SEVERITY.HIGH);

  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(scoreTokenAge(threeDaysAgo, now).severity, SEVERITY.MEDIUM);

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(scoreTokenAge(thirtyDaysAgo, now).severity, SEVERITY.INFO);

  const exactlyTwentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(scoreTokenAge(exactlyTwentyFourHoursAgo, now).severity, SEVERITY.MEDIUM);
});

test("scoreTokenAge: matches the product brief's example exactly (139 days ago: established)", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const createdAtIso = new Date(now.getTime() - 139 * 24 * 60 * 60 * 1000).toISOString();
  const f = scoreTokenAge(createdAtIso, now);
  assert.equal(f.severity, SEVERITY.INFO);
  assert.equal(f.title, "Deployed 139 days ago: established");
  // A passed check must never carry the warning explanation.
  assert.doesNotMatch(f.detail, /scammers|short track record/i);
});

test("scoreTokenAge: a warning finding never uses the passed check's wording", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const f = scoreTokenAge(oneHourAgo, now);
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.doesNotMatch(f.detail, /established|already surfaced/i);
});

// --- Check 5a: proxy upgrade -------------------------------------------

test("scoreProxyUpgrade: not a proxy produces no finding", () => {
  assert.equal(scoreProxyUpgrade({ isProxy: false, isVerified: true }), null);
  assert.equal(scoreProxyUpgrade({ isProxy: null, isVerified: true }), null);
});

test("scoreProxyUpgrade: unverified proxy is High regardless of admin info", () => {
  const f = scoreProxyUpgrade({ isProxy: true, isVerified: false });
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.match(f.detail, /not verified/i);
});

test("scoreProxyUpgrade: verified proxy with no admin info is Medium, not High", () => {
  const f = scoreProxyUpgrade({ isProxy: true, isVerified: true });
  assert.equal(f.severity, SEVERITY.MEDIUM);
  assert.match(f.detail, /common for regulated or compliance-driven tokens/i);
});

test("scoreProxyUpgrade: verified proxy with a contract admin stays Medium", () => {
  const f = scoreProxyUpgrade({
    isProxy: true,
    isVerified: true,
    proxyAdmin: "0x1111111111111111111111111111111111111a",
    proxyAdminIsContract: true,
  });
  assert.equal(f.severity, SEVERITY.MEDIUM);
  assert.match(f.detail, /\(a contract\)/);
});

test("scoreProxyUpgrade: verified proxy with a confirmed wallet admin is raised to High", () => {
  const f = scoreProxyUpgrade({
    isProxy: true,
    isVerified: true,
    proxyAdmin: "0x1111111111111111111111111111111111111a",
    proxyAdminIsContract: false,
  });
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.match(f.detail, /plain wallet address/i);
  assert.match(f.detail, /\(a plain wallet address\)/);
});

test("scoreProxyUpgrade: never escalates on an unconfirmed (unknown) admin type", () => {
  const f = scoreProxyUpgrade({
    isProxy: true,
    isVerified: true,
    proxyAdmin: "0x1111111111111111111111111111111111111a",
    proxyAdminIsContract: undefined,
  });
  assert.equal(f.severity, SEVERITY.MEDIUM);
});

// --- Check 5b: ABI-detected owner privileges --------------------------

test("detectAbiPrivileges matches expected function-name patterns (proxy upgrade excluded)", () => {
  const abi = [
    { type: "function", name: "mint" },
    { type: "function", name: "transfer" },
    { type: "function", name: "setBuyFee" },
    { type: "function", name: "setMaxWalletAmount" },
    { type: "function", name: "upgradeTo" },
    { type: "event", name: "mintEvent" }, // events should be ignored
  ];
  const detected = detectAbiPrivileges(abi);
  const keys = detected.map((d) => d.key).sort();
  assert.deepEqual(keys, ["fee", "maxTxWallet", "mint"]);
});

test("abiLooksLikeProxy detects an upgradeTo-style function", () => {
  assert.equal(abiLooksLikeProxy([{ type: "function", name: "upgradeTo" }]), true);
  assert.equal(abiLooksLikeProxy([{ type: "function", name: "upgradeToAndCall" }]), true);
  assert.equal(abiLooksLikeProxy([{ type: "function", name: "transfer" }]), false);
  assert.equal(abiLooksLikeProxy(null), false);
});

test("scoreOwnerPrivileges: unverified, not a proxy — Unknown, not a pass", () => {
  const findings = scoreOwnerPrivileges({ isVerified: false, abi: null, isProxy: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].known, false);
});

test("scoreOwnerPrivileges: unverified proxy shows BOTH the High proxy finding and the ABI-unknown finding", () => {
  const findings = scoreOwnerPrivileges({ isVerified: false, abi: null, isProxy: true });
  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byId["owner-privilege-proxyUpgrade"].severity, SEVERITY.HIGH);
  assert.equal(byId["owner-privileges-abi"].known, false);
});

test("scoreOwnerPrivileges: verified with no matches and no proxy is a clean info finding", () => {
  const abi = [{ type: "function", name: "transfer" }];
  const findings = scoreOwnerPrivileges({ isVerified: true, abi, isProxy: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.INFO);
  assert.equal(findings[0].known, true);
});

test("scoreOwnerPrivileges: mint is medium, verified proxy upgrade is medium (not high)", () => {
  const abi = [
    { type: "function", name: "mint" },
    { type: "function", name: "upgradeTo" },
  ];
  const findings = scoreOwnerPrivileges({ isVerified: true, abi, isProxy: true });
  const byKey = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byKey["owner-privilege-mint"].severity, SEVERITY.MEDIUM);
  assert.equal(byKey["owner-privilege-proxyUpgrade"].severity, SEVERITY.MEDIUM);
});

test("scoreOwnerPrivileges: an ABI upgradeTo function implies a proxy even if proxy_type wasn't set", () => {
  const abi = [{ type: "function", name: "upgradeTo" }];
  const findings = scoreOwnerPrivileges({ isVerified: false, abi: null, isProxy: false });
  // isProxy is false and abi wasn't readable (unverified) here, so no proxy
  // finding is expected from THIS call; re-check with a verified+ABI case:
  const verifiedFindings = scoreOwnerPrivileges({ isVerified: true, abi, isProxy: false });
  const byId = Object.fromEntries(verifiedFindings.map((f) => [f.id, f]));
  assert.ok(byId["owner-privilege-proxyUpgrade"]);
  assert.equal(byId["owner-privilege-proxyUpgrade"].severity, SEVERITY.MEDIUM);
  assert.equal(findings.length, 1); // sanity check on the unrelated first call
});

// --- Check 6: owner status ---------------------------------------------

test("scoreOwnerStatus", () => {
  const unknown = scoreOwnerStatus(null);
  assert.equal(unknown.known, false);
  assert.doesNotMatch(unknown.detail, /RPC/i);

  assert.match(scoreOwnerStatus(ZERO_ADDRESS).title, /renounced/i);
  assert.match(scoreOwnerStatus("0x1111111111111111111111111111111111111a").title, /Owned by/);
});

// --- Check 7: market data --------------------------------------------------

test("scoreMarketData never affects the overall level", () => {
  const known = scoreMarketData({ priceUsd: "1.23" });
  const unknown = scoreMarketData({});
  assert.equal(known.countsTowardLevel, false);
  assert.equal(unknown.countsTowardLevel, false);
  assert.equal(unknown.known, false);
});

test("scoreMarketData formats compact USD for volume/market cap and sensible decimals for price", () => {
  const f = scoreMarketData({ priceUsd: 1.0025, volume24hUsd: 867_600_000, marketCapUsd: 3_240_000_000 });
  assert.match(f.detail, /\$1\.00/);
  assert.match(f.detail, /\$867\.6M/);
  assert.match(f.detail, /\$3\.24B/);
});

// --- Aggregation -------------------------------------------------------

test("computeOverallLevel: Insufficient data when nothing is known", () => {
  const findings = [
    { severity: SEVERITY.INFO, known: false, countsTowardLevel: true },
    { severity: SEVERITY.INFO, known: false, countsTowardLevel: false },
  ];
  assert.equal(computeOverallLevel(findings), "Insufficient data");
});

test("computeOverallLevel: worst known severity wins", () => {
  const findings = [
    { severity: SEVERITY.INFO, known: true, countsTowardLevel: true },
    { severity: SEVERITY.MEDIUM, known: true, countsTowardLevel: true },
    { severity: SEVERITY.HIGH, known: false, countsTowardLevel: true }, // unknown, ignored
  ];
  assert.equal(computeOverallLevel(findings), "Medium");
});

test("computeOverallLevel: all-info-known maps to Low, never a 'safe' word", () => {
  const findings = [
    { severity: SEVERITY.INFO, known: true, countsTowardLevel: true },
    { severity: SEVERITY.INFO, known: true, countsTowardLevel: true },
  ];
  assert.equal(computeOverallLevel(findings), "Low");
});

test("computeOverallLevel: market-data-only findings don't count toward the verdict", () => {
  const findings = [{ severity: SEVERITY.HIGH, known: true, countsTowardLevel: false }];
  assert.equal(computeOverallLevel(findings), "Insufficient data");
});

// --- scoreToken end-to-end ------------------------------------------------

test("scoreToken: a well-behaved, established token scores Low with no unverified/high findings", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const facts = {
    isVerified: true,
    abi: [{ type: "function", name: "transfer" }],
    isProxy: false,
    holders: [
      { address: "0x1111111111111111111111111111111111111a", valueRaw: "50" },
      { address: "0x2222222222222222222222222222222222222b", valueRaw: "50" },
    ],
    totalSupplyRaw: "10000",
    holdersCount: 500,
    createdAtIso: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    owner: ZERO_ADDRESS,
    marketData: { priceUsd: "0.01", volume24hUsd: "1000", marketCapUsd: "100000" },
    now,
  };
  const { overallLevel, findings } = scoreToken(facts);
  assert.equal(overallLevel, "Low");
  assert.equal(
    findings.some((f) => f.severity === SEVERITY.HIGH && f.known),
    false,
  );
});

test("scoreToken: a fresh, unverified, concentrated token scores High", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const facts = {
    isVerified: false,
    abi: null,
    isProxy: null,
    holders: [
      { address: "0x1111111111111111111111111111111111111a", valueRaw: "900" },
      { address: "0x2222222222222222222222222222222222222b", valueRaw: "100" },
    ],
    totalSupplyRaw: "1000",
    holdersCount: 4,
    createdAtIso: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    owner: null,
    marketData: {},
    now,
  };
  const { overallLevel } = scoreToken(facts);
  assert.equal(overallLevel, "High");
});

test("scoreToken: completely empty facts is Insufficient data, never a false Low", () => {
  const { overallLevel } = scoreToken({ now: new Date() });
  assert.equal(overallLevel, "Insufficient data");
});

// --- Real-world-shaped fixtures (task-required) -----------------------------

// A USDG-like token: verified, upgradeable proxy (common for regulated
// stablecoins), 365,893 holders, deployed 139 days ago, top holder 12.6%,
// top 10 = 50%. None of that should read as High on its own — a verified
// proxy is Medium at worst here, per scoreProxyUpgrade's rule.
test("scoreToken: a USDG-like fixture (verified, proxy, 12.6%/50% concentration, 365,893 holders, 139 days old) scores Medium at most", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  // Top holder = 12.6% of supply; next 9 holders split the remaining
  // 37.4 points of the 50% top-10 figure roughly evenly.
  // 9 filler holders whose integer raw balances sum to 374 (so top 10,
  // including the 126 top holder, comes to exactly 500 -> 50%).
  const fillerBalances = [42, 42, 42, 42, 42, 41, 41, 41, 41];
  const holders = [
    { address: "0x1111111111111111111111111111111111111a", valueRaw: "126", isContract: true }, // e.g. a reserve/treasury contract
    ...fillerBalances.map((balance, i) => ({
      address: "0x" + (200 + i).toString(16).padStart(40, "0"),
      valueRaw: String(balance),
    })),
  ];
  const facts = {
    isVerified: true,
    abi: [
      { type: "function", name: "transfer" },
      { type: "function", name: "mint" }, // compliant stablecoins commonly have controlled minting
      { type: "function", name: "pause" },
      { type: "function", name: "blacklist" },
      { type: "function", name: "upgradeTo" },
    ],
    isProxy: true,
    proxyAdmin: null, // admin address/type not confirmed — must not escalate to High on a guess
    proxyAdminIsContract: undefined,
    holders,
    totalSupplyRaw: "1000",
    holdersCount: 365893,
    createdAtIso: new Date(now.getTime() - 139 * 24 * 60 * 60 * 1000).toISOString(),
    owner: "0x9999999999999999999999999999999999999999",
    marketData: { priceUsd: "1.00", volume24hUsd: 867_600_000, marketCapUsd: 3_240_000_000 },
    now,
  };

  const { overallLevel, findings } = scoreToken(facts);

  assert.equal(overallLevel, "Medium");
  assert.equal(
    findings.some((f) => f.severity === SEVERITY.HIGH && f.known),
    false,
    "a verified proxy with no confirmed wallet-admin must never push a USDG-shaped token to High",
  );

  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byId["owner-privilege-proxyUpgrade"].severity, SEVERITY.MEDIUM);
  assert.equal(byId["holder-count"].severity, SEVERITY.INFO);
  assert.match(byId["holder-count"].title, /365,893 holders: wide distribution/);
  assert.equal(byId["token-age"].severity, SEVERITY.INFO);
  assert.match(byId["token-age"].title, /139 days ago: established/);
  assert.equal(byId["holder-top1"].severity, SEVERITY.INFO);
  assert.match(byId["holder-top1"].title, /12\.6%/);
});

// An Agraris-like token: unverified, a single holder owns 100% of supply,
// only 2 holders total. Every relevant signal points the same way, so this
// must score High through multiple independent findings, not just because
// verification alone is High.
test("scoreToken: an Agraris-like fixture (unverified, 100% one holder, 2 holders) scores High", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const facts = {
    isVerified: false,
    abi: null,
    isProxy: false,
    holders: [
      { address: "0x1111111111111111111111111111111111111a", valueRaw: "1000" },
      { address: "0x2222222222222222222222222222222222222b", valueRaw: "0" },
    ],
    totalSupplyRaw: "1000",
    holdersCount: 2,
    createdAtIso: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    owner: "0x3333333333333333333333333333333333333c",
    marketData: {},
    now,
  };

  const { overallLevel, findings } = scoreToken(facts);
  assert.equal(overallLevel, "High");

  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byId["verification"].severity, SEVERITY.HIGH);
  assert.equal(byId["holder-top1"].severity, SEVERITY.HIGH);
  assert.match(byId["holder-top1"].title, /100%/);
  assert.equal(byId["holder-count"].severity, SEVERITY.HIGH);
});
