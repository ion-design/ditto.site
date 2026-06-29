// Pulls registered Lottie animations + their animationData into window.__CLONE_CAPTURE__.lottie.
// Called from __CLONE_FINALIZE__. Supports lottie-web directly; lottie-react uses lottie-web internally.
(() => {
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `#${el.id}`;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 10) {
      let s = el.tagName.toLowerCase();
      const p = el.parentNode;
      if (p) {
        const sibs = Array.from(p.children).filter((c) => c.tagName === el.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      }
      parts.unshift(s);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }

  const prevFinalize = window.__CLONE_FINALIZE__;
  window.__CLONE_FINALIZE__ = function () {
    if (prevFinalize)
      try {
        prevFinalize();
      } catch {}
    try {
      const lottie = window.lottie || window.bodymovin;
      if (!lottie || typeof lottie.getRegisteredAnimations !== 'function') return;
      const anims = lottie.getRegisteredAnimations();
      for (const a of anims) {
        try {
          window.__CLONE_CAPTURE__.lottie.push({
            selector: a.wrapper instanceof Element ? cssPath(a.wrapper) : null,
            renderer: a.renderer?.name || 'unknown',
            animationData: a.animationData ? JSON.parse(JSON.stringify(a.animationData)) : null,
            loop: a.loop,
            autoplay: a.autoplay,
            name: a.name,
          });
        } catch {}
      }
    } catch (e) {
      window.__CLONE_CAPTURE__.lottie.push({ error: String(e) });
    }
  };
})();
