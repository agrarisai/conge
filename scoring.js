// Risk Score v1 — pure, rule-based scoring. No network calls here: every
// function takes plain data ("facts") gathered elsewhere (see app.js) and
// returns findings. Every finding has a severity, a one-line title, and a
// "why it matters" detail — and that text is always specific to the
// outcome: a finding that passed never carries a warning explanation, and
// vice versa. A check with no data returns a finding with known: false
// ("Unknown") — Unknown is never treated as a pass.
//
// Tune thresholds by editing THRESHOLDS below — nothing else needs to
// change. See tests/scoring.test.js for sample inputs/outputs, including
// realistic USDG-like and Agraris-like fixtures.

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

// Blockscout's Token schema documents `exchange_rate` (and the related
// volume/market-cap fields) as USD-denominated — this is a platform-wide
// convention, not something specific to this chain, but it could not be
// re-confirmed against a live instance from this sandboxed environment
// (see README's field-names note). Flip this off if that turns out to be
// wrong for this deployment; every formatted amount is currency-agnostic
// on its own, only the "$" prefix depends on this.
export const MARKET_DATA_ASSUMED_CURRENCY = "USD";

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

  // Severity assigned to each ABI-detected owner-privilege category in a
  // verified contract. Not specified numerically by the product brief
  // (unlike the checks above) — these are a reasonable starting point,
  // tune freely. Proxy-upgrade severity is NOT in this table — it has its
  // own rule (see scoreProxyUpgrade): unverified source is always High;
  // verified source is Medium unless the upgrade admin is confirmed to be
  // a plain wallet (not a contract), which raises it to High.
  ownerPrivilegeSeverity: {
    mint: SEVERITY.MEDIUM,
    pause: SEVERITY.MEDIUM,
    blacklist: SEVERITY.MEDIUM,
    fee: SEVERITY.MEDIUM,
    maxTxWallet: SEVERITY.LOW,
  },
};

// `diagnostics` (optional) is a list of raw network-failure diagnostics
// from app.js (see fetchRaw/callWorkerBatch) for a finding whose "Unknown"
// or "known: false" outcome was caused by a failed network/RPC call — only
// owner-status and sell-simulation use it today, to back a per-finding
// "Technical details" panel with the real error instead of a bare
// "Unknown". Purely informational: never affects severity/known/scoring.
function finding({ id, severity, known = true, countsTowardLevel = true, title, detail, diagnostics = null }) {
  return { id, severity, known, countsTowardLevel, title, detail, diagnostics };
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

// --- Number formatting -----------------------------------------------------
// Shared by finding text (below) and by app.js for the token details table,
// so "thousands separators everywhere" stays consistent in one place.

function formatPct(pct) {
  return (Math.round(pct * 10) / 10).toString();
}

// A whole-number count (e.g. a holder count) with thousands separators:
// 365893 -> "365,893".
export function formatCount(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString("en-US") : String(n);
}

// Adds thousands separators to a decimal string's integer part without
// ever converting it to a JS Number — safe for arbitrarily large token
// amounts that would lose precision as a float.
// "1000000.5" -> "1,000,000.5"
export function addThousandsSeparators(numStr) {
  const str = String(numStr);
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [intPart, fracPart] = unsigned.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const result = fracPart !== undefined ? `${withCommas}.${fracPart}` : withCommas;
  return negative ? `-${result}` : result;
}

// A price with "sensible" decimals: 2 for values >= 1, more for sub-1
// values so small prices aren't rounded away to "0.00". Currency-agnostic
// — callers prepend "$" (or nothing) themselves.
export function formatPriceUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num === 0) return "0.00";
  const abs = Math.abs(num);
  const decimals = abs >= 1 ? 2 : Math.min(10, Math.max(2, -Math.floor(Math.log10(abs)) + 2));
  return num.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Compact magnitude for large amounts (e.g. "867.6M", "3.24B") — used in
