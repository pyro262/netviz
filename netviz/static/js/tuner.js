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
// It is deliberately NOT all 122 settings. The panel is an instrument for
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
 * The "Arc shape" group is where the rule had to be argued rather than read
 * off, so the three calls are recorded here:
 *
 *   * `tube`, `lift` and `maxRise` are IN. All three are geometry -- how thick
 *     an arc is, how high it arches, where its apex is capped -- and all three
 *     are `rebuild`, so the handler clears the pool and the wall is visibly
 *     different in the same frame the value lands.
 *   * `life` is IN, and it is the one that could be argued either way. It is a
 *     DURATION, which sounds like behavior over the next minute rather than
 *     the current frame; but the schema pushes it into the arcs already in the
 *     air ("a shortened life retires them now"), so a roll to the 0.5s floor
 *     empties the wall in the same frame and a roll to the 60s ceiling packs
 *     it within a couple of seconds. Both are a different picture, not a
 *     different tempo, which is what settles it.
 *   * `speed` is OUT, and the mechanism that makes it look live is what rules
 *     it out. It is the one arc field re-read from the spec every frame, so it
 *     applies instantly -- but what it applies to is the RATE the traveling
 *     head advances. Every head is left exactly where it already was, so the
 *     frame at the instant of the change is pixel-identical and the difference
 *     only accumulates over the seconds after. That is the star-ramp case
 *     again, arrived at from the opposite direction: "applies live" and
 *     "changes the current frame" are two different questions.
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
    // FIRST, and open by default. It is the category a person walking up to the
    // panel is most likely to want, and the one whose effect is visible in the
    // same frame.
    //
    // The gradient bar and the preset picker are drawn by the panel, not
    // described here: they are not rows over schema paths -- the bar edits ten
    // entries of ONE path and the picker writes a path with no control kind in
    // CONTROL. See settings_panel.js's theme extras.
    id: 'theme',
    label: 'Theme',
    rows: [
      { path: 'appearance.colors.coastline', label: 'Coastline', randomize: false },
      { path: 'appearance.colors.bordersWorld', label: 'World borders', randomize: false },
      { path: 'appearance.colors.admin1', label: 'State/province borders', randomize: false },
      { path: 'appearance.colors.bordersWatched', label: 'Watched-country borders', randomize: false },
      { path: 'appearance.colors.countryFlash', label: 'Country flash', randomize: false },
      { path: 'appearance.colors.cities', label: 'Cities', randomize: false },
      { path: 'appearance.colors.atmosphere', label: 'Atmosphere glow', randomize: false },
      { path: 'appearance.colors.rippleFlow', label: 'Flow ripple', randomize: false },
      { path: 'appearance.colors.rippleBlock', label: 'Block ripple', randomize: false },
      { path: 'appearance.colors.rippleHighlight', label: 'Highlight ripple', randomize: false },
      { path: 'appearance.colors.auroraLow', label: 'Aurora low band', randomize: false },
      { path: 'appearance.colors.auroraHigh', label: 'Aurora high band', randomize: false },
    ],
  },
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
      { path: 'appearance.milkyway.brightness', label: 'Milky Way brightness', randomize: true },
      { path: 'appearance.milkyway.dust', label: 'Milky Way dust', randomize: true },
      { path: 'appearance.milkyway.clumping', label: 'Milky Way clumping', randomize: true },
      // Exposure is where the model is CUT OFF against the texture, not how
      // bright the band is drawn -- roll it and half the rolls clip the bright
      // half flat or drop the outskirts under one 8-bit step, both of which
      // read as "the randomizer broke the Milky Way" rather than as a look.
      // Brightness is the row that changes the picture, and it is in.
      { path: 'appearance.milkyway.exposure', label: 'Milky Way exposure', randomize: false },
    ],
  },
  {
    // The weather layer, kept out of Appearance because it is the one group
    // whose rows do nothing at all on a display that has no field -- a
    // collector without the dependency, or one that has never reached NOAA.
    // Grouped, a person dragging them and seeing nothing has one heading that
    // explains why rather than four rows scattered among ones that do work.
    id: 'clouds',
    label: 'Clouds',
    rows: [
      { path: 'clouds.opacity', label: 'Cloud opacity', randomize: true },
      { path: 'clouds.threshold', label: 'Cloud threshold', randomize: true },
      { path: 'clouds.nightDim', label: 'Cloud night brightness', randomize: true },
      { path: 'clouds.tint', label: 'Cloud color', randomize: false },
    ],
  },
  {
    // Kept out of Appearance for the same reason the clouds are: every row
    // here does nothing at all on a display whose collector has never reached
    // Blitzortung, and one heading that explains why beats five dead rows
    // scattered among ones that work.
    id: 'lightning',
    label: 'Lightning',
    rows: [
      { path: 'lightning.flashLife', label: 'Flash length', randomize: true },
      { path: 'lightning.glowLife', label: 'Afterglow length', randomize: true },
      { path: 'lightning.size', label: 'Strike size', randomize: true },
      { path: 'lightning.brightness', label: 'Strike brightness', randomize: true },
      { path: 'lightning.color', label: 'Strike color', randomize: false },
    ],
  },
  {
    id: 'arcs',
    label: 'Arcs',
    rows: [
      { path: 'traffic.flowsPerSecond', label: 'Flows drawn per second', randomize: true },
      { path: 'arcs.bodyOpacity', label: 'Arc body opacity', randomize: true },
      // NO COLORS IN THIS GROUP AT ALL. `arcs.flow.colorAt` and
      // `arcs.block.colorAt` were here until 0.6.1; the two built-in classes
      // are now colored in the COLOR RULES panel, beside the rules that
      // override them and with the same swatch control, because "what color
      // is a block" and "what color is this rule" are one question and were
      // being answered in two panels. `arcs.highlight.colorAt` was never
      // here for the matching reason: a rule carries its own color.
      { path: 'arcs.flow.gain', label: 'Flow gain', randomize: true },
      { path: 'arcs.flow.bloomScale', label: 'Flow glow', randomize: true },
      { path: 'arcs.block.gain', label: 'Block gain', randomize: true },
      { path: 'arcs.block.bloomScale', label: 'Block glow', randomize: true },
      { path: 'arcs.highlight.gain', label: 'Color rule gain', randomize: true },
      { path: 'arcs.highlight.bloomScale', label: 'Color rule glow', randomize: true },
    ],
  },
  {
    // The SHAPE of an arc, kept apart from the group above rather than folded
    // into it. Two reasons, and the second is the one that decided it: the
    // group above is about color and brightness and this one is about geometry
    // and timing, so a person hunting for "why do the arcs arch so high" has
    // one heading to read; and every `rebuild` row on the panel is in here, so
    // the group boundary is also where the pool-clearing rows start and stop.
    //
    // Five fields x three classes, written out rather than generated from a
    // loop over the classes. A loop would produce the paths correctly and then
    // have to invent the labels -- "Flow apex cap" is not derivable from
    // `arcs.flow.maxRise` -- and the schema is already the thing that stops
    // three copies of the shape drifting. See the label note above GROUPS.
    id: 'arcshape',
    label: 'Arc shape',
    rows: [
      // `life` IS randomized, and it is the one call in this group that is not
      // obvious. See the note under GROUPS for the argument.
      { path: 'arcs.flow.life', label: 'Flow life', randomize: true },
      { path: 'arcs.flow.tube', label: 'Flow thickness', randomize: true },
      // `speed` is out: it is the ONE arc field re-read from the spec every
      // frame, and that is exactly why it fails the rule -- every traveling
      // head is left precisely where it already was and only its rate changes.
      { path: 'arcs.flow.speed', label: 'Flow head speed', randomize: false },
      { path: 'arcs.flow.lift', label: 'Flow arc height', randomize: true },
      { path: 'arcs.flow.maxRise', label: 'Flow apex cap', randomize: true },
      { path: 'arcs.block.life', label: 'Block life', randomize: true },
      { path: 'arcs.block.tube', label: 'Block thickness', randomize: true },
      { path: 'arcs.block.speed', label: 'Block head speed', randomize: false },
      { path: 'arcs.block.lift', label: 'Block arc height', randomize: true },
      { path: 'arcs.block.maxRise', label: 'Block apex cap', randomize: true },
      { path: 'arcs.highlight.life', label: 'Color rule life', randomize: true },
      { path: 'arcs.highlight.tube', label: 'Color rule thickness', randomize: true },
      { path: 'arcs.highlight.speed', label: 'Color rule head speed', randomize: false },
      { path: 'arcs.highlight.lift', label: 'Color rule arc height', randomize: true },
      { path: 'arcs.highlight.maxRise', label: 'Color rule apex cap', randomize: true },
    ],
  },
  {
    id: 'surface',
    label: 'Atmosphere & surface',
    rows: [
      // The five numeric fields all change the current frame, so all five are
      // randomized. The two tints are colors, not sliders, so Randomize
      // (sliders-only) leaves them alone -- same as clouds.tint and
      // lightning.color above, which sit on this panel the same way.
      { path: 'appearance.atmosphere.power', label: 'Rim falloff', randomize: true },
      { path: 'appearance.atmosphere.strength', label: 'Rim brightness', randomize: true },
      { path: 'appearance.atmosphere.thickness', label: 'Shell thickness', randomize: true },
      { path: 'appearance.surface.softness', label: 'Terminator softness', randomize: true },
      { path: 'appearance.surface.dayAmbient', label: 'Day-side ambient', randomize: true },
      { path: 'appearance.surface.dayTint', label: 'Day-side tint', randomize: false },
      { path: 'appearance.surface.nightTint', label: 'Night-side tint', randomize: false },
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
  {
    id: 'rail',
    label: 'Rail',
    rows: [
      // NOT RANDOMIZED, and this is the one exception to the rule the flag
      // otherwise follows. By that rule -- "a row is randomized if changing it
      // changes the current frame" -- all five qualify. But text size is not a
      // LOOK the way a color or a glow is; it is legibility, and it is the one
      // thing on the rail somebody sets once for their own room and their own
      // eyes. A roll that resizes the numbers makes the wall unreadable and
      // hands back a Revert as the only way out, which is not a fair trade for
      // a button whose whole appeal is that it is safe to press.
      //
      // At the top of the range the rail also overruns its column and rows get
      // dropped -- the documented cost of a range chosen knowing it, and not
      // something a random roll should be able to inflict.
      { path: 'rail.scale.master', label: 'Text size (all of it)', randomize: false },
      { path: 'rail.scale.header', label: 'Wordmark and clocks', randomize: false },
      { path: 'rail.scale.panel', label: 'Panel headings', randomize: false },
      { path: 'rail.scale.big', label: 'Big numbers', randomize: false },
      { path: 'rail.scale.row', label: 'Rows and foot', randomize: false },
      // Colors, and they ARE rolled -- as catalogue entries, by the same roll
      // that reaches the other twelve. So every row in this section that
      // Randomize touches is a color, and the five sizes above are the ones it
      // deliberately leaves alone. Said out loud in the section note.
      { path: 'appearance.colors.railWordmark', label: 'Wordmark color', randomize: false },
      { path: 'appearance.colors.railClock', label: 'Clock color', randomize: false },
      { path: 'appearance.colors.railPanelTitle', label: 'Panel heading color', randomize: false },
      { path: 'appearance.colors.railBig', label: 'Big number color', randomize: false },
      { path: 'appearance.colors.railLabel', label: 'Row label color', randomize: false },
      { path: 'appearance.colors.railValue', label: 'Row value color', randomize: false },
      { path: 'appearance.colors.railAlarm', label: 'Alarm value color', randomize: false },
      { path: 'appearance.colors.railBars', label: 'Bar and sparkline color', randomize: false },
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
 * THE ONE PREDICATE for "dragging this row clears the arcs on screen".
 *
 * DERIVED FROM THE SCHEMA, never listed here. `settings.js` declares
 * `strategy: 'rebuild'` on the three arc fields baked into a slot's
 * TubeGeometry at spawn (`tube`, `lift`, `maxRise`), and `apply.js`'s
 * ARC_REBUILD_KEYS names the same three for the handler that clears the pool;
 * a test already asserts those two agree. A third list here -- of rows, this
 * time -- would be the one nothing holds to the other two, and it would go
 * wrong in the direction that matters: a row warning about a clear it does not
 * cause, or worse, a row that clears the wall with no warning on it.
 *
 * `strategy: 'rebuild'` is not unique to arc geometry, though -- it also means
 * "this shell gets rebuilt" for `appearance.atmosphere.thickness`, which is
 * the atmosphere's mesh and touches no arc at all. So the predicate scopes to
 * `arcs.*` rows on top of the rebuild flag; a rebuilding row outside that
 * prefix clears nothing on screen and must not carry the mark.
 *
 * Asked of the ROW rather than of the path so it reads like `isRandomized`
 * beside it, and so the panel never has to import `entry` to draw a mark.
 */
export function clearsArcs(row) {
  return !!row && row.rebuilds === true && row.path.startsWith('arcs.');
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
        // Read off the schema entry, not written per row -- see clearsArcs.
        rebuilds: e.strategy === 'rebuild',
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

/** One category's rows, for the per-category randomize and its count.
 *
 *  Filtered from tunerRows() rather than read off GROUPS directly, so a row
 *  here has been through the same construction checks -- schema entry present,
 *  control kind known, randomize flag declared -- as every row the panel draws.
 *  Reading GROUPS raw would let a category's button roll a row the panel itself
 *  refused to build. */
export function groupRows(id, rows = tunerRows()) {
  return rows.filter((r) => r.group === id);
}
