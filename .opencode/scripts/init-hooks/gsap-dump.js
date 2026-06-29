// Dumps GSAP timelines + tweens into window.__CLONE_CAPTURE__.gsap after load.
// Runs on __CLONE_FINALIZE__ so that page-load animations have had time to register.
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

  function targetsToSelectors(targets) {
    if (!targets) return [];
    if (targets instanceof Element) return [cssPath(targets)];
    if (Array.isArray(targets) || targets.length != null) {
      const out = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (t instanceof Element) out.push(cssPath(t));
        else if (typeof t === 'string') out.push(t);
      }
      return out;
    }
    if (typeof targets === 'string') return [targets];
    return [];
  }

  function serializeEase(ease) {
    if (!ease) return null;
    if (typeof ease === 'string') return ease;
    if (typeof ease === 'function') return ease.name || ease.toString().slice(0, 40);
    return String(ease);
  }

  function serializeTween(t) {
    const vars = {};
    if (t.vars) {
      for (const k of Object.keys(t.vars)) {
        if (['onComplete', 'onStart', 'onUpdate', 'onRepeat', 'scrollTrigger'].includes(k)) continue;
        try {
          const v = t.vars[k];
          if (typeof v === 'function') continue;
          if (v && typeof v === 'object' && v.nodeType) continue;
          vars[k] = v;
        } catch {}
      }
    }
    return {
      type: 'tween',
      targets: targetsToSelectors(t._targets || t.targets?.()),
      duration: t.duration?.() ?? t._duration,
      ease: serializeEase(t.vars?.ease),
      vars,
      scrollTrigger: t.vars?.scrollTrigger
        ? {
            trigger:
              t.vars.scrollTrigger.trigger instanceof Element
                ? cssPath(t.vars.scrollTrigger.trigger)
                : t.vars.scrollTrigger.trigger,
            start: t.vars.scrollTrigger.start,
            end: t.vars.scrollTrigger.end,
            scrub: t.vars.scrollTrigger.scrub,
            pin: t.vars.scrollTrigger.pin,
          }
        : null,
    };
  }

  function walk(tl) {
    const out = { type: 'timeline', duration: tl.duration?.(), children: [] };
    const kids = tl.getChildren ? tl.getChildren(true, true, true) : [];
    for (const c of kids) {
      if (c.getChildren) out.children.push(walk(c));
      else out.children.push(serializeTween(c));
    }
    return out;
  }

  const prevFinalize = window.__CLONE_FINALIZE__;
  window.__CLONE_FINALIZE__ = function () {
    if (prevFinalize)
      try {
        prevFinalize();
      } catch {}
    try {
      if (!window.gsap) return;
      const root = window.gsap.globalTimeline;
      if (!root) return;
      window.__CLONE_CAPTURE__.gsap.push(walk(root));
    } catch (e) {
      window.__CLONE_CAPTURE__.gsap.push({ error: String(e) });
    }
  };
})();
