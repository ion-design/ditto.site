// Initializes the shared capture bucket that every other hook writes into.
// Runs first because hooks load in lexicographic order.
(() => {
  if (window.__CLONE_CAPTURE__) return;
  window.__CLONE_CAPTURE__ = {
    shaders: [],
    gsap: [],
    framer: [],
    lottie: [],
    threejs: [],
    cssVars: {},
    fonts: [],
  };
  // Sentinel the capture script waits on after DOMContentLoaded + a tick.
  // Hooks that dump state on demand (gsap, framer) set __CLONE_READY__ when they've run.
  window.__CLONE_READY__ = false;
  window.addEventListener('load', () => {
    setTimeout(() => {
      try {
        if (typeof window.__CLONE_FINALIZE__ === 'function') window.__CLONE_FINALIZE__();
      } catch {}
      window.__CLONE_READY__ = true;
    }, 800);
  });
})();
