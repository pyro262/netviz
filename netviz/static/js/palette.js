// Plasma. Project-wide requirement -- never LCARS. Every module that picks a
// color imports from here so the globe, arcs and lights stay one system.
//
// The ramp is now selectable (0.6.0). Plasma is unchanged and is still what a
// fresh kiosk draws; the other four are its own matplotlib siblings, chosen
// for being perceptually uniform like it. That property is load-bearing: every
// `t` in the codebase keeps its meaning across a swap, so an element picked
// because it sits brighter than its neighbour still does. A hand-tuned ramp can
// invert that ordering at some t nobody checked, and the failure is silent.
//
// The ramp data and the pure hex math live in ramp.js, which imports nothing
// and is what tests/js/ramp.test.mjs exercises directly under `node --test`
// -- this file cannot be, because it imports three and this repo has no
// node_modules by design (see CLAUDE.md). This module is only the thin
// three-facing wrapper: hex string in, THREE.Color out.
// Relative import, not the bare 'three' every other three-facing module
// uses -- those resolve only through the browser import map (index.html)
// and are never node-tested. palette.js needs to be node-tested now too:
// BACKGROUND's `auto` resolution is exactly the bug that shipped a white
// sky, and there is no way to regression-test that without importing this
// module under `node --test`, which has no import map and cannot see a bare
// 'three' at all. Same fix and same reasoning as apply.js. Both specifiers
// resolve to the same URL in the browser, so there is no second three
// instance -- this only changes how the module resolves under Node.
import * as THREE from '../vendor/three/three.module.js';
import { cfg } from './config.js';
import { RAMPS, RAMP_IDS, THEME_SKIES, setActiveRamp, activeRampStops, rampHexAt } from './ramp.js';
import { AUTO, isAuto } from './elements.js';

export { RAMPS, RAMP_IDS, setActiveRamp, activeRampStops };

// Kept for anything still importing the old name.
export const PLASMA = RAMPS.plasma;

/** Sample a ramp as a THREE.Color. t is clamped to [0,1]; 0 is the dark end,
 *  1 the bright end. Omitting rampId samples the active ramp, which is what
 *  every call site in the renderer does. */
export function rampAt(t, rampId) {
  const stops = rampId ? RAMPS[rampId] : activeRampStops();
  return new THREE.Color(rampHexAt(t, stops));
}

/** The historical name, kept because nine modules import it and a blanket
 *  rename is a diff across every colored file that says nothing. It has always
 *  meant "sample the ramp"; the ramp is simply selectable now. */
export function plasmaAt(t) { return rampAt(t); }

// Darkened from #151327 on 2026-08-09. Once the bloom pass stopped adding the
// background to itself (see post.js) the sky sat at exactly this value, and it
// was still lighter than the wall wanted. Stars carry the contrast now.
//
// `auto` means "the active theme's sky". Resolved HERE rather than at the
// call site, because THREE.Color cannot parse the sentinel: it warns and
// silently leaves the color at its constructor default, which is WHITE --
// on a wall display, the worst possible failure. `appearance.background`
// shipped `'auto'` as its default in the same commit that added the twelve
// element colors, so the fallback below (`cfg('appearance.background', AUTO)`)
// never actually fires -- the key already exists in CONFIG. `appearance.theme`
// is not a setting yet (that is Task 6's), so the `'plasma'` default is what
// makes this correct now and stays correct once it is.
const _bg = cfg('appearance.background', AUTO);
export const BACKGROUND = isAuto(_bg)
  ? THEME_SKIES[cfg('appearance.theme', 'plasma')] ?? THEME_SKIES.plasma
  : _bg;
