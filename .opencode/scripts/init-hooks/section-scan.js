// Exposes window.__CLONE_LIST_SECTIONS__() which returns a list of candidate top-level
// section bounding boxes for the capture script's scroll planner. We emit one entry per
// large flex/block child of <body>, <main>, or any element classed as section/container/etc.
// The capture script uses these to scroll-to-section instead of fixed-pixel stepping.
(() => {
  const SECTIONLIKE_TAGS = new Set(['section', 'header', 'footer', 'nav', 'main', 'article', 'aside']);
  const SECTIONLIKE_CLASS_RE =
    /(^|\s)(section|hero|container|banner|elementor-section|elementor-element-[^\s]+|e-con|e-parent|wp-block-[^\s]+)(\s|$)/i;

  function isViewportWide(el, vw) {
    const r = el.getBoundingClientRect();
    return r.width >= vw * 0.5 && r.height >= 80;
  }

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function looksLikeSection(el) {
    const tag = el.tagName.toLowerCase();
    if (SECTIONLIKE_TAGS.has(tag)) return true;
    if (el.id && /(hero|banner|section|footer|nav|header)/i.test(el.id)) return true;
    if (typeof el.className === 'string' && SECTIONLIKE_CLASS_RE.test(el.className)) return true;
    return false;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `#${el.id}`;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 8) {
      let s = el.tagName.toLowerCase();
      const p = el.parentNode;
      if (p && p.nodeType === 1) {
        const sibs = Array.from(p.children).filter((c) => c.tagName === el.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      }
      parts.unshift(s);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }

  const SECTION_QUERY =
    'section, header, footer, nav, main, article, ' +
    '[class*="section"], [class*="elementor-element"], [class*="e-parent"], [class*="e-con"], ' +
    '[class*="hero"], [class*="banner"], [id*="section"], [id*="hero"], [id*="banner"]';

  function snapshotEntry(el, vw) {
    const r = el.getBoundingClientRect();
    return {
      element: el,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.slice(0, 200) : null,
      x: r.x,
      y: r.y + window.scrollY,
      width: r.width,
      height: r.height,
      looksLikeSection: looksLikeSection(el),
    };
  }

  function collectInScope(scope, vw, out, candidates) {
    for (const el of candidates) {
      if (!scope.contains(el) || el === scope) continue;
      if (!isVisible(el) || !isViewportWide(el, vw)) continue;
      // Outermost-wins inside this scope
      let skip = false;
      for (const o of out) {
        if (o.element.contains(el)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      for (let i = out.length - 1; i >= 0; i--) {
        if (el.contains(out[i].element)) out.splice(i, 1);
      }
      out.push(snapshotEntry(el, vw));
    }
  }

  window.__CLONE_LIST_SECTIONS__ = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

    // Pass 1: known section-like elements
    const candidates = Array.from(document.querySelectorAll(SECTION_QUERY));

    // Pass 2: large direct children of body/main as a fallback
    const root = document.querySelector('main') || document.body;
    if (root) {
      for (const child of root.children) {
        if (!candidates.includes(child)) candidates.push(child);
      }
    }

    // First-pass dedup with outermost-wins
    const out = [];
    for (const el of candidates) {
      if (!isVisible(el) || !isViewportWide(el, vw)) continue;
      let skip = false;
      for (const o of out) {
        if (o.element.contains(el)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      for (let i = out.length - 1; i >= 0; i--) {
        if (el.contains(out[i].element)) out.splice(i, 1);
      }
      out.push(snapshotEntry(el, vw));
    }

    // Pass 3: oversized-wrapper expansion. WordPress / Elementor sites commonly
    // wrap the whole page in <main id="main">. Without this step the outer
    // wrapper wins and individual sections are dropped, so the smart-scroll
    // loop never visits them and lazy backgrounds never fire.
    const oversizedThreshold = Math.max(vh * 2, docHeight * 0.5);
    const expanded = [];
    for (const sec of out) {
      if (sec.height < oversizedThreshold) {
        expanded.push(sec);
        continue;
      }
      const inner = [];
      const innerCandidates = Array.from(sec.element.querySelectorAll(SECTION_QUERY));
      collectInScope(sec.element, vw, inner, innerCandidates);
      // Only replace the wrapper if recursion produced enough sections to be
      // meaningful — otherwise this is a genuine large section, not a wrapper.
      if (inner.length >= 3) expanded.push(...inner);
      else expanded.push(sec);
    }

    return expanded
      .filter((s) => s.height > 80)
      .sort((a, b) => a.y - b.y)
      .map(({ element, ...rest }) => rest);
  };
})();
