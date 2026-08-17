// Rim scattering on a slightly larger backface sphere: brightest where the
// view grazes the limb, invisible face-on.
import * as THREE from 'three';
import { plasmaAt } from './palette.js';
import { cfg } from './config.js';

export function createAtmosphere(radius) {
  const power = cfg('appearance.atmosphere.power', 3.2);
  const strength = cfg('appearance.atmosphere.strength', 0.85);
  const thickness = cfg('appearance.atmosphere.thickness', 1.045);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      glowColor: { value: plasmaAt(0.20) },
      power: { value: power },
      strength: { value: strength },
    },
    vertexShader: /* glsl */`
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 glowColor;
      uniform float power;
      uniform float strength;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), power);
        gl_FragColor = vec4(glowColor, rim * strength);
      }
    `,
  });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * thickness, 96, 72), material);
  /** Uniform write. The cheapest of the setters -- this one is already a
   *  shader uniform and needs nothing pushed. */
  mesh.setGlow = (color) => { material.uniforms.glowColor.value.copy(color); };
  /** Straight uniform write for `power` and `strength`. */
  mesh.setParam = (key, v) => { material.uniforms[key].value = v; };
  /** `thickness` is baked into SphereGeometry and cannot be pushed, which is
   *  why its schema strategy is `rebuild`. This disposes the old geometry --
   *  it is the one thing here that allocates. */
  mesh.setThickness = (v) => {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.SphereGeometry(radius * v, 96, 72);
  };
  return mesh;
}
