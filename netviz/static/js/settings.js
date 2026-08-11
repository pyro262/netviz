// Every setting the renderer has, declared once.
//
// This file is DATA plus the pure functions over it: no three, no DOM, no
// fetch, so it runs under `node --test`. It is the single source for the
// panel's controls, for validation on the write API, for validation of an
// imported profile, and for the generated documentation.
//
// It deliberately carries NO default values. `config.js` is where the shipped
// numbers live and where the prose explaining them lives; a second copy here
// would drift, and the panel would then report the drift to every kiosk as a
// setting that disagrees with itself. `defaultOf()` reads config.js instead.
//
// Bounds, on the other hand, live HERE and nowhere else. A hand-edited profile
// must not be able to smuggle a value past the panel's limits, so the same
// clamp has to apply to the UI, the API and the file.
import { cfg } from './config.js';

/**
 * type      bool | int | number | enum | color | list
 * strategy  uniform  — write a uniform or a field; the next frame shows it
 *           rebuild  — dispose the affected object and construct it again
 *           relayout — rebuild AND resize, because the drawing area changed
 * help      why this value is what it is, lifted from the config.js comments
 */
export const SCHEMA = {
  'traffic.flowsPerSecond': {
    type: 'int', min: 1, max: 60, strategy: 'uniform',
    help: 'Flows drawn per second. The live feed can run tens of events per '
        + 'second and every arc blends additively, so drawing all of them sums '
        + 'into a wash that hides the globe. Blocks are never sampled.',
  },
  'arcs.bodyOpacity': {
    type: 'number', min: 0.04, max: 1.0, strategy: 'uniform',
    help: 'Opacity of an arc body. Below about 0.04 traffic is invisible.',
  },
  'arcs.flow.tube': {
    type: 'number', min: 0.001, max: 0.02, strategy: 'rebuild',
    help: 'Radius of a flow arc tube, in globe radii. Changing it rebuilds the '
        + 'arc pool, because the tube geometry is built once per pool slot.',
  },
  'appearance.background': {
    type: 'color', strategy: 'uniform',
    help: 'The sky. #0b0916 once the bloom pass stopped adding the background '
        + 'to itself; the wall wanted darker than the original.',
  },
  'rail.enabled': {
    type: 'bool', strategy: 'relayout',
    help: 'The right rail: block counts, netflow rate, feed health, clock. It '
        + 'takes 26% of the screen from the globe, so toggling it resizes the '
        + 'renderer and corrects the camera aspect.',
  },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function paths() { return Object.keys(SCHEMA); }

export function entry(path) {
  return Object.prototype.hasOwnProperty.call(SCHEMA, path) ? SCHEMA[path] : null;
}

/** The shipped value, from config.js. Never a copy kept here. */
export function defaultOf(path) { return cfg(path, undefined); }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Bring a value to the declared type and bounds.
 *
 * A number outside its range is CLAMPED rather than refused: a slider dragged
 * to the end and a hand-edited file are the same input here, and refusing
 * leaves the old value on screen with no feedback, which reads as a broken
 * control. A value of the wrong shape is refused, because there is no honest
 * way to guess what was meant.
 */
export function coerce(path, value) {
  const e = entry(path);
  if (!e) return { ok: false, why: 'no such setting' };
  switch (e.type) {
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, why: 'not a boolean' };
      return { ok: true, value };
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, why: 'not a finite number' };
      }
      const c = clamp(value, e.min, e.max);
      return { ok: true, value: e.type === 'int' ? Math.round(c) : c };
    }
    case 'enum':
      if (!e.values.includes(value)) {
        return { ok: false, why: `not one of ${e.values.join(', ')}` };
      }
      return { ok: true, value };
    case 'color':
      if (typeof value !== 'string' || !HEX.test(value)) {
        return { ok: false, why: 'not a #rgb or #rrggbb colour' };
      }
      return { ok: true, value };
    case 'list':
      if (!Array.isArray(value)) return { ok: false, why: 'not a list' };
      return { ok: true, value };
    default:
      return { ok: false, why: `unhandled type ${e.type}` };
  }
}

/** Split a patch into what can be applied and what cannot. Never throws: a bad
 *  key in an imported profile must not cost the display the other 79. */
export function validate(patch) {
  const accepted = {};
  const rejected = [];
  for (const [path, value] of Object.entries(patch || {})) {
    const c = coerce(path, value);
    if (c.ok) accepted[path] = c.value;
    else rejected.push({ path, value, why: c.why });
  }
  return { accepted, rejected };
}

/**
 * Group a patch by apply strategy.
 *
 * Order matters and is fixed by the caller, not here: uniform first because it
 * is free, then rebuild, then at most ONE relayout however many keys asked for
 * it -- a resize rebuilds the composer's render targets, so toggling three
 * things that each need one must still cost one.
 */
export function planApply(patch) {
  const plan = { uniform: [], rebuild: [], relayout: false };
  for (const path of Object.keys(patch || {})) {
    const e = entry(path);
    if (!e) continue;
    if (e.strategy === 'relayout') plan.relayout = true;
    else plan[e.strategy].push(path);
  }
  return plan;
}