// finding text; the details table shows the full value via formatPriceUsd
// / addThousandsSeparators instead. Currency-agnostic, like formatPriceUsd.
export function formatCompactUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${formatPriceUsd(abs)}`;
}

// --- Hand-rolled ABI helpers (no dependency) --------------------------
// Only what's needed for the handful of read-only calls this app makes:
// function selectors are given as literals (all four are well-known/
// specified, not computed from a signature string), plus small
// encode/decode helpers for a single address arg, a single uint256 arg,
// and decoding a single address or bool back out of raw eth_call
// returndata.

export const SELECTOR = {
  transfer: "0xa9059cbb", // transfer(address,uint256)
  owner: "0x8da5cb5b", // owner()
  token0: "0x0dfe1681", // token0()
  token1: "0xd21220a7", // token1()
  balanceOf: "0x70a08231", // balanceOf(address) — used only by the "Test Worker connection" self-test
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// "0xabc...def" -> 64 lowercase hex chars, no "0x" (left-padded to a
// 32-byte ABI word).
export function padAddressArg(address) {
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    throw new Error(`padAddressArg: not a valid 20-byte hex address: ${address}`);
  }
  return address.slice(2).toLowerCase().padStart(64, "0");
}

// A non-negative integer (bigint, number, or numeric string) -> 64 hex
// chars, no "0x" (left-padded to a 32-byte ABI word).
export function padUintArg(value) {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) throw new Error("padUintArg: value must be non-negative");
  return big.toString(16).padStart(64, "0");
}

// transfer(address recipient, uint256 amount) calldata.
export function encodeTransferCallData(recipient, amount) {
  return SELECTOR.transfer + padAddressArg(recipient) + padUintArg(amount);
}

// Decodes a single `address` from eth_call returndata (e.g. token0()/
// token1()/owner()). Returns null for anything that isn't a clean
// single-word address encoding (upper 12 bytes must be zero) — never
// guesses at a malformed or unexpected shape.
export function decodeAddressResult(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  const body = hex.slice(2);
  if (body.length < 64) return null;
  const word = body.slice(0, 64);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  const upper = word.slice(0, 24);
  if (!/^0+$/.test(upper)) return null;
  return "0x" + word.slice(24);
}

// Decodes a single `bool` from eth_call returndata: any non-zero 32-byte
// word is true, an all-zero word is false. Returns null if the data
// doesn't even contain one full word (caller decides how to treat that —
// see decodeTransferOutcome, which treats it leniently for non-standard
// tokens).
export function decodeBoolResult(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  const body = hex.slice(2);
  if (body.length < 64) return null;
  const word = body.slice(0, 64);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return !/^0+$/.test(word);
}

// Interprets the outcome of a simulated transfer() eth_call per the
// honeypot check's rule: a revert or RPC-level error is a failure, a
// returned `false` is a failure, and empty returndata is treated as
// success (plenty of real, non-standard ERC20s don't return a bool at
// all). `callOutcome` is { ok, result, errorMessage } — ok is whether the
// eth_call itself completed (not whether it "succeeded" in the transfer
// sense); errorMessage is only meaningful when ok is false.
export function decodeTransferOutcome({ ok, result, errorMessage }) {
  if (!ok) {
    return { success: false, reason: errorMessage || "The call reverted or returned an RPC error." };
  }
  if (result === undefined || result === null || result === "0x" || result === "0x0") {
    return { success: true, reason: "Empty returndata — treated as success (some tokens don't return a bool from transfer())." };
  }
  const decoded = decodeBoolResult(result);
  if (decoded === null) {
    return { success: true, reason: "Returndata present but not a standard bool — treated as success." };
  }
  return { success: decoded, reason: decoded ? "transfer() returned true." : "transfer() returned false." };
}

function formatAgePhrase(ageHours) {
  if (ageHours < 48) {
    const hours = Math.max(0, Math.round(ageHours));
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(ageHours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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
        "The contract's source code has not been published/verified. The ABI-based owner-privilege checks below cannot run, and the token's real behavior cannot be confirmed independently.",
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

// holders: array of { address, valueRaw, isContract? } (raw base-unit
// balance strings; isContract only if Blockscout tagged that address),
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
      .map((h) => ({
        address: h.address,
        percentage: computeHolderPercentage(h.valueRaw, totalSupplyRaw),
        isContract: h.isContract,
      }))
      .sort((a, b) => b.percentage - a.percentage);
  } catch {
    return unknown();
  }

  const top1 = ranked[0];
  const top1Pct = top1?.percentage ?? 0;
  const top10 = ranked.slice(0, 10);
  const top10Pct = top10.reduce((sum, h) => sum + h.percentage, 0);

  const top1Severity =
    top1Pct > cfg.top1.highAbovePct ? SEVERITY.HIGH : top1Pct > cfg.top1.mediumAbovePct ? SEVERITY.MEDIUM : SEVERITY.INFO;
  const top10Severity = top10Pct > cfg.top10.mediumAbovePct ? SEVERITY.MEDIUM : SEVERITY.INFO;

  // Only mentioned when Blockscout actually tagged the address as a
  // contract — a pool/bridge/vault holding a large share reads very
  // differently than a single wallet doing the same, but we only say so
  // when the API told us, never as a guess.
  const top1ContractNote =
    top1 && top1.isContract === true
      ? " The largest holder is tagged as a contract (e.g. a pool, bridge, or vault) by the block explorer, which is typically less concerning than the same share held by a single wallet."
      : "";
  const contractsInTop10 = top10.filter((h) => h.isContract === true).length;
  const top10ContractNote =
    contractsInTop10 > 0
      ? ` ${contractsInTop10} of the top ${top10.length} holder${top10.length === 1 ? "" : "s"} ${contractsInTop10 === 1 ? "is" : "are"} tagged as a contract (e.g. a pool, bridge, or vault) by the block explorer, which is typically less concerning than the same share held by individual wallets.`
      : "";

  function top1Text(severity) {
    if (severity === SEVERITY.HIGH) {
      return {
        qualifier: "high concentration",
        detail: `A single wallet controls the majority of supply and could move the price sharply on its own.${top1ContractNote}`,
      };
    }
    if (severity === SEVERITY.MEDIUM) {
      return {
        qualifier: "worth watching",
        detail: `A single holder controls a meaningful share of supply — enough to move the price noticeably if it sold.${top1ContractNote}`,
      };
    }
    return {
      qualifier: "below the concern threshold",
      detail: `No single wallet controls enough supply to move the price on its own.${top1ContractNote}`,
    };
  }

  function top10Text(severity) {
    if (severity === SEVERITY.MEDIUM) {
      return {
        qualifier: "concentrated among a few wallets",
        detail: `A large share of supply sits with a handful of holders, raising the risk of coordinated selling.${top10ContractNote}`,
      };
    }
    return {
      qualifier: "below the concern threshold",
      detail: `This is below the concern threshold for coordinated selling risk.${top10ContractNote}`,
    };
  }

  const top1Info = top1Text(top1Severity);
  const top10Info = top10Text(top10Severity);

  // top10 never reaches "high" (it only has a medium threshold), so the
  // only severity the two checks can genuinely share is "medium" — when
  // that happens, show it as one finding instead of two saying almost the
  // same thing twice. Two clean ("info") readings stay separate, since
  // neither actually exceeded anything.
  if (top1Severity === top10Severity && top1Severity !== SEVERITY.INFO) {
    return [
      finding({
        id: "holder-concentration",
        severity: top1Severity,
        title: `Largest holder owns ${formatPct(top1Pct)}% of supply, top 10 hold ${formatPct(top10Pct)}%: ${top1Info.qualifier}`,
        detail: `${top1Info.detail} ${top10Info.detail}`.trim(),
      }),
    ];
  }

  return [
    finding({
      id: "holder-top1",
      severity: top1Severity,
      title: `Largest holder owns ${formatPct(top1Pct)}% of supply: ${top1Info.qualifier}`,
      detail: top1Info.detail,
    }),
    finding({
      id: "holder-top10",
      severity: top10Severity,
      title: `Top 10 holders own ${formatPct(top10Pct)}% of supply: ${top10Info.qualifier}`,
      detail: top10Info.detail,
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
  const countText = `${formatCount(count)} holder${count === 1 ? "" : "s"}`;

  if (severity === SEVERITY.HIGH) {
    return finding({
      id: "holder-count",
      severity,
      title: `${countText}: very few holders`,
      detail: "With this few holders, the token is thinly distributed and its price can be moved by a small number of wallets.",
    });
  }
  if (severity === SEVERITY.MEDIUM) {
    return finding({
      id: "holder-count",
      severity,
      title: `${countText}: somewhat concentrated`,
      detail: "A moderate number of holders — still thin enough that a few large wallets can meaningfully affect the price.",
    });
  }
  return finding({
    id: "holder-count",
    severity,
    title: `${countText}: wide distribution`,
    detail: "Enough independent holders that no small group is likely to dominate trading on its own.",
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
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60));
  const cfg = thresholds.tokenAgeHours;
  const severity = ageHours < cfg.highBelow ? SEVERITY.HIGH : ageHours < cfg.mediumBelow ? SEVERITY.MEDIUM : SEVERITY.INFO;
  const ageText = formatAgePhrase(ageHours);

  if (severity === SEVERITY.HIGH) {
    return finding({
      id: "token-age",
      severity,
      title: `Deployed ${ageText}: very new`,
      detail: "Extremely new tokens have had almost no time for problems (or scams) to surface before people buy in.",
    });
  }
  if (severity === SEVERITY.MEDIUM) {
    return finding({
      id: "token-age",
      severity,
      title: `Deployed ${ageText}: relatively new`,
      detail: "Still early — there hasn't been much time for the token's real behavior to be observed.",
    });
  }
  return finding({
    id: "token-age",
    severity,
    title: `Deployed ${ageText}: established`,
    detail: "The token has been live long enough that major problems would likely have already surfaced.",
  });
}

// --- Check 5a: proxy upgrade (independent of verification) -----------------

// An upgradeable proxy is detectable (via `proxy_type`, or an `upgradeTo`
// -style function in a verified ABI) whether or not the source is
// verified, so this runs on its own rather than being gated behind
// verification like the rest of check 5.
//
//   - Unverified source: always High — there's no way to independently
//     confirm what upgraded logic would do.
//   - Verified source: Medium by default (common for regulated/compliant
//     tokens — the owner/admin can change the logic, but at least you can
//     read the current one). Raised to High only when the upgrade admin
//     is *confirmed* to be a plain wallet address rather than a contract
//     (e.g. a multisig or timelock) — a single point of control with no
//     on-chain checks. Never raised on a guess: if admin-contract status
//     is unknown, it stays Medium.
export function scoreProxyUpgrade({ isProxy, isVerified, proxyAdmin, proxyAdminIsContract }) {
  if (isProxy !== true) return null;

  const verified = isVerified === true;
  const adminConfirmedWallet = Boolean(proxyAdmin) && proxyAdminIsContract === false;

  const reason = !verified ? "unverified" : adminConfirmedWallet ? "wallet-admin" : "verified";
  const severity = reason === "verified" ? SEVERITY.MEDIUM : SEVERITY.HIGH;

  const adminClause = proxyAdmin
    ? ` The upgrade admin is ${proxyAdmin}${
        proxyAdminIsContract === true ? " (a contract)" : proxyAdminIsContract === false ? " (a plain wallet address)" : ""
      }.`
    : "";

  const detailByReason = {
    unverified: `This is an upgradeable proxy and the source code is not verified, so its logic can be changed by whoever controls upgrades with no way to independently confirm what the new logic would do.${adminClause}`,
    "wallet-admin": `This is an upgradeable proxy controlled by a plain wallet address rather than a contract (e.g. a multisig or timelock) — a single point of control with no on-chain checks on upgrades.${adminClause}`,
    verified: `The owner/admin can change this contract's logic at any time. This is common for regulated or compliance-driven tokens, but you must trust whoever controls upgrades.${adminClause}`,
  };

  return finding({
    id: "owner-privilege-proxyUpgrade",
    severity,
    title: "Owner can upgrade the contract's logic",
    detail: detailByReason[reason],
  });
}

