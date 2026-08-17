// The five color ramps and the pure hex-sampling math behind them. Three-free
// on purpose -- see campath.js, orbit.validateZoomRange and
// schedule.auroraFromReading for the same convention: anything that can be
// tested without three.js gets its own module so `node --test` can import it
// directly. palette.js is the three-facing wrapper that turns these hex
// strings into THREE.Color objects for the renderer.
//
// The ramp is selectable (0.6.0). Plasma is unchanged and is still what a
// fresh kiosk draws; the other four are its own matplotlib siblings, chosen
// for being perceptually uniform like it. That property is load-bearing: every
// `t` in the codebase keeps its meaning across a swap, so an element picked
// because it sits brighter than its neighbour still does. A hand-tuned ramp can
// invert that ordering at some t nobody checked, and the failure is silent.

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

// Each ramp's sky. A dark ramp needs a darker ground: arcs blend additively, so
// the sky is the floor everything else has to lift off. Every one of these sits
// under its own ramp's derived luminance cap -- a test asserts it.
// PROPOSED values: legal by test, not yet judged on a wall.
export const THEME_SKIES = {
  plasma: '#0b0916',   // unchanged -- what the display has always drawn
  viridis: '#050d10',
  magma: '#0a0510',
  inferno: '#0d0604',
  cividis: '#060a14',
  custom: '#0b0916',
};

let _activeStops = RAMPS.plasma;

/** Point the ramp at a named preset or at a raw list of stops (the custom
 *  ramp). Rejects anything with fewer than two stops rather than leaving the
 *  ramp half-defined. */
export function setActiveRamp(idOrStops) {
  const stops = Array.isArray(idOrStops) ? idOrStops : RAMPS[idOrStops];
  if (!stops || stops.length < 2) return;
  _activeStops = stops.slice();
}

export function activeRampStops() { return _activeStops.slice(); }

// three.js r152+ enables ColorManagement, so Color('#hex') stores LINEAR values
// and lerp() interpolates there, not in sRGB. Interpolating in sRGB space gives a
// visibly different color (#8f10a1 vs #9112a1 at t=0.30 on plasma) -- and the wrong
// one. srgbToLinear/linearToSrgb are the sRGB transfer function and its inverse.
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r, g, b) {
  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v) => clampByte(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Sample a ramp of hex stops at t, matching three.js's Color.lerp under
 *  ColorManagement: sRGB stops are converted to linear, interpolated, and
 *  converted back. Pure -- does not mutate `stops`, same input always gives
 *  the same output. t is clamped to [0,1]; 0 is the dark end, 1 the bright
 *  end. */
export function rampHexAt(t, stops) {
  const clampedT = Math.min(1, Math.max(0, t));
  const x = clampedT * (stops.length - 1);
  const i = Math.floor(x);
  const j = Math.min(stops.length - 1, i + 1);
  const frac = x - i;

  const [r0, g0, b0] = hexToRgb(stops[i]);
  const [r1, g1, b1] = hexToRgb(stops[j]);

  const lerpChannel = (a, b) => {
    const la = srgbToLinear(a / 255);
    const lb = srgbToLinear(b / 255);
    const l = la + (lb - la) * frac;
    return linearToSrgb(l) * 255;
  };

  return rgbToHex(lerpChannel(r0, r1), lerpChannel(g0, g1), lerpChannel(b0, b1));
}
