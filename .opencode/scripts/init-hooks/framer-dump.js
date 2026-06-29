// Walks the React fiber tree (via __REACT_DEVTOOLS_GLOBAL_HOOK__) to find framer-motion
// components and dump their animate/variants/transition/whileInView/whileHover props.
// Called from __CLONE_FINALIZE__.
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

  function isMotionComponent(fiber) {
    const type = fiber?.type;
    if (!type) return false;
    if (type.$$typeof && type.render && type.render.displayName?.startsWith('motion.')) return true;
    const dn = type.displayName || type.name;
    if (typeof dn === 'string' && (dn.startsWith('motion.') || dn === 'MotionComponent')) return true;
    return false;
  }

  function serializeProp(v) {
    try {
      if (v == null) return v;
      if (typeof v === 'function') return null;
      if (typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) {
          const val = v[k];
          if (typeof val === 'function') continue;
          if (val && typeof val === 'object' && val.nodeType) continue;
          out[k] = val;
        }
        return out;
      }
      return v;
    } catch {
      return null;
    }
  }

  function findFibers(fiber, out) {
    if (!fiber) return;
    if (isMotionComponent(fiber)) {
      const props = fiber.memoizedProps || {};
      let node = fiber.stateNode;
      if (!(node instanceof Element)) {
        // Walk down to the first DOM host for selector extraction.
        let cursor = fiber.child;
        while (cursor) {
          if (cursor.stateNode instanceof Element) {
            node = cursor.stateNode;
            break;
          }
          cursor = cursor.child;
        }
      }
      out.push({
        selector: node instanceof Element ? cssPath(node) : null,
        initial: serializeProp(props.initial),
        animate: serializeProp(props.animate),
        exit: serializeProp(props.exit),
        variants: serializeProp(props.variants),
        transition: serializeProp(props.transition),
        whileHover: serializeProp(props.whileHover),
        whileTap: serializeProp(props.whileTap),
        whileInView: serializeProp(props.whileInView),
        viewport: serializeProp(props.viewport),
      });
    }
    if (fiber.child) findFibers(fiber.child, out);
    if (fiber.sibling) findFibers(fiber.sibling, out);
  }

  const prevFinalize = window.__CLONE_FINALIZE__;
  window.__CLONE_FINALIZE__ = function () {
    if (prevFinalize)
      try {
        prevFinalize();
      } catch {}
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers) return;
      for (const [, renderer] of hook.renderers) {
        if (!renderer) continue;
        const roots = renderer.findFiberByHostInstance ? null : renderer.roots || null;
        const scanFrom = [];
        if (hook.getFiberRoots) {
          const rootSet = hook.getFiberRoots(1) || new Set();
          for (const r of rootSet) scanFrom.push(r.current);
        }
        for (const fiber of scanFrom) findFibers(fiber, window.__CLONE_CAPTURE__.framer);
      }
    } catch (e) {
      window.__CLONE_CAPTURE__.framer.push({ error: String(e) });
    }
  };
})();