// --- Check 5b: ABI-detected owner privileges (verified contracts only) -----

const PRIVILEGE_PATTERNS = [
  { key: "mint", label: "mint new tokens", pattern: /mint/i },
  { key: "pause", label: "pause transfers", pattern: /pause/i },
  { key: "blacklist", label: "blacklist/blocklist addresses", pattern: /black.?list|block.?list/i },
  { key: "fee", label: "change fees/taxes", pattern: /^set.*(fee|tax)/i },
  { key: "maxTxWallet", label: "restrict max transaction/wallet size", pattern: /^set.*max.*(tx|wallet|transaction)/i },
];

const UPGRADE_FUNCTION_PATTERN = /^upgradeto/i;

const PRIVILEGE_DETAIL = {
  mint: "The owner can call a mint function to create new tokens, which can dilute existing holders and crash the price.",
  pause: "The owner can call a pause function to freeze transfers, preventing holders from selling.",
  blacklist: "The owner can block specific addresses from transferring or trading the token.",
  fee: "The owner can change transfer fees or taxes, potentially up to a level that makes selling impractical.",
  maxTxWallet: "The owner can limit how much can be transacted or held per wallet, which can be used to restrict trading unfairly.",
};

function abiFunctionNames(abi) {
  return Array.isArray(abi)
    ? abi.filter((entry) => entry && entry.type === "function" && typeof entry.name === "string").map((entry) => entry.name)
    : [];
}

