// Which settings the tuning panel shows, and what control each one takes.
//
// DATA over the schema, nothing more: no bounds, no defaults, no help text
// live here. `settings.js` is the single source for all three, so a bound
// moved there moves this panel's slider with it -- which is also what makes
// the spec's unreadability guards hold by construction rather than by a
// second check. `appearance.background` cannot be dragged past its luminance
// cap and `arcs.*.gain` cannot reach 0, because those limits ARE the range of
// the control.
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
      { path: 'appearance.bloom.strength', label: 'Bloom strength' },
      { path: 'appearance.bloom.radius', label: 'Bloom radius' },
      { path: 'appearance.bloom.threshold', label: 'Bloom threshold' },
      { path: 'appearance.bloom.knee', label: 'Bloom knee' },
      { path: 'appearance.background', label: 'Background color' },
      { path: 'appearance.starBrightness', label: 'Star brightness' },
      { path: 'appearance.starDayGain', label: 'Star gain by day' },
      { path: 'appearance.starRampMinutes', label: 'Star ramp minutes' },
    ],
  },
  {
    id: 'arcs',
    label: 'Arcs',
    rows: [
      { path: 'traffic.flowsPerSecond', label: 'Flows drawn per second' },
      { path: 'arcs.bodyOpacity', label: 'Arc body opacity' },
      // No `arcs.highlight.colorAt`: a color rule carries its own color,
      // set per rule in the color-rules panel. The two fields a rule can
      // leave to the shared highlight spec are the two below.
      { path: 'arcs.flow.colorAt', label: 'Flow color' },
      { path: 'arcs.flow.gain', label: 'Flow gain' },
      { path: 'arcs.flow.bloomScale', label: 'Flow glow' },
      { path: 'arcs.block.colorAt', label: 'Block color' },
      { path: 'arcs.block.gain', label: 'Block gain' },
      { path: 'arcs.block.bloomScale', label: 'Block glow' },
      { path: 'arcs.highlight.gain', label: 'Color rule gain' },
      { path: 'arcs.highlight.bloomScale', label: 'Color rule glow' },
    ],
  },
  {
    id: 'camera',
    label: 'Camera pacing',
    rows: [
      { path: 'camera.distance', label: 'Distance from globe' },
      // Note the `walk.` segment on all five below: `camera.cycleSeconds`
      // does not exist.
      { path: 'camera.walk.cycleSeconds', label: 'Cycle length' },
      { path: 'camera.walk.holdSeconds', label: 'Hold over traffic' },
      { path: 'camera.walk.spanDegrees', label: 'Walk span' },
      { path: 'camera.walk.rampFloor', label: 'Walk ramp floor' },
      { path: 'camera.walk.degreesPerSecond', label: 'Walk speed cap' },
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

/** Every row the panel draws, flattened, in display order. */
export function tunerRows() {
  const out = [];
  for (const group of GROUPS) {
    for (const row of group.rows) {
      const e = entry(row.path);
      if (!e) throw new Error(`tuner: no such setting ${row.path}`);
      const control = CONTROL[e.type];
      if (!control) throw new Error(`tuner: no control for ${e.type} (${row.path})`);
      const item = {
        path: row.path,
        group: group.id,
        groupLabel: group.label,
        label: row.label,
        control,
        help: e.help,
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
