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
  scoreVerification,
  scoreHolderConcentration,
  scoreHolderCount,
  scoreTokenAge,
  detectOwnerPrivileges,
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
});

test("scoreHolderConcentration: top1 between 20% and 50% is medium", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "300" }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.MEDIUM);
  assert.match(top1.title, /30%/);
});

test("scoreHolderConcentration: top1 at exactly 20% is info (strictly greater-than threshold)", () => {
  const holders = [{ address: "0x1111111111111111111111111111111111111a", valueRaw: "200" }];
  const [top1] = scoreHolderConcentration(holders, "1000");
  assert.equal(top1.severity, SEVERITY.INFO);
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

// --- Check 5: owner privileges ---------------------------------------------

test("detectOwnerPrivileges matches expected function-name patterns", () => {
  const abi = [
    { type: "function", name: "mint" },
    { type: "function", name: "transfer" },
    { type: "function", name: "setBuyFee" },
    { type: "function", name: "setMaxWalletAmount" },
    { type: "event", name: "mintEvent" }, // events should be ignored
  ];
  const detected = detectOwnerPrivileges(abi, false);
  const keys = detected.map((d) => d.key).sort();
  assert.deepEqual(keys, ["fee", "maxTxWallet", "mint"]);
});

test("detectOwnerPrivileges flags proxies even without an upgradeTo function", () => {
  const detected = detectOwnerPrivileges([], true);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].key, "proxyUpgrade");
});

test("scoreOwnerPrivileges: unverified/no ABI is Unknown, not a pass", () => {
  const findings = scoreOwnerPrivileges({ isVerified: false, abi: null, isProxy: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].known, false);
});

test("scoreOwnerPrivileges: verified with no matches is a clean info finding", () => {
  const abi = [{ type: "function", name: "transfer" }];
  const findings = scoreOwnerPrivileges({ isVerified: true, abi, isProxy: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.INFO);
  assert.equal(findings[0].known, true);
});

test("scoreOwnerPrivileges: mint is medium, proxy upgrade is high", () => {
  const abi = [
    { type: "function", name: "mint" },
    { type: "function", name: "upgradeTo" },
  ];
  const findings = scoreOwnerPrivileges({ isVerified: true, abi, isProxy: true });
  const byKey = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byKey["owner-privilege-mint"].severity, SEVERITY.MEDIUM);
  assert.equal(byKey["owner-privilege-proxyUpgrade"].severity, SEVERITY.HIGH);
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
