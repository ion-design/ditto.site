// Dumps every same-origin CSS rule as { selector, cssText } into __CLONE_CAPTURE__.cssRules,
// and extracts every url(...) asset reference (resolved to absolute URLs) into
// __CLONE_CAPTURE__.cssAssets. Catches background-images set in stylesheets that the
// response listener missed (e.g. @media-gated, ::before, mask-image, list-style-image, cursor).
(() => {
  function isSameOrigin(href) {
    if (!href) return true;
    try {
      const u = new URL(href, location.href);
      return u.origin === location.origin;
    } catch {
      return false;
    }
  }

  function resolveUrl(raw, baseHref) {
    if (!raw) return null;
    let s = raw.trim();
    if (s.startsWith('"') || s.startsWith("'")) s = s.slice(1, -1);
    if (s.startsWith('data:') || s.startsWith('#')) return null;
    try {
      return new URL(s, baseHref || location.href).href;
    } catch {
      return null;
    }
  }

  function collectFromRules(rules, baseHref, out) {
    if (!rules) return;
    for (const rule of rules) {
      const type = rule.constructor?.name || '';
      if (type === 'CSSStyleRule') {
        const text = rule.cssText || '';
        out.rules.push({ selector: rule.selectorText, cssText: text, baseHref });
        const urls = text.match(/url\(\s*([^)]+?)\s*\)/g) || [];
        for (const m of urls) {
          const inner = m
            .slice(4, -1)
            .trim()
            .replace(/^['"]|['"]$/g, '');
          const abs = resolveUrl(inner, baseHref);
          if (abs && !out.assetSet.has(abs)) {
            out.assetSet.add(abs);
            out.assets.push({ source_url: abs, selector: rule.selectorText });
          }
        }
      } else if (type === 'CSSMediaRule' || type === 'CSSSupportsRule' || type === 'CSSContainerRule') {
        const condition = rule.conditionText || rule.media?.mediaText;
        out.media.push({ condition, type });
        collectFromRules(rule.cssRules, baseHref, out);
      } else if (type === 'CSSImportRule') {
        // Recurse into imported stylesheet if same-origin and accessible
        try {
          const importedHref = rule.styleSheet?.href || baseHref;
          if (isSameOrigin(importedHref)) {
            collectFromRules(rule.styleSheet?.cssRules, importedHref, out);
          }
        } catch {}
      } else if (type === 'CSSFontFaceRule') {
        const text = rule.cssText || '';
        out.fontFaces.push({ cssText: text, baseHref });
        const urls = text.match(/url\(\s*([^)]+?)\s*\)/g) || [];
        for (const m of urls) {
          const inner = m
            .slice(4, -1)
            .trim()
            .replace(/^['"]|['"]$/g, '');
          const abs = resolveUrl(inner, baseHref);
          if (abs && !out.assetSet.has(abs)) {
            out.assetSet.add(abs);
            out.assets.push({ source_url: abs, selector: '@font-face' });
          }
        }
      } else if (type === 'CSSKeyframesRule') {
        const frames = [];
        for (const k of rule.cssRules || []) frames.push({ key: k.keyText, cssText: k.style?.cssText || '' });
        out.keyframes.push({ name: rule.name, frames, baseHref });
      } else if (rule.cssRules) {
        collectFromRules(rule.cssRules, baseHref, out);
      }
    }
  }

  function collect() {
    const out = {
      rules: [],
      media: [],
      fontFaces: [],
      keyframes: [],
      assets: [],
      assetSet: new Set(),
      crossOrigin: 0,
    };
    for (const sheet of document.styleSheets) {
      const baseHref = sheet.href || location.href;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        out.crossOrigin += 1;
        continue;
      }
      collectFromRules(rules, baseHref, out);
    }
    delete out.assetSet;
    window.__CLONE_CAPTURE__.cssRules = out;
  }

  const prevFinalize = window.__CLONE_FINALIZE__;
  window.__CLONE_FINALIZE__ = function () {
    if (prevFinalize)
      try {
        prevFinalize();
      } catch {}
    try {
      collect();
    } catch (e) {
      window.__CLONE_CAPTURE__.cssRules = { error: String(e) };
    }
  };
})();
