// Which settings the tuning panel shows, and what control each one takes.
//
// DATA over the schema, nothing more: no bounds, no defaults, no help text
// live here. `settings.js` is the single source for all three, so a bound
// moved there moves this panel's slider with it -- which is what makes the
// spec's unreadability guards hold by construction on the SLIDERS rather than
// by a second check: `arcs.*.gain` cannot be dragged to 0 because the schema's
// floor of 0.05 IS the range of the control.
//
// That argument does NOT extend to `appearance.background`. Its control is an
// `<input type=color>`, whose range is the whole color space, so nothing stops
// a person picking white; the luminance cap holds because `coerce` REFUSES the
// value and settings_panel.js's `write()` snaps the swatch back to what is
// live. Two control kinds, two mechanisms -- do not describe the color row as
// bounded by construction.
//
// Imports settings.js and nothing else -- no three, no DOM -- so which rows
// exist is decided under `node --test` rather than by opening a browser.
//
// It is deliberately NOT all 89 settings. The panel is an instrument for
// tuning the wall by eye, so it carries the values whose right answer can
// only be found by looking at the display. `layers.*` are already toggles in
// the menu, and `input.*` are set-and-forget rather than things anyone
// watches.
import { entry } from './settings.js';

/**
 * `randomize` — the rule, written here because it is a judgement per row.
 *
 * A ROW IS RANDOMIZED IF CHANGING IT CHANGES THE CURRENT FRAME. Not how the
 * display behaves over the next two minutes: how it looks right now. Randomize
 * is a "show me something else" button, so what it may touch is what the eye
 * sees the instant it is clicked.
 *
 * That is why the flag is PER ROW and must not be replaced by a group check or
 * a path prefix. Two rows sit against their own group's intuition, and a rule
 * derived from the group name gets both of them wrong:
 *
 *   * `camera.distance` is IN, and it lives in "Camera pacing". It is not
 *     pacing at all -- it is how big the globe is on the wall, visible in the
 *     first frame after it changes.
 *   * `appearance.starRampMinutes` is OUT, and it lives in "Appearance". It
 *     only sets how fast star brightness crosses dawn and dusk, so unless the
 *     display happens to be inside a ramp at that moment, the frame is
 *     identical before and after.
 *
 * The five `camera.walk.*` rows are out for the same reason as the ramp: they
 * change the camera's MOTION rather than its picture, so randomizing them
 * makes the wall behave oddly for the next few minutes -- which is not what a
 * look-at-this button is for, and is far harder to notice you have done than a
 * color that just changed.
 *
 * `appearance.background` is out too, and that one is decided twice over: it
 * is a color control rather than a slider, and its luminance cap REFUSES
 * rather than clamps, so a randomizer aimed at it would spend half its rolls
 * being rejected over the one value that decides whether anything else on the
 * wall is legible.
 *
 * Every slider row must declare the flag explicitly -- `tunerRows()` throws
 * otherwise, and a test holds the set by name. A new row silently defaulting
 * into or out of the set is the failure that check exists for: into, and the
 * button starts moving something nobody decided it should; out of, and it
 * quietly stops being part of the feature with nothing saying so.
 */

/** Labels are written out rather than derived from the path.
 *
 *  Three arc classes share the same field names, so a label taken from the
 *  last segment would give three rows called "Gain" in one group; and the
 *  segment that disambiguates them (`flow`, `block`, `highlight`) is not the
 *  word a person reads for them. A derived label would also silently rename
 *  itself if a schema path were ever restructured. The test holds every path
 *  here to the schema, so a wrong path fails loudly instead. */
