// Two scroll effects, and nothing else — no per-section/card entrance
// animations anywhere on the page; everything below the hero is simply
// present, not animated in, when it scrolls into view. That's deliberate
// (see README/PR notes), not an oversight.
//
// 1. A subtle background parallax (.bg-rings) on every page: the ring
//    texture drifts at a fraction of scroll speed for a sense of depth.
// 2. One orchestrated moment, index.html only: a dot-and-dash mark (the
//    same marker style as a signal-list finding) sweeps across the
//    divider between the hero and the scan section — repeating every few
//    seconds for as long as that divider is on screen, and pausing while
//    it's scrolled out of view or the tab is in the background.
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
  // Loops while the divider is visible: each sweep is the same single
  // 1.2s CSS animation (see .scroll-sweep in style.css), replayed
  // SWEEP_GAP_MS after the previous one finishes, so the motion itself —
  // speed, easing, dash pattern — is exactly what it always was. Nothing
  // runs while the divider is off-screen or the tab is hidden; it starts
  // again as soon as it's back in view.
  var sweepEl = document.getElementById("scroll-sweep");
  if (sweepEl && !reduceMotion && "IntersectionObserver" in window) {
    var markEl = sweepEl.querySelector(".scroll-sweep-mark");
    var SWEEP_GAP_MS = 2800; // pause between sweeps: one every ~4s
    var inView = false;
    var gapTimer = null;

    function canRun() {
      return inView && !document.hidden;
    }

    function sweep() {
      gapTimer = null;
      if (!canRun()) return;
      // The mark travels the track's actual measured width (plus its own
      // width, so it clears the far edge) — re-measured each sweep, so a
      // resize between sweeps is picked up. A CSS percentage would be
      // relative to the mark's own small box, not the track.
      var distance = sweepEl.getBoundingClientRect().width + 64;
      if (markEl) markEl.style.setProperty("--sweep-distance", distance + "px");
      // Restart the animation from the top: drop the class, force a
      // style/layout flush, then add it back.
      sweepEl.classList.remove("is-active");
      void sweepEl.offsetWidth;
      sweepEl.classList.add("is-active");
    }

    function stop() {
      clearTimeout(gapTimer);
      gapTimer = null;
      // Removing the class cancels any sweep mid-flight and returns the
      // mark to its hidden resting state.
      sweepEl.classList.remove("is-active");
    }

    function resume() {
      if (canRun() && gapTimer === null && !sweepEl.classList.contains("is-active")) sweep();
    }

    if (markEl) {
      markEl.addEventListener("animationend", function () {
        // Queue the next sweep only while it's still visible; otherwise
        // the loop simply ends here until resume() restarts it.
        if (canRun()) {
          gapTimer = setTimeout(function () {
            sweepEl.classList.remove("is-active");
            sweep();
          }, SWEEP_GAP_MS);
        } else {
          sweepEl.classList.remove("is-active");
        }
      });
    }

    var observer = new IntersectionObserver(function (entries) {
      inView = entries[entries.length - 1].isIntersecting;
      if (inView) resume();
      else stop();
    });
    observer.observe(sweepEl);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop();
      else resume();
    });
  }
})();
