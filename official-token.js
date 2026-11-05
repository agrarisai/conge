// The official $CONGE token — the one place its details are written down.
// Every page that shows them (the home page card, official-token.html)
// reads them from here through official-token-ui.js, so changing the
// token means changing only this file.
//
// The address is stored in EIP-55 checksum form, exactly as viem's
// getAddress() returns it; tests/official-token.test.js fails if it ever
// isn't a valid, correctly checksummed address.
window.CONGE_OFFICIAL_TOKEN = Object.freeze({
  name: "Conge",
  symbol: "CONGE",
  address: "0xA5CA99C4918f4ca4D7c822D4DCECCE928567Fb7F",
  chainName: "Robinhood Chain",
  chainId: 4663,
  explorerUrl: "https://robin.etherscan.io",
});
