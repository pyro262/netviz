// Rim scattering on a slightly larger backface sphere: brightest where the
// view grazes the limb, invisible face-on.
import * as THREE from 'three';
import { plasmaAt } from './palette.js';

export function createAtmosphere(radius) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      glowColor: { value: plasmaAt(0.20) },
      power: { value: 3.2 },
      strength: { value: 0.85 },
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
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.045, 96, 72), material);
}