// True if the ABI itself looks like a proxy (has an upgradeTo-style
// function) — used as a fallback signal when Blockscout's `proxy_type`
// field isn't set but the verified source makes it obvious anyway.
export function abiLooksLikeProxy(abi) {
  return abiFunctionNames(abi).some((name) => UPGRADE_FUNCTION_PATTERN.test(name));
}

// Pure ABI inspection for the non-proxy privilege categories (mint, pause,
// etc.) — name-based only, not a bytecode or semantics audit.
export function detectAbiPrivileges(abi) {
  const functionNames = abiFunctionNames(abi);
  const detected = [];
  for (const { key, label, pattern } of PRIVILEGE_PATTERNS) {
    const functions = functionNames.filter((name) => pattern.test(name));
    if (functions.length > 0) {
      detected.push({ key, label, functions });
    }
  }
  return detected;
}

export function scoreOwnerPrivileges(facts, thresholds = THRESHOLDS) {
  const { isVerified, abi, isProxy, proxyAdmin, proxyAdminIsContract } = facts;
  const hasVerifiedAbi = isVerified === true && Array.isArray(abi);
  const effectiveIsProxy = isProxy === true || (hasVerifiedAbi && abiLooksLikeProxy(abi));

  const findings = [];

  const proxyFinding = scoreProxyUpgrade({ isProxy: effectiveIsProxy, isVerified, proxyAdmin, proxyAdminIsContract });
  if (proxyFinding) findings.push(proxyFinding);

  if (hasVerifiedAbi) {
    for (const d of detectAbiPrivileges(abi)) {
      findings.push(
        finding({
          id: `owner-privilege-${d.key}`,
          severity: thresholds.ownerPrivilegeSeverity[d.key] ?? SEVERITY.MEDIUM,
          title: `Owner can ${d.label}`,
          detail: PRIVILEGE_DETAIL[d.key] ?? `The ABI includes a "${d.key}"-style function.`,
        }),
      );
    }
  } else {
    findings.push(
      finding({
        id: "owner-privileges-abi",
        known: false,
        severity: SEVERITY.INFO,
        title: "Owner privileges unknown",
        detail:
          "Detecting mint, pause, blacklist, fee-changing, and max-transaction functions requires verified source code with a readable ABI, which is not available for this contract.",
      }),
    );
  }

  if (findings.length === 0) {
    // Only reachable when the ABI was readable and nothing — including a
    // proxy — was detected.
    return [
      finding({
        id: "owner-privileges",
        severity: SEVERITY.INFO,
        title: "No elevated owner privileges detected",
        detail:
          "No mint, pause, blacklist, fee-changing, or max-transaction functions were found by name in the verified ABI, and this isn't an upgradeable proxy. This is a name-based check, not a full audit — privileges can still exist under different names.",
      }),
    ];
  }

  return findings;
}

