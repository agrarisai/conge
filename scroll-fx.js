// Two scroll effects, and nothing else — no per-section/card entrance
// animations anywhere on the page; everything below the hero is simply
// present, not animated in, when it scrolls into view. That's deliberate
// (see README/PR notes), not an oversight.
//
// 1. A subtle background parallax (.bg-rings) on every page: the ring
//    texture drifts at a fraction of scroll speed for a sense of depth.
// 2. One orchestrated moment, index.html only: a dot-and-dash mark (the
//    same marker style as a signal-list finding) sweeps once across the
//    divider between the hero and the scan section, the first time that
//    divider scrolls into view.
//
// Both are skipped under prefers-reduced-motion — the background then
// renders as a plain static backdrop (see .bg-rings in style.css), and
// the sweep element just never activates.
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- Background parallax -------------------------------------------
  var bgEl = document.querySelector(".bg-rings");
  if (bgEl && !reduceMotion) {
    var PARALLAX_FACTOR = 0.5;
    var maxOffset = 0;
    var ticking = false;

    function updateMaxOffset() {
      // Stays comfortably inside .bg-rings' own oversized buffer (60vh
      // top/bottom in the CSS) so the parallax offset can never outrun
      // the layer and reveal an edge, however long the page is. On a
      // long page the offset simply holds at this cap past a couple of
      // screen-heights of scroll, rather than growing forever.
      maxOffset = window.innerHeight * 0.5;
    }

    function applyParallax() {
      var offset = Math.min(maxOffset, window.scrollY * PARALLAX_FACTOR);
      bgEl.style.transform = "translateY(-" + offset + "px)";
      ticking = false;
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(applyParallax);
    }

    updateMaxOffset();
    applyParallax();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateMaxOffset, { passive: true });
  }

  // --- Scroll sweep (index.html only; absent elsewhere) ---------------
  var sweepEl = document.getElementById("scroll-sweep");
  if (sweepEl && !reduceMotion && "IntersectionObserver" in window) {
    var markEl = sweepEl.querySelector(".scroll-sweep-mark");

    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        // The mark travels the track's actual measured width (plus its
        // own width, so it clears the far edge) — a CSS percentage
        // would be relative to the mark's own small box, not the track.
        var distance = sweepEl.getBoundingClientRect().width + 64;
        if (markEl) markEl.style.setProperty("--sweep-distance", distance + "px");
        sweepEl.classList.add("is-active");
        observer.disconnect();
        break;
      }
    });

    observer.observe(sweepEl);
  }
})();
