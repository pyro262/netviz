// Where each colored element sits on the ramp, and how a stored setting turns
// into a color.
//
// These `t` values were inline literals scattered across globe.js,
// atmosphere.js and ripples.js. Nothing held them together, so "what follows
// the theme" could not be stated, tested or shown on a panel. They are data
// now; the call sites read this table.
// ramp.js, not palette.js: this module must stay three-free so it can be
// imported under `node --test`. palette.js imports three and cannot be.
import { rampHexAt, activeRampStops } from './ramp.js';

/** The sentinel meaning "sample the active ramp at my own t". A string, not
 *  null or undefined: absence already means "not in the patch" everywhere in
 *  apply.js, and overloading it would make a deleted setting and a deliberate
 *  choice indistinguishable. */
export const AUTO = 'auto';

/** Ramp-derived elements. Changing a number here moves an element relative to
 *  every other one, which is a design relationship -- see the spec before
 *  touching any of them. */
export const ELEMENT_T = {
  coastline: 0.42,
  bordersWorld: 0.24,
  admin1: 0.26,
  // The block hue. bordersWatched and rippleBlock knock it back with their own
  // scalars at the call site, so "blocked" is one hue across the whole display.
  bordersWatched: 0.86,
  countryFlash: 0.86,
  // Cities sample a WINDOW: 0.72 + 0.25 * populationWeight. This is the base;
  // globe.js adds the weight term. An override keeps the ranking -- see
  // cityColor() there.
  cities: 0.72,
  atmosphere: 0.20,
  rippleFlow: 0.34,
  rippleBlock: 0.86,

  // ------------------------------------------------------------- the rail --
  // The rail's text is on the ramp like everything else, so picking a palette
  // recolors the numbers with the globe and a saved theme captures them. They
  // sit here rather than as standalone color settings for exactly that reason:
  // one reader (resolveColor), one vocabulary, one `auto` sentinel.
  railWordmark: 1.00,
  railClock: 0.89,
  railPanelTitle: 0.67,
  railBig: 0.89,
  railLabel: 0.44,
  railValue: 0.89,
  // NOT fitted to today's #fb9f3a, which is t~0.78 and only 0.11 from
  // railValue. An alarm color that drifts into the same neighborhood as the
  // ordinary value color stops reading as an alarm -- the same argument that
  // keeps the update watermark violet rather than amber. 0.60 is the value
  // whose WORST separation across all five presets still clears the test's
  // threshold; 0.65 does not, on cividis. Measured, not guessed.
  railAlarm: 0.60,
  railBars: 0.67,
};

/** Elements that are NOT on the ramp and must not be moved onto it.
 *  The aurora pair are emission lines -- 557.7nm oxygen green and 630nm red
 *  over violet -- and the highlight cyan matches the highlight arc class.
 *  Putting any of them on the ramp makes a different phenomenon read as
 *  network traffic, which is the one thing this display's color vocabulary is
 *  for. */
export const ELEMENT_LITERAL = {
  rippleHighlight: '#22d3ee',
  auroraLow: '#38ffa8',
  auroraHigh: '#c56cff',
};

export function isAuto(stored) { return stored === AUTO; }

/** The ONE reader. Every module and the theme panel ask this, so "is this
 *  element following the theme" has a single answer. Two resolvers drift, and
 *  the drift shows as a panel claiming a color the wall disagrees with. */
export function resolveColor(key, stored) {
  if (!isAuto(stored)) return stored;
  if (Object.prototype.hasOwnProperty.call(ELEMENT_LITERAL, key)) {
    return ELEMENT_LITERAL[key];
  }
  // No caller reaches this today with a key outside ELEMENT_T/ELEMENT_LITERAL
  // -- both tables are the twenty schema paths, and a test asserts they match
  // -- but ELEMENT_T[key] is silently undefined for anything else, and
  // rampHexAt(undefined, ...) used to fail three calls deep inside
  // hexToRgb(undefined) with a bare, unreadable TypeError. Named here instead,
  // at the one place that knows what went wrong.
  if (!Object.prototype.hasOwnProperty.call(ELEMENT_T, key)) {
    throw new Error(`resolveColor: "${key}" is not a known element`);
  }
  return rampHexAt(ELEMENT_T[key], activeRampStops());
}
