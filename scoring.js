// Risk Score v1 — pure, rule-based scoring. No network calls here: every
// function takes plain data ("facts") gathered elsewhere (see app.js) and
// returns findings. Every finding has a severity, a one-line title, and a
// "why it matters" detail. A check with no data returns a finding with
// known: false ("Unknown") — Unknown is never treated as a pass.
//
// Tune thresholds by editing THRESHOLDS below — nothing else needs to
// change. See tests/scoring.test.js for sample inputs/outputs.

export const SEVERITY = { INFO: "info", LOW: "low", MEDIUM: "medium", HIGH: "high" };

// Order matters for computeOverallLevel (highest wins) and for grouping
// findings in the UI (highest shown first).
export const SEVERITY_ORDER = [SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW, SEVERITY.INFO];

export const ZERO_ADDRESS = "0x" + "0".repeat(40);
// The "dead" address is a widely-used convention for burning tokens
// (sending them somewhere provably unspendable). Not a protocol-level
// standard like the zero address — just the most common one in practice.
export const DEAD_ADDRESS = "0x" + "0".repeat(36) + "dead";
export const BURN_ADDRESSES = [ZERO_ADDRESS, DEAD_ADDRESS];

export const THRESHOLDS = {
  // Fewer than this many findings with actual data (excluding info-only
  // display checks like market data) means the overall level is
  // "Insufficient data" rather than a real Low/Medium/High read.
  minKnownFindingsForVerdict: 1,

  holderConcentration: {
    // Percent of total supply, zero/burn addresses excluded from the ranking.
    top1: { highAbovePct: 50, mediumAbovePct: 20 },
    top10: { mediumAbovePct: 80 },
  },

  holderCount: {
    highBelow: 10,
    mediumBelow: 100,
  },

  tokenAgeHours: {
    highBelow: 24,
    mediumBelow: 24 * 7,
  },

  // Severity assigned to each owner-privilege category found in a
  // verified contract's ABI. Not specified numerically by the product
  // brief (unlike the checks above) — these are a reasonable starting
  // point, tune freely.
  ownerPrivilegeSeverity: {
    mint: SEVERITY.MEDIUM,
    pause: SEVERITY.MEDIUM,
    blacklist: SEVERITY.MEDIUM,
    fee: SEVERITY.MEDIUM,
    maxTxWallet: SEVERITY.LOW,
    proxyUpgrade: SEVERITY.HIGH,
  },
};

function finding({ id, severity, known = true, countsTowardLevel = true, title, detail }) {
  return { id, severity, known, countsTowardLevel, title, detail };
}

export function isBurnOrZeroAddress(address) {
  if (!address) return false;
  const lower = address.toLowerCase();
  return BURN_ADDRESSES.some((a) => a === lower);
}

// Percentage (0-100) of `totalSupplyRaw` that `holderValueRaw` represents,
// computed with integer (BigInt) math so it's exact regardless of how
// large the raw token amounts are. Both args are raw base-unit integer
// strings, e.g. "1000000000000000000".
export function computeHolderPercentage(holderValueRaw, totalSupplyRaw) {
  const holderValue = BigInt(holderValueRaw);
  const totalSupply = BigInt(totalSupplyRaw);
  if (totalSupply <= 0n) return 0;
  const PRECISION = 1_000_000n;
  const scaled = (holderValue * PRECISION * 100n) / totalSupply;
  return Number(scaled) / Number(PRECISION);
}

function formatPct(pct) {
  return (Math.round(pct * 10) / 10).toString();
}

