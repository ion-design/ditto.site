// Dumps every :root --custom-property and every @property registration into
// window.__CLONE_CAPTURE__.cssVars, keyed under { custom, registered }.
(() => {
  function collect() {
    const custom = {};
    try {
      const cs = getComputedStyle(document.documentElement);
      for (let i = 0; i < cs.length; i++) {
        const name = cs[i];
        if (!name.startsWith('--')) continue;
        try {
          custom[name] = cs.getPropertyValue(name).trim();
        } catch {}
      }
    } catch {}

    const registered = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.constructor?.name === 'CSSPropertyRule' || rule.type === 18 /* @property */) {
            registered.push({
              name: rule.name,
              syntax: rule.syntax,
              initialValue: rule.initialValue,
              inherits: rule.inherits,
            });
          }
        }
      }
    } catch {}

    window.__CLONE_CAPTURE__.cssVars = { custom, registered };
  }

  const prevFinalize = window.__CLONE_FINALIZE__;
  window.__CLONE_FINALIZE__ = function () {
    if (prevFinalize)
      try {
        prevFinalize();
      } catch {}
    collect();
  };
})();
