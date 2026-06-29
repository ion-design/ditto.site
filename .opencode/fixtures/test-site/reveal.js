// Minimal IntersectionObserver-driven reveal + lazy-bg trigger.
// The capture pipeline must scroll into view (or follow the CSS rule) for
// these to fire. This is the same pattern Elementor and most WP themes use.

(() => {
  const reveals = document.querySelectorAll('.reveal');
  const lazyBg = document.querySelector('.lazy-bg');

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          if (e.target.classList.contains('reveal')) e.target.classList.add('is-visible');
          if (e.target === lazyBg) e.target.classList.add('is-loaded');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.15 }
  );

  reveals.forEach((r, i) => {
    r.style.transitionDelay = `${i * 120}ms`;
    io.observe(r);
  });
  if (lazyBg) io.observe(lazyBg);
})();