export const GROUPS = [
  {
    id: 'appearance',
    label: 'Appearance',
    rows: [
      { path: 'appearance.bloom.strength', label: 'Bloom strength', randomize: true },
      { path: 'appearance.bloom.radius', label: 'Bloom radius', randomize: true },
      { path: 'appearance.bloom.threshold', label: 'Bloom threshold', randomize: true },
      { path: 'appearance.bloom.knee', label: 'Bloom knee', randomize: true },
      { path: 'appearance.background', label: 'Background color',
        // Not a slider, and its cap refuses rather than clamps -- see the
        // note above `GROUPS`. Written out rather than left to the default so
        // the one non-slider row is not the one silent entry in the table.
        randomize: false },
      { path: 'appearance.starBrightness', label: 'Star brightness', randomize: true },
      { path: 'appearance.starDayGain', label: 'Star gain by day', randomize: true },
      { path: 'appearance.starRampMinutes', label: 'Star ramp minutes', randomize: false },
    ],
  },
  {
    id: 'arcs',
    label: 'Arcs',
    rows: [
      { path: 'traffic.flowsPerSecond', label: 'Flows drawn per second', randomize: true },
      { path: 'arcs.bodyOpacity', label: 'Arc body opacity', randomize: true },
      // No `arcs.highlight.colorAt`: a color rule carries its own color,
      // set per rule in the color-rules panel. The two fields a rule can
      // leave to the shared highlight spec are the two below.
      { path: 'arcs.flow.colorAt', label: 'Flow color', randomize: true },
      { path: 'arcs.flow.gain', label: 'Flow gain', randomize: true },
      { path: 'arcs.flow.bloomScale', label: 'Flow glow', randomize: true },
      { path: 'arcs.block.colorAt', label: 'Block color', randomize: true },
      { path: 'arcs.block.gain', label: 'Block gain', randomize: true },
      { path: 'arcs.block.bloomScale', label: 'Block glow', randomize: true },
      { path: 'arcs.highlight.gain', label: 'Color rule gain', randomize: true },
      { path: 'arcs.highlight.bloomScale', label: 'Color rule glow', randomize: true },
    ],
  },
  {
    id: 'camera',
    label: 'Camera pacing',
    rows: [
      { path: 'camera.distance', label: 'Distance from globe', randomize: true },
      // Note the `walk.` segment on all five below: `camera.cycleSeconds`
      // does not exist.
      { path: 'camera.walk.cycleSeconds', label: 'Cycle length', randomize: false },
      { path: 'camera.walk.holdSeconds', label: 'Hold over traffic', randomize: false },
      { path: 'camera.walk.spanDegrees', label: 'Walk span', randomize: false },
      { path: 'camera.walk.rampFloor', label: 'Walk ramp floor', randomize: false },
      { path: 'camera.walk.degreesPerSecond', label: 'Walk speed cap', randomize: false },
    ],
  },
];

const CONTROL = {
  number: 'slider',
  int: 'slider',
  color: 'color',
  bool: 'checkbox',
};

/**
 * How far one nudge of a slider moves.
 *
 * An int steps by 1 -- `traffic.flowsPerSecond` is a count of arcs and there
 * is no such thing as 13.5 of them. Everything else divides its own range
 * into 200, then rounds DOWN to a power of ten so the numbers a person lands
 * on read as numbers: a raw 1/200 of `camera.walk.cycleSeconds` (10..3600) is
 * 17.95, and a wall tuned to "cycle 1256.5s" is a wall nobody can write down.
 * Rounding down rather than to nearest keeps at least 200 stops on every
 * slider, which the test asserts.
 */
export function stepFor(e) {
  if (e.type === 'int') return 1;
  const raw = (e.max - e.min) / 200;
  return 10 ** Math.floor(Math.log10(raw));
}

/**
 * THE ONE PREDICATE for "Randomize may touch this row".
 *
 * Exported and used by all three readers -- the randomizer's own loop, the
 * per-row marker the panel draws, and the sentence that states the scope -- so
 * the button, the marks on screen and the printed count cannot answer the
 * question differently. Three copies of `control === 'slider' && randomize`
 * would drift the moment one of them was "simplified", and the drift would show
 * as a display that marks a row it does not move: worse than no mark at all,
 * since a wrong mark is still believed.
 */
export function isRandomized(row) {
  return !!row && row.control === 'slider' && row.randomize === true;
}

/**
 * The partition the panel's copy is written from: which rows Randomize rolls
 * and which it leaves.
 *
 * DERIVED, never written down. The count in the lead paragraph is the number of
 * rows carrying the flag, computed here, so adding a row to the panel moves the
 * sentence with it -- and more rows are expected. A hardcoded "17" is the exact
 * failure this guards: a claim on the wall that was true when it was typed and
 * is quietly false a release later, with nothing failing.
 *
 * `held` is every OTHER row, not "the sliders that are excluded": the color row
 * is left alone too, and a person reading "the other 7 are left as they are"
 * counts what is in front of them, which is rows.
 */
export function randomizeScope(rows = tunerRows()) {
  const rolled = rows.filter(isRandomized);
  const held = rows.filter((r) => !isRandomized(r));
  return { rolled, held, count: rolled.length, heldCount: held.length };
}

/** Every row the panel draws, flattened, in display order. */
export function tunerRows() {
  const out = [];
  for (const group of GROUPS) {
    for (const row of group.rows) {
      const e = entry(row.path);
      if (!e) throw new Error(`tuner: no such setting ${row.path}`);
      const control = CONTROL[e.type];
      if (!control) throw new Error(`tuner: no control for ${e.type} (${row.path})`);
      // Explicit, never defaulted: a slider that forgot the flag would either
      // join the randomizer or drop out of it silently, and both are decisions
      // nobody made. Same shape as the schema's "every number declares both
      // bounds" -- refuse at construction, with the offender named.
      if (control === 'slider' && typeof row.randomize !== 'boolean') {
        throw new Error(`tuner: ${row.path} does not declare randomize`);
      }
      const item = {
        path: row.path,
        group: group.id,
        groupLabel: group.label,
        label: row.label,
        control,
        help: e.help,
        randomize: row.randomize === true,
      };
      if (control === 'slider') {
        item.min = e.min;
        item.max = e.max;
        item.step = stepFor(e);
      }
      out.push(item);
    }
  }
  return out;
}
