// Shared hamburger nav behavior, reused identically across all pages.
(function () {
  "use strict";

  function initNav(header) {
    var toggle = header.querySelector(".nav-toggle");
    var panelId = toggle && toggle.getAttribute("aria-controls");
    var panel = panelId && document.getElementById(panelId);
    if (!toggle || !panel) return;

    var overlay = header.querySelector(".nav-overlay");
    var closeBtn = panel.querySelector(".nav-close");
    var nav = panel.querySelector(".site-nav");
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var hideTimer = null;

    function isOpen() {
      return toggle.getAttribute("aria-expanded") === "true";
    }

    function focusableElements() {
      return Array.prototype.slice.call(
        panel.querySelectorAll('a[href], button:not([disabled])')
      );
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;

      var items = focusableElements();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function openMenu() {
      if (isOpen()) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      panel.hidden = false;
      if (overlay) overlay.hidden = false;
      // Force layout so the opening transition runs instead of jump-cutting in.
      void panel.offsetHeight;
      panel.classList.add("is-open");
      if (overlay) overlay.classList.add("is-open");
      document.body.classList.add("nav-open");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Close menu");
      document.addEventListener("keydown", onKeydown);
      if (closeBtn) closeBtn.focus();
    }

    function closeMenu(opts) {
      if (!isOpen()) return;
      var returnFocus = !opts || opts.returnFocus !== false;
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
      panel.classList.remove("is-open");
      if (overlay) overlay.classList.remove("is-open");
      document.body.classList.remove("nav-open");
      document.removeEventListener("keydown", onKeydown);

      var hide = function () {
        panel.hidden = true;
        if (overlay) overlay.hidden = true;
      };
      if (reduceMotion.matches) {
        hide();
      } else {
        hideTimer = setTimeout(hide, 220);
      }

      if (returnFocus) toggle.focus();
    }

    toggle.addEventListener("click", function () {
      if (isOpen()) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        closeMenu();
      });
    }

    if (overlay) {
      overlay.addEventListener("click", function () {
        closeMenu({ returnFocus: false });
      });
    }

    if (nav) {
      nav.addEventListener("click", function (event) {
        if (event.target.closest("a")) {
          closeMenu({ returnFocus: false });
        }
      });
    }
  }

  document.querySelectorAll(".site-header").forEach(initNav);
})();
