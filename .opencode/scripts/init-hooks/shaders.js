// Extract GLSL from WebGL1 + WebGL2 by intercepting shaderSource / compileShader / linkProgram / useProgram.
// Stashes into window.__CLONE_CAPTURE__.shaders as
//   { programId, vertex, fragment, attributes, uniforms, canvasSelector }
(() => {
  const CAPTURE = () => window.__CLONE_CAPTURE__;

  const shaderMap = new WeakMap(); // WebGLShader -> { type, source }
  const programMap = new WeakMap(); // WebGLProgram -> { vertex, fragment }
  let nextProgramId = 1;
  const contextCanvas = new WeakMap(); // WebGL(2)RenderingContext -> canvas

  function patch(ctxProto, isGL2) {
    const origShaderSource = ctxProto.shaderSource;
    ctxProto.shaderSource = function (shader, source) {
      shaderMap.set(shader, { source, type: this.getShaderParameter?.(shader, this.SHADER_TYPE) });
      return origShaderSource.call(this, shader, source);
    };

    const origAttach = ctxProto.attachShader;
    ctxProto.attachShader = function (program, shader) {
      const info = shaderMap.get(shader);
      const t = this.getShaderParameter(shader, this.SHADER_TYPE);
      const entry = programMap.get(program) || {};
      if (t === this.VERTEX_SHADER) entry.vertex = info?.source || '';
      else if (t === this.FRAGMENT_SHADER) entry.fragment = info?.source || '';
      programMap.set(program, entry);
      return origAttach.call(this, program, shader);
    };

    const origLink = ctxProto.linkProgram;
    ctxProto.linkProgram = function (program) {
      const res = origLink.call(this, program);
      const entry = programMap.get(program) || {};
      if (!entry.id) entry.id = nextProgramId++;
      const canvas = contextCanvas.get(this);
      const sel = canvas ? cssPath(canvas) : null;
      const attributes = [];
      const uniforms = [];
      try {
        const aCount = this.getProgramParameter(program, this.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < aCount; i++) {
          const info = this.getActiveAttrib(program, i);
          if (info) attributes.push({ name: info.name, type: info.type, size: info.size });
        }
        const uCount = this.getProgramParameter(program, this.ACTIVE_UNIFORMS);
        for (let i = 0; i < uCount; i++) {
          const info = this.getActiveUniform(program, i);
          if (info) uniforms.push({ name: info.name, type: info.type, size: info.size });
        }
      } catch {}
      CAPTURE().shaders.push({
        programId: entry.id,
        vertex: entry.vertex || '',
        fragment: entry.fragment || '',
        attributes,
        uniforms,
        canvasSelector: sel,
        isWebGL2: isGL2,
      });
      return res;
    };
  }

  // Intercept getContext to remember which canvas owns which WebGL context.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGetContext.call(this, type, ...rest);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      contextCanvas.set(ctx, this);
    }
    return ctx;
  };

  if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype, false);
  if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype, true);

  function cssPath(el) {
    if (!el) return null;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 10) {
      let s = el.tagName.toLowerCase();
      if (el.id) {
        s += '#' + el.id;
        parts.unshift(s);
        break;
      }
      const parent = el.parentNode;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      }
      parts.unshift(s);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }
})();
