// Exposes window.__CLONE_DUMP_COMPUTED__() which walks the DOM and returns a minimal tree
// of resolved computed styles (only non-default values). The capture script calls this on demand
// after each scroll step — cheap to call repeatedly, much richer than the inline per-step snapshot
// the Playwright script does as a fallback.
(() => {
  const PROPS = [
    'color',
    'backgroundColor',
    'backgroundImage',
    'backgroundSize',
    'backgroundPosition',
    'backgroundRepeat',
    'backgroundAttachment',
    'backgroundClip',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'textAlign',
    'textDecoration',
    'textShadow',
    'whiteSpace',
    'display',
    'flexDirection',
    'flexWrap',
    'justifyContent',
    'alignItems',
    'alignContent',
    'alignSelf',
    'gap',
    'rowGap',
    'columnGap',
    'gridTemplateColumns',
    'gridTemplateRows',
    'gridTemplateAreas',
    'gridColumn',
    'gridRow',
    'gridAutoFlow',
    'padding',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'margin',
    'marginTop',
    'marginRight',
    'marginBottom',
    'marginLeft',
    'width',
    'height',
    'maxWidth',
    'maxHeight',
    'minWidth',
    'minHeight',
    'aspectRatio',
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'zIndex',
    'inset',
    'border',
    'borderTop',
    'borderRight',
    'borderBottom',
    'borderLeft',
    'borderRadius',
    'borderColor',
    'borderWidth',
    'borderStyle',
    'boxShadow',
    'opacity',
    'transform',
    'transformOrigin',
    'filter',
    'backdropFilter',
    'clipPath',
    'mask',
    'maskImage',
    'mixBlendMode',
    'isolation',
    'overflow',
    'overflowX',
    'overflowY',
    'scrollBehavior',
    'scrollSnapType',
    'cursor',
    'pointerEvents',
    'userSelect',
    'willChange',
    'contain',
  ];

  // Compute defaults once per tag by creating a hidden iframe so we don't treat
  // inherited defaults as "used styles". The iframe is created lazily — at
  // init-script time, document.documentElement may still be null (Playwright
  // fires add_init_script before the HTML parser materialises <html>).
  let iframe = null;
  function ensureIframe() {
    if (iframe) return iframe;
    if (!document.documentElement) return null;
    try {
      iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
      iframe.srcdoc = '<!doctype html><html><body></body></html>';
      document.documentElement.appendChild(iframe);
    } catch {
      iframe = null;
    }
    return iframe;
  }

  const defaultsByTag = new Map();
  function defaultsFor(tag) {
    if (defaultsByTag.has(tag)) return defaultsByTag.get(tag);
    const ifr = ensureIframe();
    const doc = ifr ? ifr.contentDocument : null;
    if (!doc || !doc.body) return {};
    const el = doc.createElement(tag);
    doc.body.appendChild(el);
    const cs = doc.defaultView.getComputedStyle(el);
    const d = {};
    for (const p of PROPS) d[p] = cs[p];
    doc.body.removeChild(el);
    defaultsByTag.set(tag, d);
    return d;
  }

  function nonDefault(el) {
    const cs = getComputedStyle(el);
    const defaults = defaultsFor(el.tagName.toLowerCase());
    const out = {};
    for (const p of PROPS) {
      const v = cs[p];
      if (v == null || v === '') continue;
      if (v === defaults[p]) continue;
      out[p] = v;
    }
    return out;
  }

  function pseudoStyles(el) {
    const out = {};
    for (const pseudo of ['::before', '::after']) {
      try {
        const cs = getComputedStyle(el, pseudo);
        const content = cs.content;
        if (content && content !== 'normal' && content !== 'none') {
          const block = {};
          for (const p of PROPS) {
            const v = cs[p];
            if (v && v !== 'none' && v !== 'normal' && v !== 'auto') block[p] = v;
          }
          block.content = content;
          out[pseudo] = block;
        }
      } catch {}
    }
    return Object.keys(out).length ? out : undefined;
  }

  function serialize(el) {
    if (el.nodeType === Node.TEXT_NODE) {
      const t = el.textContent;
      return t && t.trim() ? { text: t } : null;
    }
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return null;
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const computed = nonDefault(el);
    const pseudo = pseudoStyles(el);
    if (pseudo) computed.pseudo = pseudo;
    const r = el.getBoundingClientRect();
    const children = [];
    for (const c of el.childNodes) {
      const s = serialize(c);
      if (s) children.push(s);
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      computed,
      bbox: { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height },
      children,
    };
  }

  window.__CLONE_DUMP_COMPUTED__ = () => serialize(document.body);
})();
