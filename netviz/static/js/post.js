// Selective bloom by layer mask: arcs, coastlines and city lights glow; the
// land fill does not. Blooming the fill is what makes this kind of display
// look like stock dashboard art, so the exclusion is the point.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { cfg } from './config.js';

export const BLOOM_LAYER = 1;

const COMBINE = {
  uniforms: {
    baseTexture: { value: null },
    bloomTexture: { value: null },
    knee: { value: cfg('appearance.bloom.knee', 0.6) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D baseTexture;
    uniform sampler2D bloomTexture;
    uniform float knee;
    varying vec2 vUv;
    void main() {
      vec3 bloom = texture2D(bloomTexture, vUv).rgb;
      // Soft rolloff (Reinhard with a gentle knee) instead of adding the bloom
      // straight. Arcs blend additively and all of them converge on home, so
      // where dozens stack the raw bloom runs far above 1.0 and the pile-up
      // burns to a white blob. This barely touches a single arc -- 0.2 -> 0.18
      // -- while 3.0 comes back as 1.07, so stacking reads as "many arcs"
      // rather than "one flare".
      bloom = bloom / (1.0 + bloom * knee);
      gl_FragColor = texture2D(baseTexture, vUv) + vec4(bloom, 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());

  const bloomLayer = new THREE.Layers();
  bloomLayer.set(BLOOM_LAYER);

  // Pass 1 renders only bloom-layer objects to a target; pass 2 renders the
  // full scene and adds that target on top.
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  // strength, radius, threshold. 0.9/0.05 blew the arc bodies out into a haze
  // on a bright wall panel; 0.7 with a slightly higher threshold keeps the
  // travelling heads glowing while the tube bodies stay linear.
  const bloomPass = new UnrealBloomPass(
    size,
    cfg('appearance.bloom.strength', 0.7),
    cfg('appearance.bloom.radius', 0.5),
    cfg('appearance.bloom.threshold', 0.08),
  );
  bloomComposer.addPass(bloomPass);

  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(new RenderPass(scene, camera));
  const combine = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: COMBINE.uniforms,
      vertexShader: COMBINE.vertexShader,
      fragmentShader: COMBINE.fragmentShader,
    }),
    'baseTexture');
  combine.needsSwap = true;
  combine.uniforms.bloomTexture.value = bloomComposer.renderTarget2.texture;
  finalComposer.addPass(combine);
  finalComposer.addPass(new OutputPass());

  const darkLine = new THREE.LineBasicMaterial({ color: 0x000000 });
  const darkByMaterial = new Map();
  const stash = new Map();

  /** A black stand-in of the SAME primitive type that occludes exactly as much
   *  as the original did -- no more.
   *
   *  Two traps here, both of which shipped:
   *  - Handing a Points object a MeshBasicMaterial renders every star as a
   *    world-space black quad, punching square holes in the bloom target.
   *  - Defaulting depthWrite to true makes a non-writing object start
   *    occluding. The atmosphere is a sphere at 1.045r with depthWrite off;
   *    as an opaque black stand-in it hid every arc section below that radius
   *    FOR THE BLOOM PASS ONLY, so arcs rendered but their glow cut off near
   *    each endpoint. Copy depthWrite and side from the original. */
  function darkFor(obj) {
    const orig = obj.material;
    let m = darkByMaterial.get(orig.uuid);
    if (m) return m;

    const shared = {
      color: 0x000000,
      depthWrite: orig.depthWrite !== undefined ? orig.depthWrite : true,
      side: orig.side !== undefined ? orig.side : THREE.FrontSide,
      transparent: !!orig.transparent,
    };
    if (obj.isPoints) {
      m = new THREE.PointsMaterial({
        ...shared,
        size: orig.size !== undefined ? orig.size : 1,
        sizeAttenuation: orig.sizeAttenuation !== undefined ? orig.sizeAttenuation : true,
      });
    } else if (obj.isLine) {
      m = darkLine;
    } else {
      m = new THREE.MeshBasicMaterial(shared);
    }
    darkByMaterial.set(orig.uuid, m);
    return m;
  }

  // Per-object bloom trim. A single UnrealBloomPass has one threshold for the
  // whole scene, so the only way to give one arc class less glow without
  // touching its drawn brightness is to dim it FOR THE BLOOM PASS ONLY: scale
  // its colour uniform down before pass 1 and put it back before pass 2. Set
  // obj.userData.bloomScale: below 1 trims a halo, above 1 lifts one. The highlighted
  // cyan trims because cyan is the highest-luminance hue here and clears the
  // threshold sooner than the plasma stops; the violet flow arcs lift because
  // the deep plasma stop sits close under the threshold and barely glowed.
  const dimmed = new Map();
  const hidden = [];

  function darken(obj) {
    if (obj.isMesh || obj.isPoints || obj.isLine) {
      // userData.hideInBloom: neither glow nor occlude. A black stand-in would
      // paint over arcs that pass in front of it, because arcs write no depth
      // -- the exact failure the atmosphere hit. Anything that hugs the globe
      // surface without writing depth wants this rather than a stand-in; the
      // opaque surface mesh underneath already does the real occluding.
      if (obj.userData.hideInBloom) {
        if (obj.visible) {
          obj.visible = false;
          hidden.push(obj);
        }
        return;
      }
      if (!bloomLayer.test(obj.layers)) {
        stash.set(obj.uuid, obj.material);
        obj.material = darkFor(obj);
        return;
      }
      const scale = obj.userData.bloomScale;
      const uniform = obj.material.uniforms && obj.material.uniforms.color;
      if (scale !== undefined && scale !== 1 && uniform) {
        dimmed.set(obj.uuid, uniform.value.clone());
        uniform.value.multiplyScalar(scale);
      }
    }
  }

  function restore(obj) {
    const m = stash.get(obj.uuid);
    if (m) {
      obj.material = m;
      stash.delete(obj.uuid);
    }
    const c = dimmed.get(obj.uuid);
    if (c) {
      obj.material.uniforms.color.value.copy(c);
      dimmed.delete(obj.uuid);
    }
  }

  return {
    render() {
      // The bloom pass must see BLACK where there is nothing, not the scene's
      // background colour. RenderPass paints scene.background into the bloom
      // target, the combine pass then ADDS that target to the base, and empty
      // sky comes out lifted by its own colour: measured (33,30,57) against a
      // #151327 background of (21,19,39). Blanking it for the bloom pass only
      // is what keeps the sky the colour it is set to.
      const bg = scene.background;
      scene.background = null;
      scene.traverse(darken);
      bloomComposer.render();
      scene.background = bg;
      scene.traverse(restore);
      for (const obj of hidden) obj.visible = true;
      hidden.length = 0;
      finalComposer.render();
    },
    setSize(w, h) {
      bloomComposer.setSize(w, h);
      finalComposer.setSize(w, h);
    },
    /** One bloom parameter, live. `knee` belongs to the combine shader rather
     *  than to UnrealBloomPass; the other three are the pass's own fields, and
     *  writing them is all that is needed -- none of the three re-allocates a
     *  render target. */
    setBloom(key, value) {
      if (key === 'knee') { combine.uniforms.knee.value = value; return; }
      if (key === 'strength' || key === 'radius' || key === 'threshold') {
        bloomPass[key] = value;
        return;
      }
      throw new Error(`post: no bloom parameter ${key}`);
    },
  };
}