function formatAge(ageHours) {
  if (ageHours < 48) {
    const hours = Math.max(0, Math.round(ageHours));
    return `Deployed ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(ageHours / 24);
  return `Deployed ${days} day${days === 1 ? "" : "s"} ago`;
}

// --- Check 1: source verification ---------------------------------------

export function scoreVerification(isVerified) {
  if (isVerified === null || isVerified === undefined) {
    return finding({
      id: "verification",
      known: false,
      severity: SEVERITY.INFO,
      title: "Verification status unknown",
      detail: "Could not determine whether the contract's source code is verified.",
    });
  }
  if (isVerified === false) {
    return finding({
      id: "verification",
      severity: SEVERITY.HIGH,
      title: "Source code not verified",
      detail:
        "The contract's source code has not been published/verified. The owner-privilege and ABI-based checks below cannot run, and the token's real behavior cannot be confirmed independently.",
    });
  }
  return finding({
    id: "verification",
    severity: SEVERITY.INFO,
    title: "Source code verified",
    detail: "The contract's source code is published and verified on the block explorer.",
  });
}

// --- Check 2: holder concentration ---------------------------------------

// holders: array of { address, valueRaw } (raw base-unit balance strings),
// or null/undefined if unavailable. totalSupplyRaw: raw base-unit string.
export function scoreHolderConcentration(holders, totalSupplyRaw, thresholds = THRESHOLDS) {
  const cfg = thresholds.holderConcentration;
  const unknown = () => [
    finding({
      id: "holder-top1",
      known: false,
      severity: SEVERITY.INFO,
      title: "Top holder concentration unknown",
      detail: "Holder balances or total supply were not available to compute this.",
    }),
    finding({
      id: "holder-top10",
      known: false,
      severity: SEVERITY.INFO,
      title: "Top 10 holder concentration unknown",
      detail: "Holder balances or total supply were not available to compute this.",
    }),
  ];

  if (!Array.isArray(holders) || holders.length === 0 || totalSupplyRaw === null || totalSupplyRaw === undefined) {
    return unknown();
  }

  let ranked;
  try {
    ranked = holders
      .filter((h) => h && h.address && !isBurnOrZeroAddress(h.address))
      .map((h) => ({ address: h.address, percentage: computeHolderPercentage(h.valueRaw, totalSupplyRaw) }))
      .sort((a, b) => b.percentage - a.percentage);
  } catch {
    return unknown();
  }

  const top1Pct = ranked[0]?.percentage ?? 0;
  const top10Pct = ranked.slice(0, 10).reduce((sum, h) => sum + h.percentage, 0);

  const top1Severity =
    top1Pct > cfg.top1.highAbovePct ? SEVERITY.HIGH : top1Pct > cfg.top1.mediumAbovePct ? SEVERITY.MEDIUM : SEVERITY.INFO;
  const top10Severity = top10Pct > cfg.top10.mediumAbovePct ? SEVERITY.MEDIUM : SEVERITY.INFO;

  return [
    finding({
      id: "holder-top1",
      severity: top1Severity,
      title: `Top holder owns ${formatPct(top1Pct)}% of supply`,
      detail:
        "A single wallet controlling a large share of supply can move the price sharply on its own. Zero and burn addresses are excluded from this ranking.",
    }),
    finding({
      id: "holder-top10",
      severity: top10Severity,
      title: `Top 10 holders own ${formatPct(top10Pct)}% of supply`,
      detail:
        "Heavy concentration among a handful of wallets increases the risk of coordinated selling. Zero and burn addresses are excluded from this ranking.",
    }),
  ];
}

// --- Check 3: holder count -------------------------------------------------

export function scoreHolderCount(holdersCount, thresholds = THRESHOLDS) {
  if (holdersCount === null || holdersCount === undefined || Number.isNaN(Number(holdersCount))) {
    return finding({
      id: "holder-count",
      known: false,
      severity: SEVERITY.INFO,
      title: "Holder count unknown",
      detail: "The number of token holders was not available.",
    });
  }
  const count = Number(holdersCount);
  const cfg = thresholds.holderCount;
  const severity = count < cfg.highBelow ? SEVERITY.HIGH : count < cfg.mediumBelow ? SEVERITY.MEDIUM : SEVERITY.INFO;
  return finding({
    id: "holder-count",
    severity,
    title: `${count} holder${count === 1 ? "" : "s"}`,
    detail: "Very few holders means the token is thinly distributed and its price can be moved by a small number of wallets.",
  });
}

// --- Check 4: token age ----------------------------------------------------

export function scoreTokenAge(createdAtIso, now = new Date(), thresholds = THRESHOLDS) {
  if (!createdAtIso) {
    return finding({
      id: "token-age",
      known: false,
      severity: SEVERITY.INFO,
      title: "Token age unknown",
      detail: "The contract creation time could not be determined.",
    });
  }
  const createdAt = new Date(createdAtIso);
  if (Number.isNaN(createdAt.getTime())) {
    return finding({
      id: "token-age",
      known: false,
      severity: SEVERITY.INFO,
      title: "Token age unknown",
      detail: "The contract creation timestamp could not be parsed.",
    });
  }
  const ageHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
  const cfg = thresholds.tokenAgeHours;
  const severity = ageHours < cfg.highBelow ? SEVERITY.HIGH : ageHours < cfg.mediumBelow ? SEVERITY.MEDIUM : SEVERITY.INFO;
  return finding({
    id: "token-age",
    severity,
    title: formatAge(Math.max(0, ageHours)),
    detail: "Newly deployed tokens have a short track record, giving scammers less time to be caught before people buy in.",
  });
}

// --- Check 5: owner privileges (verified contracts only) -------------------

const PRIVILEGE_PATTERNS = [
  { key: "mint", label: "mint new tokens", pattern: /mint/i },
  { key: "pause", label: "pause transfers", pattern: /pause/i },
  { key: "blacklist", label: "blacklist/blocklist addresses", pattern: /black.?list|block.?list/i },
  { key: "fee", label: "change fees/taxes", pattern: /^set.*(fee|tax)/i },
  { key: "maxTxWallet", label: "restrict max transaction/wallet size", pattern: /^set.*max.*(tx|wallet|transaction)/i },
  { key: "proxyUpgrade", label: "upgrade the contract's logic", pattern: /^upgradeto/i },
];

const PRIVILEGE_DETAIL = {
  mint: "The owner can call a mint function to create new tokens, which can dilute existing holders and crash the price.",
  pause: "The owner can call a pause function to freeze transfers, preventing holders from selling.",
  blacklist: "The owner can block specific addresses from transferring or trading the token.",
  fee: "The owner can change transfer fees or taxes, potentially up to a level that makes selling impractical.",
  maxTxWallet: "The owner can limit how much can be transacted or held per wallet, which can be used to restrict trading unfairly.",
  proxyUpgrade:
    "This contract's code can be replaced by the owner at any time (it's an upgradeable proxy), which can change its behavior entirely — including everything else checked here.",
};

// Pure ABI inspection: returns which privilege categories were found, and
// which function names matched each one. Name-based only — not a bytecode
// or semantics audit.
export function detectOwnerPrivileges(abi, isProxy) {
  const functionNames = Array.isArray(abi)
    ? abi.filter((entry) => entry && entry.type === "function" && typeof entry.name === "string").map((entry) => entry.name)
    : [];

  const detected = [];
  for (const { key, label, pattern } of PRIVILEGE_PATTERNS) {
    const functions = functionNames.filter((name) => pattern.test(name));
    if (functions.length > 0) {
      detected.push({ key, label, functions });
    }
  }

  if (isProxy && !detected.some((d) => d.key === "proxyUpgrade")) {
    detected.push({ key: "proxyUpgrade", label: "upgrade the contract's logic", functions: [] });
  }

  return detected;
}

export function scoreOwnerPrivileges({ isVerified, abi, isProxy }, thresholds = THRESHOLDS) {
  if (!isVerified || !Array.isArray(abi)) {
    return [
      finding({
        id: "owner-privileges",
        known: false,
        severity: SEVERITY.INFO,
        title: "Owner privileges unknown",
        detail: "This check requires verified source code with a readable ABI, which is not available for this contract.",
      }),
    ];
  }

  const detected = detectOwnerPrivileges(abi, isProxy);

  if (detected.length === 0) {
    return [
      finding({
        id: "owner-privileges",
        severity: SEVERITY.INFO,
        title: "No elevated owner privileges detected",
        detail:
          "No mint, pause, blacklist, fee-changing, max-transaction, or upgrade functions were found by name in the verified ABI. This is a name-based check, not a full audit — privileges can still exist under different names.",
      }),
    ];
  }

  return detected.map((d) =>
    finding({
      id: `owner-privilege-${d.key}`,
      severity: thresholds.ownerPrivilegeSeverity[d.key] ?? SEVERITY.MEDIUM,
      title: `Owner can ${d.label}`,
      detail: PRIVILEGE_DETAIL[d.key] ?? `The ABI includes a "${d.key}"-style function.`,
    }),
  );
}

// --- Check 6: owner status --------------------------------------------------

export function scoreOwnerStatus(owner) {
  if (!owner) {
    return finding({
      id: "owner-status",
      known: false,
      severity: SEVERITY.INFO,
      title: "Owner unknown",
      detail: "The contract owner could not be read (requires the optional RPC secondary source and an owner() function).",
    });
  }
  const renounced = owner.toLowerCase() === ZERO_ADDRESS;
  return finding({
    id: "owner-status",
    severity: SEVERITY.INFO,
    title: renounced ? "Ownership renounced" : `Owned by ${owner}`,
    detail: renounced
      ? "The owner address is the zero address, so any owner-only functions listed above (if present) can no longer be called by anyone."
      : "This address currently holds owner privileges, if any are listed above. Ownership can typically be transferred or renounced at any time by the current owner.",
  });
}

// --- Check 7: market data (informational — does not affect overall level) --

export function scoreMarketData({ priceUsd, volume24hUsd, marketCapUsd } = {}) {
  const known = priceUsd != null || volume24hUsd != null || marketCapUsd != null;
  return finding({
    id: "market-data",
    severity: SEVERITY.INFO,
    known,
    countsTowardLevel: false,
    title: known ? "Market data available" : "Market data unknown",
    detail: `Price: ${priceUsd ?? "Unknown"} · 24h volume: ${volume24hUsd ?? "Unknown"} · Market cap: ${marketCapUsd ?? "Unknown"}`,
  });
}

// --- Aggregation -----------------------------------------------------------

// Overall level is deliberately simple and rule-based: the worst known,
// level-relevant severity present wins; if too few checks produced usable
// data, the verdict is "Insufficient data" rather than a guess.
export function computeOverallLevel(findings, thresholds = THRESHOLDS) {
  const relevant = findings.filter((f) => f.countsTowardLevel);
  const known = relevant.filter((f) => f.known);
  if (known.length < thresholds.minKnownFindingsForVerdict) return "Insufficient data";
  if (known.some((f) => f.severity === SEVERITY.HIGH)) return "High";
  if (known.some((f) => f.severity === SEVERITY.MEDIUM)) return "Medium";
  return "Low";
}

// Runs every check against a plain "facts" object and returns the overall
// level plus the full findings list. Pure — facts must already be plain
// data (no promises, no network calls).
export function scoreToken(facts, thresholds = THRESHOLDS) {
  const findings = [
    scoreVerification(facts.isVerified),
    ...scoreHolderConcentration(facts.holders, facts.totalSupplyRaw, thresholds),
    scoreHolderCount(facts.holdersCount, thresholds),
    scoreTokenAge(facts.createdAtIso, facts.now ?? new Date(), thresholds),
    ...scoreOwnerPrivileges({ isVerified: facts.isVerified, abi: facts.abi, isProxy: facts.isProxy }, thresholds),
    scoreOwnerStatus(facts.owner),
    scoreMarketData(facts.marketData ?? {}),
  ];
  return { overallLevel: computeOverallLevel(findings, thresholds), findings };
}
