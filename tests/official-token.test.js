// The official $CONGE token config (official-token.js): a valid,
// correctly checksummed address, the right name/ticker/chain, and no other
// file hard-coding the address — so it really is changed in one place.
//
// Run with:  node --test tests/official-token.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), "utf8");

function loadConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(read("official-token.js"), sandbox);
  return sandbox.window.CONGE_OFFICIAL_TOKEN;
}

// Keccak-256 (the pre-NIST padding Ethereum uses — not SHA3-256), small
// and dependency-free, just enough to check an EIP-55 checksum here.
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x80000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(A) {
  for (const rc of RC) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
    const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
    const B = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & MASK & B[(x + 2) % 5][y]);
    A[0][0] ^= rc;
  }
}

function keccak256Hex(text) {
  const rate = 136;
  const bytes = [...Buffer.from(text, "utf8"), 0x01];
  while (bytes.length % rate) bytes.push(0);
  bytes[bytes.length - 1] |= 0x80;
  const A = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
  for (let off = 0; off < bytes.length; off += rate) {
    for (let j = 0; j < rate / 8; j++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(bytes[off + 8 * j + k]);
      A[j % 5][Math.floor(j / 5)] ^= lane;
    }
    keccakF(A);
  }
  let out = "";
  for (let j = 0; j < 4; j++) {
    let lane = A[j % 5][Math.floor(j / 5)];
    for (let k = 0; k < 8; k++) {
      out += (lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return out;
}

// EIP-55, the same rule as viem's getAddress().
function toChecksumAddress(address) {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(lower);
  return "0x" + [...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

test("keccak256 / EIP-55 helpers match known vectors", () => {
  assert.equal(keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  // From the EIP-55 specification.
  assert.equal(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  assert.equal(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"), "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
});

test("official token config: the expected token, a valid address in checksum form", () => {
  const token = loadConfig();
  assert.ok(Object.isFrozen(token));
  assert.equal(token.name, "Conge");
  assert.equal(token.symbol, "CONGE");
  assert.equal(token.chainName, "Robinhood Chain");
  assert.equal(token.chainId, 4663);
  assert.match(token.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(token.address.toLowerCase(), "0xa5ca99c4918f4ca4d7c822d4dcecce928567fb7f");
  assert.equal(token.address, toChecksumAddress(token.address), "address must be stored exactly as getAddress() returns it");
  assert.match(token.explorerUrl, /^https:\/\/[^/]+$/);
});

test("the address is written in official-token.js only", () => {
  const needle = loadConfig().address.toLowerCase().slice(2);
  const files = readdirSync(ROOT).filter((f) => /\.(html|js|json|xml|txt)$/.test(f) && f !== "official-token.js");
  for (const f of files) {
    assert.ok(!read(f).toLowerCase().includes(needle), `${f} hard-codes the official token address`);
  }
});

test("the home page and official-token.html load the config and the renderer", () => {
  for (const page of ["index.html", "official-token.html"]) {
    const html = read(page);
    assert.match(html, /<script src="official-token\.js\?v=[0-9a-f]+" defer><\/script>/, page);
    assert.match(html, /<script src="official-token-ui\.js\?v=[0-9a-f]+" defer><\/script>/, page);
    assert.match(html, /data-official-token/, page);
  }
});

test("every page's footer links to the official token page", () => {
  for (const page of ["index.html", "about.html", "how-it-works.html", "faq.html", "disclaimer.html", "official-token.html"]) {
    assert.match(read(page), /<li><a href="official-token\.html">Official token<\/a><\/li>/, page);
  }
});
