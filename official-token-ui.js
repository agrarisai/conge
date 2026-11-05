// Fills every [data-official-token] block on the page (the home page card,
// official-token.html) from window.CONGE_OFFICIAL_TOKEN (official-token.js):
//   [data-ot="ticker"]   -> "$CONGE"
//   [data-ot="name"]     -> "Conge"
//   [data-ot="address"]  -> the full checksummed address
//   [data-ot="chain"]    -> "Robinhood Chain (chain ID 4663)"
//   [data-ot-link="explorer"] -> the token's explorer page
//   [data-ot-link="scan"]     -> this site's scanner with ?address=
//   [data-ot-copy]       -> copies the address
// textContent only, never innerHTML. If the config is missing or the
// address isn't a well-formed address, the blocks stay hidden rather than
// showing anything wrong.
(function () {
  "use strict";

  var token = window.CONGE_OFFICIAL_TOKEN;
  var blocks = document.querySelectorAll("[data-official-token]");
  if (!blocks.length) return;
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token.address)) return;

  var ticker = "$" + token.symbol;
  var text = {
    ticker: ticker,
    name: token.name,
    address: token.address,
    chain: token.chainName + " (chain ID " + token.chainId + ")",
  };
  var explorerHref = token.explorerUrl + "/token/" + token.address;
  var scanHref = "./?address=" + token.address;

  function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value).then(
        function () { return true; },
        function () { return legacyCopy(value); }
      );
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    var area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  Array.prototype.forEach.call(blocks, function (block) {
    Array.prototype.forEach.call(block.querySelectorAll("[data-ot]"), function (el) {
      var key = el.getAttribute("data-ot");
      if (Object.prototype.hasOwnProperty.call(text, key)) el.textContent = text[key];
    });

    Array.prototype.forEach.call(block.querySelectorAll('[data-ot-link="explorer"]'), function (a) {
      a.href = explorerHref;
      a.setAttribute("aria-label", "View " + ticker + " on the block explorer (opens in a new tab)");
    });

    Array.prototype.forEach.call(block.querySelectorAll('[data-ot-link="scan"]'), function (a) {
      a.href = scanHref;
      a.addEventListener("click", function (event) {
        // On the scanner page itself, scan in place instead of reloading:
        // a reload to the same ?address= wouldn't auto-scan twice in one
        // tab (see app.js). The scan form's own handler applies, so a scan
        // already running or the cooldown still blocks a second one.
        var form = document.getElementById("scan-form");
        var input = document.getElementById("token-address");
        if (!form || !input || typeof form.requestSubmit !== "function") return;
        event.preventDefault();
        input.value = token.address;
        form.requestSubmit();
        var scanCard = document.getElementById("token-scan");
        if (scanCard) scanCard.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
    });

    Array.prototype.forEach.call(block.querySelectorAll("[data-ot-copy]"), function (button) {
      var label = button.querySelector("[data-ot-copy-label]") || button;
      var status = block.querySelector("[data-ot-copy-status]");
      var resetTimer = null;
      button.addEventListener("click", function () {
        copyText(token.address).then(function (ok) {
          clearTimeout(resetTimer);
          label.textContent = ok ? "Copied" : "Couldn't copy";
          if (status) status.textContent = ok ? "Address copied to clipboard." : "Couldn't copy. Select the address and copy it instead.";
          resetTimer = setTimeout(function () {
            label.textContent = "Copy";
            if (status) status.textContent = "";
          }, 2000);
        });
      });
    });

    block.hidden = false;
  });
})();