// --- Check 6: owner status --------------------------------------------------

export function scoreOwnerStatus(owner, diagnostics = null) {
  if (!owner) {
    return finding({
      id: "owner-status",
      known: false,
      severity: SEVERITY.INFO,
      title: "Owner unknown",
      detail: "The owner could not be read for this contract.",
      diagnostics,
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

// --- Check 7: sell-simulation honeypot check --------------------------

// simulation: the raw result app.js builds from a series of eth_call
// probes (see runSellSimulation in app.js) —
//   { status: "unreachable" | "no-pool" | "no-holder" | "simulated",
//     pools: [{ address, token0, token1 }],
//     holderAttempts: [{ holder, baseline: {success,reason}, sells: [{pool,success,reason}] }],
//     diagnostics?: [<raw fetchRaw-style diagnostic>, ...] }
// diagnostics is only present when status is "unreachable" — it's carried
// through onto the finding so the UI can show real network errors instead
// of a bare "Unknown" (see finding()'s diagnostics param above).
// "unreachable"/"no-pool"/"no-holder" are all inconclusive outcomes —
// known: false, grouped with "Info / unknown" in the UI, never counted
// as a pass. Only "simulated" produces a real HIGH or a real (known)
// PASSED verdict.
export function scoreSellSimulation(simulation) {
  const status = simulation?.status ?? "unreachable";

  if (status === "unreachable") {
    return finding({
      id: "sell-simulation",
      known: false,
      severity: SEVERITY.INFO,
      title: "Sell simulation unknown",
      detail: "The Worker/RPC could not be reached to simulate a transfer, so selling could not be tested.",
      diagnostics: simulation?.diagnostics ?? null,
    });
  }

  if (status === "no-pool") {
    return finding({
      id: "sell-simulation",
      known: false,
      severity: SEVERITY.INFO,
      title: "No liquidity pool found among top holders",
      detail:
        "None of the top holders looked like a liquidity pool for this token (checked via token0()/token1()), so a sell could not be simulated.",
    });
  }

  if (status === "no-holder") {
    return finding({
      id: "sell-simulation",
      known: false,
      severity: SEVERITY.INFO,
      title: "No eligible holder found to simulate a sell",
      detail:
        "A liquidity pool was found, but no top holder (a plain wallet, not a contract, with a positive balance) was available to simulate a transfer from.",
    });
  }

  const holderAttempts = simulation.holderAttempts ?? [];
  const withBaselineOk = holderAttempts.filter((h) => h.baseline?.success);

  if (withBaselineOk.length === 0) {
    return finding({
      id: "sell-simulation",
      severity: SEVERITY.HIGH,
      title: "Transfers are restricted",
      detail:
        "A simulated transfer to an ordinary address failed for every holder tried — this points to a pause, blacklist, or allowlist mechanism blocking transfers generally, not just sells.",
    });
  }

  const anySellOk = withBaselineOk.some((h) => (h.sells ?? []).some((s) => s.success));
  if (!anySellOk) {
    return finding({
      id: "sell-simulation",
      severity: SEVERITY.HIGH,
      title: "Selling appears blocked",
      detail:
        "An ordinary transfer succeeded, but a simulated transfer to every detected liquidity pool failed for every holder tried — a common honeypot pattern where only buying (not selling) is allowed.",
    });
  }

  return finding({
    id: "sell-simulation",
    severity: SEVERITY.INFO,
    title: "Sell simulation passed",
    detail:
      "A simulated transfer to both an ordinary address and a detected liquidity pool succeeded. This is an indicator, not a guarantee — it can't detect every trap (see the limits noted in the README).",
  });
}

// --- Check 8: market data (informational — does not affect overall level) --

export function scoreMarketData({ priceUsd, volume24hUsd, marketCapUsd } = {}) {
  const known = priceUsd != null || volume24hUsd != null || marketCapUsd != null;
  // See MARKET_DATA_ASSUMED_CURRENCY above for why "$" is used here.
  const prefix = MARKET_DATA_ASSUMED_CURRENCY === "USD" ? "$" : "";
  const priceText = priceUsd != null ? `${prefix}${formatPriceUsd(priceUsd)}` : "Unknown";
  const volumeText = volume24hUsd != null ? `${prefix}${formatCompactUsd(volume24hUsd)}` : "Unknown";
  const marketCapText = marketCapUsd != null ? `${prefix}${formatCompactUsd(marketCapUsd)}` : "Unknown";
  return finding({
    id: "market-data",
    severity: SEVERITY.INFO,
    known,
    countsTowardLevel: false,
    title: known ? "Market data available" : "Market data unknown",
    detail: `Price: ${priceText} · 24h volume: ${volumeText} · Market cap: ${marketCapText}`,
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
    ...scoreOwnerPrivileges(
      {
        isVerified: facts.isVerified,
        abi: facts.abi,
        isProxy: facts.isProxy,
        proxyAdmin: facts.proxyAdmin,
        proxyAdminIsContract: facts.proxyAdminIsContract,
      },
      thresholds,
    ),
    scoreOwnerStatus(facts.owner, facts.ownerDiagnostics),
    scoreSellSimulation(facts.sellSimulation),
    scoreMarketData(facts.marketData ?? {}),
  ];
  return { overallLevel: computeOverallLevel(findings, thresholds), findings };
}
