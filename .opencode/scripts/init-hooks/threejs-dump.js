// Patches THREE.WebGLRenderer to track its canvas + scene root, then serializes the scene graph
// at __CLONE_FINALIZE__. Records geometry types, material types + uniforms, lights, cameras,
// and per-object position/rotation/scale.
(() => {
  const renderers = new Set();
  const rendererToScene = new WeakMap();

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

  function patchWhenReady() {
    if (!window.THREE || !window.THREE.WebGLRenderer) return false;
    const WR = window.THREE.WebGLRenderer;
    const origRender = WR.prototype.render;
    WR.prototype.render = function (scene, camera) {
      renderers.add(this);
      if (scene) rendererToScene.set(this, { scene, camera });
      return origRender.call(this, scene, camera);
    };
    return true;
  }

  if (!patchWhenReady()) {
    const timer = setInterval(() => {
      if (patchWhenReady()) clearInterval(timer);
    }, 200);
    setTimeout(() => clearInterval(timer), 10_000);
  }

  function serializeObject(obj) {
    const out = {
      type: obj.type || obj.constructor?.name || 'Object3D',
      name: obj.name || undefined,
      position: obj.position ? [obj.position.x, obj.position.y, obj.position.z] : undefined,
      rotation: obj.rotation ? [obj.rotation.x, obj.rotation.y, obj.rotation.z] : undefined,
      scale: obj.scale ? [obj.scale.x, obj.scale.y, obj.scale.z] : undefined,
      visible: obj.visible,
      children: [],
    };
    if (obj.geometry) {
      out.geometry = {
        type: obj.geometry.type,
        parameters: obj.geometry.parameters ? { ...obj.geometry.parameters } : undefined,
      };
    }
    if (obj.material) {
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      out.material = {
        type: m.type,
        color: m.color ? m.color.getHex?.().toString(16) : undefined,
        opacity: m.opacity,
        transparent: m.transparent,
        uniforms: m.uniforms ? summarizeUniforms(m.uniforms) : undefined,
        vertexShader: m.vertexShader?.slice(0, 4000),
        fragmentShader: m.fragmentShader?.slice(0, 4000),
      };
    }
    if (obj.isLight) {
      out.light = {
        type: obj.type,
        color: obj.color?.getHex?.()?.toString(16),
        intensity: obj.intensity,
      };
    }
    if (obj.isCamera) {
      out.camera = {
        type: obj.type,
        fov: obj.fov,
        aspect: obj.aspect,
        near: obj.near,
        far: obj.far,
      };
    }
    if (obj.children?.length) {
      out.children = obj.children.map(serializeObject);
    }
    return out;
  }

  function summarizeUniforms(u) {
    const out = {};
    for (const k of Object.keys(u)) {
      try {
        const v = u[k]?.value;
        if (v == null) continue;
        if (typeof v === 'number') out[k] = v;
        else if (Array.isArray(v)) out[k] = v.slice(0, 16);
        else if (v.x != null && v.y != null) out[k] = [v.x, v.y, v.z ?? 0, v.w ?? 0];
        else out[k] = String(v).slice(0, 80);
      } catch {}
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
      for (const r of renderers) {
        const { scene, camera } = rendererToScene.get(r) || {};
        const dom = r.domElement;
        window.__CLONE_CAPTURE__.threejs.push({
          canvasSelector: dom instanceof Element ? cssPath(dom) : null,
          size: dom ? [dom.width, dom.height] : null,
          scene: scene ? serializeObject(scene) : null,
          camera: camera ? serializeObject(camera) : null,
        });
      }
    } catch (e) {
      window.__CLONE_CAPTURE__.threejs.push({ error: String(e) });
    }
  };
})();
