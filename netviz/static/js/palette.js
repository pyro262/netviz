// Plasma. Project-wide requirement -- never LCARS. Every module that picks a
// color imports from here so the globe, arcs and lights stay one system.
import * as THREE from 'three';
import { cfg } from './config.js';

export const PLASMA = [
  '#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
  '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921',
];

// Darkened from #151327 on 2026-08-09. Once the bloom pass stopped adding the
// background to itself (see post.js) the sky sat at exactly this value, and it
// was still lighter than the wall wanted. Stars carry the contrast now.
export const BACKGROUND = cfg('appearance.background', '#0b0916');

const _stops = PLASMA.map((hex) => new THREE.Color(hex));

/** Sample the ramp. t is clamped to [0,1]; 0 is deep indigo, 1 is pale yellow. */
export function plasmaAt(t) {
  const x = Math.min(1, Math.max(0, t)) * (_stops.length - 1);
  const i = Math.floor(x);
  const j = Math.min(_stops.length - 1, i + 1);
  return _stops[i].clone().lerp(_stops[j], x - i);
}
