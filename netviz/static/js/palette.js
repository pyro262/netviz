// Plasma. Project-wide requirement -- never LCARS. Every module that picks a
// color imports from here so the globe, arcs and lights stay one system.
//
// The ramp is now selectable (0.6.0). Plasma is unchanged and is still what a
// fresh kiosk draws; the other four are its own matplotlib siblings, chosen
// for being perceptually uniform like it. That property is load-bearing: every
// `t` in the codebase keeps its meaning across a swap, so an element picked
// because it sits brighter than its neighbour still does. A hand-tuned ramp can
// invert that ordering at some t nobody checked, and the failure is silent.
import * as THREE from 'three';
import { cfg } from './config.js';

// All five sampled from matplotlib at ten even stops. PLASMA is byte-identical
// to what shipped before this file learned about the others -- a test asserts
// it, so "nothing changed for a default kiosk" is held rather than claimed.
export const RAMPS = {
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
           '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e',
            '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f',
          '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60',
            '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173',
            '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
};

export const RAMP_IDS = ['plasma', 'viridis', 'magma', 'inferno', 'cividis'];

// Kept for anything still importing the old name.
export const PLASMA = RAMPS.plasma;

let _activeStops = RAMPS.plasma;
let _activeColors = _activeStops.map((hex) => new THREE.Color(hex));

/** Point the ramp at a named preset or at a raw list of stops (the custom
 *  ramp). THREE.Color objects are built once here rather than per sample: this
 *  is called on a theme change, and rampAt is called per element. */
export function setActiveRamp(idOrStops) {
  const stops = Array.isArray(idOrStops) ? idOrStops : RAMPS[idOrStops];
  if (!stops || stops.length < 2) return;
  _activeStops = stops.slice();
  _activeColors = _activeStops.map((hex) => new THREE.Color(hex));
}

export function activeRampStops() { return _activeStops.slice(); }

/** Sample a ramp. t is clamped to [0,1]; 0 is the dark end, 1 the bright end.
 *  Omitting rampId samples the active ramp, which is what every call site in
 *  the renderer does. */
export function rampAt(t, rampId) {
  const cols = rampId
    ? RAMPS[rampId].map((hex) => new THREE.Color(hex))
    : _activeColors;
  const x = Math.min(1, Math.max(0, t)) * (cols.length - 1);
  const i = Math.floor(x);
  const j = Math.min(cols.length - 1, i + 1);
  return cols[i].clone().lerp(cols[j], x - i);
}

/** The historical name, kept because nine modules import it and a blanket
 *  rename is a diff across every colored file that says nothing. It has always
 *  meant "sample the ramp"; the ramp is simply selectable now. */
export function plasmaAt(t) { return rampAt(t); }

// Darkened from #151327 on 2026-08-09. Once the bloom pass stopped adding the
// background to itself (see post.js) the sky sat at exactly this value, and it
// was still lighter than the wall wanted. Stars carry the contrast now.
export const BACKGROUND = cfg('appearance.background', '#0b0916');
