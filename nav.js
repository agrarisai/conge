// Shared hamburger nav behavior, reused identically across all pages.
(function () {
  "use strict";

  function initNav(header) {
    var toggle = header.querySelector(".nav-toggle");
    var nav = header.querySelector(".site-nav");
    if (!toggle || !nav) return;

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var hideTimer = null;

    function isOpen() {
      return toggle.getAttribute("aria-expanded") === "true";
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    function onDocumentClick(event) {
      if (nav.contains(event.target) || toggle.contains(event.target)) return;
      closeMenu({ returnFocus: false });
    }

    function openMenu() {
      if (isOpen()) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      nav.hidden = false;
      // Force layout so the opening transition runs instead of jump-cutting in.
      void nav.offsetHeight;
      nav.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Close menu");
      document.addEventListener("keydown", onKeydown);
      document.addEventListener("click", onDocumentClick, true);
    }

    function closeMenu(opts) {
      if (!isOpen()) return;
      var returnFocus = !opts || opts.returnFocus !== false;
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
      nav.classList.remove("is-open");
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocumentClick, true);

      if (reduceMotion.matches) {
        nav.hidden = true;
      } else {
        hideTimer = setTimeout(function () {
          nav.hidden = true;
          hideTimer = null;
        }, 180);
      }

      if (returnFocus) {
        toggle.focus();
      }
    }

    toggle.addEventListener("click", function () {
      if (isOpen()) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        closeMenu({ returnFocus: false });
      }
    });
  }

  document.querySelectorAll(".site-header").forEach(initNav);
})();
