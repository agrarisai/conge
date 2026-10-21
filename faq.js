// FAQ accordion (faq.html only). Progressive enhancement: the markup ships
// with every answer visible (aria-expanded="true"), so without JavaScript
// nothing is hidden; this script collapses them on load and lets each
// question toggle its own answer. Several answers can be open at once —
// opening one never closes another, so nothing jumps while you read.
//
// Collapsed answers use hidden="until-found" where supported, so the
// browser's find-in-page can still reach (and open) them; elsewhere it
// behaves like a plain hidden attribute. The only motion is a short height
// transition, skipped entirely under prefers-reduced-motion.
(function () {
  "use strict";

  var list = document.querySelector(".faq-list");
  if (!list) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function collapse(panel) {
    panel.setAttribute("hidden", "until-found");
  }

  function setOpen(button, panel, open, animate) {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    // Each toggle supersedes any transition still running on this panel.
    panel._faqToken = (panel._faqToken || 0) + 1;
    var token = panel._faqToken;

    if (!animate || reduceMotion.matches) {
      panel.style.height = "";
      if (open) panel.removeAttribute("hidden");
      else collapse(panel);
      return;
    }

    var finish = function (event) {
      if (event && (event.target !== panel || event.propertyName !== "height")) return;
      panel.removeEventListener("transitionend", finish);
      if (token !== panel._faqToken) return;
      panel.style.height = "";
      if (!open) collapse(panel);
    };
    panel.addEventListener("transitionend", finish);

    if (open) {
      panel.removeAttribute("hidden");
      panel.style.height = "0px";
      void panel.offsetHeight; // commit the start height before transitioning
      panel.style.height = panel.scrollHeight + "px";
    } else {
      panel.style.height = panel.scrollHeight + "px";
      void panel.offsetHeight;
      panel.style.height = "0px";
    }
  }

  Array.prototype.forEach.call(list.querySelectorAll(".faq-toggle"), function (button) {
    var panel = document.getElementById(button.getAttribute("aria-controls"));
    if (!panel) return;

    setOpen(button, panel, false, false);

    button.addEventListener("click", function () {
      setOpen(button, panel, button.getAttribute("aria-expanded") !== "true", true);
    });

    // Find-in-page revealed a collapsed answer: keep the button in sync.
    panel.addEventListener("beforematch", function () {
      setOpen(button, panel, true, false);
    });
  });

  list.classList.add("faq-list-enhanced");
})();
