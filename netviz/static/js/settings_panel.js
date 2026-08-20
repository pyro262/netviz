// The tuning panel: the settings whose right value can only be judged by
// looking at the wall.
//
// A LEFT RAIL, not an overlay. It narrows #stage exactly as the right rail
// does (`body.tuner #stage { left: var(--tuner-width) }`), so the globe is
// drawn beside the panel and never underneath it.
//
// This reverses the original decision, and BOTH halves of that argument are
// true, so both are recorded here:
//
//   * Narrowing the stage really does change the globe's apparent size. The
//     right rail is the measurement: 26% of the viewport makes the globe 74%
//     as wide for the same 35deg FOV, so every arc, sprite and bloom halo
//     scales with it. A panel that resizes the canvas therefore changes the
//     very thing it exists to measure.
//   * The display must not cover the globe. That constraint wins. The overlay
//     looked harmless at 2560x1440, where the globe spans x 771-1789 (a 509px
//     radius about center x=1280, measured with `__netviz.project()` over a
//     0.5deg grid) and 380px at the left edge is empty sky -- but at 1280x720
//     the globe spans roughly x 386-894 and a 380px panel reaches its edge.
//     A rail is right at both sizes; an overlay is right only at one.
//
// The honest consequence: anything tuned with the panel open is judged at the
// NARROWED size. A final look with the panel closed is part of the job -- open
// the panel, dial the value, close it, and check it still reads on the full
// wall before Keeping it.
//
// Mounted on document.body, NEVER on #stage: #stage is `position: fixed` and
// a fixed element creates a stacking context, so #rail -- a later sibling --
// paints over everything inside it. The menu hit exactly this and a z-index
// of 9999 changed nothing.
//
// TWO WAYS TO WRITE, and the distinction is the whole design:
//   preview  the UNWRAPPED applier. A drag changes the wall and stores
//            nothing, so experimenting costs nothing and a reload undoes it.
//   Keep     savePatch() of the touched paths only.
// Persisting all 39 would freeze three dozen values at today's config.js
// numbers, after which the display silently stops tracking any later change
// to them -- the exact failure `traffic.extraResolvers` was just fixed for.
import { GROUPS, tunerRows, isRandomized, randomizeScope, clearsArcs, groupRows }
  from './tuner.js';
import { defaultOf, entry, settingLabel, relativeLuminance, setThemeLibrary,
  BUILTIN_THEMES } from './settings.js';
import { savePatch } from './rulestore.js';
import { loadThemes, saveTheme, deleteTheme, themeNames, capturePaths }
  from './themestore.js';
import { isAuto, AUTO, resolveColor, ELEMENT_T, ELEMENT_LITERAL } from './elements.js';
import { RAMPS, THEME_SKIES } from './ramp.js';
import { randomizePatch, randomizeColors, RANDOMIZE_PATHS }
  from './randomize_color.js';

/** The patch a Keep writes: the touched paths at their current values.
 *
 *  Touched, not changed. A row someone dragged and put back is still their
 *  decision about this display and is written; a row that moved because
 *  something ELSE on the display wrote it is not the panel's to freeze.
 *
 *  A `persist: false` path is applied live and never written, the same rule
 *  `withPersistence` enforces for every other write path in the renderer.
 *  Keep calls savePatch() directly -- it writes the touched paths rather than
 *  a patch it just applied -- so the filter has to be repeated here, and it
 *  belongs in the function that DEFINES what a Keep writes rather than in the
 *  button handler that hands the result to storage. */
export function dirtyPatch(snapshot, current, dirty) {
  const out = {};
  for (const path of dirty) {
    if (!current.has(path)) continue;
    if (!snapshot.has(path)) continue;
    if (entry(path) && entry(path).persist === false) continue;
    out[path] = current.get(path);
  }
  return out;
}

/** The patch a Revert applies: the touched paths back at their snapshot. */
export function revertPatch(snapshot, dirty) {
  const out = {};
  for (const path of dirty) {
    if (!snapshot.has(path)) continue;
    out[path] = snapshot.get(path);
  }
  return out;
}

// ----------------------------------------------------------- the randomizer --
//
// Randomize sets the rows that decide WHAT THE DISPLAY LOOKS LIKE to a random
// value inside their own schema bounds. Four decisions are worth stating,
// because each one is the kind that gets "simplified" later:
//
//   * Which rows is `tuner.js`'s per-row `randomize` flag, and the rule is
//     "changing it changes the current frame" -- see the long note above
//     `GROUPS` for why that is a judgement per row rather than a group check.
//     29 of the 38 sliders qualify; the camera's five walk values, the star
//     ramp and the three arc head speeds change how the wall BEHAVES over the
//     seconds and minutes after, not how it looks now.
//   * NINE OF THE ROWS IT ROLLS CLEAR THE ARC POOL, and that is one blank and
//     one refill rather than nine. Randomize applies one path at a time, so
//     nine `rebuild` rows really do call `arcs.rebuild()` nine times in one
//     click -- but that function only flips `active`/`visible` off on every
//     pool slot, with nothing allocated or disposed, and all nine run
//     synchronously inside the click handler before a frame is drawn. The
//     second through ninth pass over an already-empty pool. So the calls
//     compound and the effect does not: the wall blanks once and refills from
//     the live feed, exactly as one drag of one of those rows does.
//   * Sliders only, on top of the flag. The one non-slider that is not a
//     checkbox is `appearance.background`, whose luminance cap REFUSES rather
//     than clamps -- a randomizer that spent half its rolls being refused would
//     read as a broken button, and the ground color is the one value that
//     decides whether anything else on the wall is legible at all.
//   * The bounds ARE the safety: `camera.distance`'s 3.3 floor is the limb-clip
//     threshold and `arcs.*.gain`'s 0.05 floor is what stops a class going
//     black, so no reachable roll of any single row can produce an unreadable
//     wall. That is the whole reason the bounds live in the schema rather than
//     in the controls. (Per row -- a legal COMBINATION is still reachable, and
//     Revert beside the button is what makes that survivable.)
//   * Snapped to the row's OWN step, so a randomized value is one the slider
//     could have been dragged to and the typed readout shows a number a person
//     could write down -- not 0.18300000000000002.
//
// Pure and injectable-random, so "always inside the bounds" is proved under
// `node --test` against the real catalogue rather than by rolling the dice on a
// wall and hoping.

/** Decimal places in a number, exponent form included -- 1e-7 is 7, not 0. */
function decimalsOf(x) {
  if (!Number.isFinite(x)) return 0;
  const s = String(x);
  const e = s.indexOf('e');
  if (e >= 0) {
    return Math.max(0, decimalsOf(Number(s.slice(0, e))) - Number(s.slice(e + 1)));
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * A random value for one `tunerRows()` entry: uniform over [min, max], snapped
 * to the row's step, counted from `min` so `rand() === 0` is exactly `min`.
 *
 * Returns null for anything that is not a slider -- a color or a checkbox is
 * never given a value, and null rather than "the current one" so a caller
 * cannot accidentally mark an untouched row dirty.
 *
 * The step count is CLAMPED to the last whole step inside the range, because
 * `max - min` is not always a multiple of `step`: rounding a roll just under 1
 * would otherwise land one step past `max`.
 *
 * NO SHIPPED ROW CAN REACH THAT CLAMP, and it is kept anyway. `stepFor`
 * divides every range by 200 and rounds down to a power of ten, so on today's
 * catalogue every span is a whole number of steps -- the line was measured to
 * never fire, and deleting it left all 486 tests green. It is a guard against
 * a future `stepFor`, not against a present bug, so the test that holds it
 * feeds in a SYNTHETIC row (0..1.3 by 0.5) rather than pretending a real one
 * exercises it. Do not write down that the catalogue proves this.
 */
export function randomizeValue(row, rand = Math.random) {
  if (!row || row.control !== 'slider') return null;
  const { min, max, step } = row;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(step > 0)) return null;
  const span = max - min;
  const maxSteps = Math.floor(span / step + 1e-9);
  let n = Math.round((rand() * span) / step);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > maxSteps) n = maxSteps;
  const places = Math.min(12, Math.max(decimalsOf(step), decimalsOf(min)));
  return Number((min + n * step).toFixed(places));
}

/**
 * The mark that says "Randomize may roll this row", drawn in every row's label
 * gutter and printed inside the sentence that explains it.
 *
 * ONE CONSTANT, used in both places. The explanation only works if the glyph in
 * the sentence is the glyph on the rows, and two literals -- one in the copy,
 * one in a stylesheet's `content` -- is the ordinary way that stops being true.
 * That is also why the mark is a real DOM node rather than a CSS `::before`:
 * the element can be counted, so the verifier can hold the number of marks to
 * the number of rows Randomize actually moves.
 */
export const RANDOM_MARK = '•';

/**
 * The mark that says "dragging this row clears the arcs on screen".
 *
 * WHY THE PANEL HAS TO SAY THIS AT ALL. Three of the arc-shape fields --
 * thickness, arc height and apex cap -- are baked into a slot's TubeGeometry
 * when the arc spawns, so `arcs.setSpec` cannot bend an arc already in the
 * air; the handler retires the whole pool instead and the wall refills over
 * the next few seconds. That is correct and there is no version of it that is
 * not: the alternative is a control that appears dead until a block happens to
 * arrive, and block arcs live 18s and arrive rarely. What is NOT acceptable is
 * an unannounced one. On a wall, every arc vanishing the instant you touch a
 * slider reads as the collector dying, and the person tuning is the last
 * person who should be guessing whether they just broke the feed.
 *
 * A SUFFIX INSIDE THE LABEL, not a second gutter. The randomize mark is a
 * fixed-width gutter because it has to keep every label in one column; this
 * one appears on 9 rows of 39 and trails the words it qualifies, so it costs
 * no width on the rows that do not carry it and cannot shift the label column
 * on the ones that do. Same structural safety as the gutter: `.tuner-row` sets
 * no `flex-wrap`, so a label short of room wraps inside itself.
 *
 * One constant, used by the rows and by the sentence that explains them --
 * same rule as RANDOM_MARK, and for the same reason.
 */
export const REBUILD_MARK = '↻';

/**
 * What the panel prints about Randomize's scope, in visible copy.
 *
 * NOT A TOOLTIP, and that is the whole point of this function existing. The
 * button's `title` still carries the longer version, but a wall display is not
 * hovered -- nobody is standing at it with a pointer -- so the answer to "what
 * will this do" has to be on the panel. Same call the color-rules panel's
 * MATCH legend made in 0.4.5, for the same reason: a control whose scope is
 * invisible until you hover has no scope as far as the room is concerned.
 *
 * Both numbers come from `randomizeScope()` rather than from this file, so the
 * sentence cannot go stale as rows are added -- see the note there. Written in
 * plain language on purpose: "the settings that change how the display looks"
 * is what a person can act on, where "the rows whose `randomize` flag is set"
 * is this file talking to itself.
 */
/** Whether THIS PANEL's Randomize will move a row.
 *
 *  NOT `isRandomized` alone. That flag is about sliders -- "does changing this
 *  change the current frame" -- and it is false for every color row. But 0.7.0's
 *  Randomize also rolls the whole element catalogue, so a panel that marked only
 *  the sliders printed "changes only the 47 settings marked below" and then
 *  moved 69. A display that miscounts its own button is the exact failure the
 *  scope line was written to prevent, and verify_tuner's case 12 caught it. */
export function panelRolls(spec) {
  return isRandomized(spec) || RANDOMIZE_PATHS.includes(spec.path);
}

/** The scope as the PANEL means it: sliders plus the catalogue colors it rolls.
 *  Shaped like `randomizeScope()`'s return so one line of copy serves both. */
export function panelScope(rows = tunerRows()) {
  const rolled = rows.filter(panelRolls);
  const held = rows.filter((r) => !panelRolls(r));
  return { rolled, held, count: rolled.length, heldCount: held.length };
}

export function randomizeScopeLine(scope = randomizeScope()) {
  const { count, heldCount } = scope;
  return `Randomize changes only the ${count} settings that affect how the `
       + `display looks -- the rows marked ${RANDOM_MARK} below. It leaves the `
       + `other ${heldCount} as they are, including the camera's timings.`;
}

/**
 * What the panel prints about the rebuilding rows, in visible copy beside the
 * randomize scope.
 *
 * The count is DERIVED from the rows, for the same reason the randomize scope
 * is: the set is whatever `settings.js` declares `rebuild`, and a number typed
 * here would be a claim on a wall that nothing holds to the schema.
 *
 * It names the consequence AND the reassurance, the way confirm.js's questions
 * carry both a `will` and a `wont`: "every arc disappears" alone reads as a
 * fault report, and the half that says they come straight back is what makes
 * the first half worth printing. Returns the empty string when no row on the
 * panel rebuilds, so a future panel that drops them all is silent rather than
 * explaining a mark nobody can see.
 */
export function rebuildNoteLine(rows = tunerRows()) {
  const n = rows.filter(clearsArcs).length;
  if (!n) return '';
  return `The ${n} rows marked ${REBUILD_MARK} change the SHAPE of an arc, `
       + `which is built when the arc is drawn. Dragging one clears the arcs `
       + `on screen and they come back over the next few seconds. That is the `
       + `setting working, not the feed dropping.`;
}

/**
 * The longer version, for the button's `title`: the same scope, plus the held
 * rows BY NAME.
 *
 * The names are derived from the partition, not written out. Review caught the
 * hand-written version claiming the held set was "the camera's timings and the
 * background color", which silently omitted `appearance.starRampMinutes` --
 * neither of those things, and held for a third reason again. The counts were
 * already derived and did not protect it, because a CHARACTERIZATION is a
 * separate claim from a count: it is the half that goes stale the first time a
 * row is held for a new reason. So it is derived too, and the vocabulary is the
 * row's own on-screen `label` rather than the wording `settingLabel()` derives
 * from the schema path --
 * the tooltip is pointing at rows a person can see, and "Walk speed cap" is
 * what is printed beside the one it means where "camera walk degrees per
 * second" is the schema talking.
 *
 * The printed line stays hedged ("including the camera's timings") on purpose:
 * it is the one-glance version, and the marks answer "which ones" precisely.
 */
export function randomizeHeldNames(scope = randomizeScope()) {
  return scope.held.map((r) => r.label).join(', ');
}

export function randomizeTooltip(scope = randomizeScope()) {
  return `Give every setting that changes how the display LOOKS a random value `
       + `inside its own limits -- the ${scope.count} rows marked ${RANDOM_MARK}. `
       + `The other ${scope.heldCount} are left alone: ${randomizeHeldNames(scope)}. `
       + `Every value stays inside its own limits, nothing is remembered, and `
       + `"Revert" puts it all back in one click.`;
}

// ------------------------------------------------------- the three questions --
//
// Each of Keep, Revert and Close ends the pending work in a way clicking again
// does not undo, so each asks first -- and the words are built HERE, as pure
// functions of the pending paths, for the same reason main.js builds the reset
// dialog's words itself: confirm.js is handed its sentences precisely so the
// caller that knows what is about to happen decides them, and so they can be
// proved under `node --test` rather than read off a screenshot.
//
// Every one of them names the settings ACTUALLY pending, via settingLabel(),
// rather than saying "your changes" -- "what does this do" is answered for this
// screen instead of in general -- and every one carries a `wont`, which is the
// half confirm.js exists to enforce: a warning that only lists consequences
// reads as "something bad is happening" and gets clicked through.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How many settings a question names before it summarizes the rest.
 *
 *  Six, because the list exists to answer "which ones?" for the case somebody
 *  actually has in their head -- a handful of rows they dragged -- and past
 *  that it stops being an answer and becomes a wall of text. Randomize is what
 *  made this concrete: a Close after one names every pending setting in a
 *  single sentence -- 615 characters at the 23 rows it moved before the look
 *  rule landed, and still hundreds at today's 29 -- in a dialog whose whole
 *  argument is that people read it. The COUNT is always exact and always first, so nothing is hidden;
 *  only the enumeration is bounded. */
const NAME_LIMIT = 6;

/** The pending paths as words: "the stars layer, arcs body opacity".
 *
 *  Over the limit it truncates and says so, rather than either printing
 *  everything or silently listing the first few as though they were all of
 *  them. The remainder is always `paths.length - limit`, so a full Randomize --
 *  29 rows at the time of writing, 17 before the arc-shape group was added --
 *  reads "..., and 11 more". The figure moves with the set, which is why it is
 *  derived here and stated with its date rather than written down as a
 *  constant somebody would later reason from. */
function named(paths, limit = NAME_LIMIT) {
  const labels = paths.map(settingLabel);
  if (labels.length <= limit) return labels.join(', ');
  const rest = labels.length - limit;
  return `${labels.slice(0, limit).join(', ')}, and ${rest} more`;
}

/** Keep: remember the pending settings on this screen. */
export function keepQuestion(paths = []) {
  const n = paths.length;
  return {
    title: n ? `Remember ${plural(n, 'setting')} on this screen?` : 'Nothing to keep',
    lead: 'Keeping writes what you changed into this web browser, so this '
        + 'display starts with it next time. Everything else is left alone.',
    // Empty when nothing is pending, which turns the dialog into a one-button
    // acknowledgement: a yes/no over an action with no effect teaches that Yes
    // does nothing. The button is disabled in that state, so this is the
    // degenerate case rather than the expected one.
    will: n ? [
      `Remember ${plural(n, 'setting')} you changed here: ${named(paths)}.`,
      'Write them to this web browser only, on this screen.',
      'Make them what this display starts with after a reload.',
    ] : [],
    wont: [
      'Change anything on the collector, or on any other display.',
      'Touch your color rules.',
      'Touch any setting you did not change in this panel.',
    ],
    note: n ? null
            : 'Nothing has been changed in this panel yet, so there is nothing '
              + 'to remember.',
    confirmLabel: 'Yes, keep them here',
    cancelLabel: 'No, leave them unkept',
  };
}

/** Revert: put the pending settings back where they came from. */
export function revertQuestion(paths = []) {
  const n = paths.length;
  return {
    title: n ? `Put ${plural(n, 'setting')} back?` : 'Nothing to put back',
    lead: 'Reverting returns the wall to what it showed when this panel opened, '
        + 'or to what you last kept, whichever is later.',
    will: n ? [
      `Put ${plural(n, 'setting')} back: ${named(paths)}.`,
      'Return the wall to what it showed when this panel opened, or to what '
        + 'you last kept, whichever is later.',
      'Lose the values you are trying out, which are not written down anywhere.',
    ] : [],
    wont: [
      'Change anything you have already kept -- that stays kept.',
      'Touch any setting you did not change in this panel.',
      'Change anything on the collector, or on any other display.',
    ],
    note: n ? null
            : 'Nothing has been changed in this panel yet, so there is nothing '
              + 'to put back.',
    confirmLabel: 'Yes, put them back',
    cancelLabel: 'No, leave them as they are',
  };
}

/**
 * Close with pending changes: closing is a Revert, so it asks the same way.
 *
 * Returns NULL when nothing is pending, and that is the whole contract: there
 * is nothing to confirm, so the caller closes immediately with no dialog at
 * all. Handing back an acknowledgement here instead would put a modal in front
 * of every ordinary close of an untouched panel.
 */
export function closeQuestion(paths = []) {
  const n = paths.length;
  if (!n) return null;
  return {
    title: `Close and discard ${plural(n, 'change')}?`,
    lead: 'Closing this panel is a revert: nothing you are trying out survives '
        + 'it, because a preview left on the wall after the panel is gone is a '
        + 'display in a state nothing recorded.',
    will: [
      `Discard ${plural(n, 'setting')} you changed and have not kept: ${named(paths)}.`,
      'Put the wall back to how it was before you opened this panel.',
      'Close the panel.',
    ],
    wont: [
      'Change anything you have already kept -- that stays kept.',
      'Change anything on the collector, or on any other display.',
      'Touch your color rules.',
    ],
    note: 'To keep these instead, cancel and click "Keep" -- or use the middle '
        + 'button here, which does both.',
    confirmLabel: 'Yes, close and discard',
    cancelLabel: 'No, go back to the panel',
    // The third answer. It exists because "close" and "keep" were two separate
    // decisions that a person almost always makes together, and the panel used
    // to make them cancel out of one dialog to reach the other button.
    altLabel: 'Keep them, then close',
  };
}

// ---------------------------------------------------------------- the DOM --

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param onLayout called EXACTLY ONCE after the panel opens and exactly once
 *   after it closes, with `body.tuner` already set or cleared and the panel
 *   already in or out of the document -- so a caller that measures #stage in
 *   it sees the narrowed box, never the one from before the toggle. Same
 *   ordering contract rail.js's start() states, and for the same reason: a
 *   relayout rebuilds the composer's render targets, so it must happen once
 *   per toggle and not once per module that would like it to.
 */
/** The element keys, in the same order apply.js's colorHandlers() declares
 *  them -- also the order randomizeColors() returns, so a randomized patch and
 *  a row list never have to be reconciled against each other. */
export const ELEMENT_KEYS = [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)];

const THEME_PATH = 'appearance.theme';
const RAMP_PATH = 'appearance.customRamp';
const STOP_COUNT = 10;

const elementPath = (key) => `appearance.colors.${key}`;
const copyOf = (v) => (Array.isArray(v) ? v.slice() : v);

/** Every path this panel snapshots, and therefore every path Revert, Keep and
 *  Close can act on.
 *
 *  RANDOMIZE_PATHS is unioned in rather than listed: the randomizer reaches
 *  beyond the rows the panel draws -- the two arc colors, the two surface
 *  tints, the three atmosphere numbers -- and a path it can WRITE but Revert
 *  cannot RESTORE is a one-way door. Deriving the set from the roller means
 *  adding something to the randomizer cannot silently escape the undo. The
 *  extra paths have no row here; they are snapshotted and reverted all the
 *  same. Moved intact from theme_panel.allPaths() when the two panels merged. */
export function allPaths(rows = tunerRows()) {
  const base = [THEME_PATH, RAMP_PATH, ...rows.map((r) => r.path)];
  return [...new Set([...base, ...RANDOMIZE_PATHS])];
}

export function createSettingsPanel({ preview, settings, storage, root, onClose,
                                      onLayout, confirmer, prompt } = {}) {
  // Injected so the unit suite can answer it. A panel that can only be tested
  // against a real browser's window.prompt is a panel whose save path is not
  // tested at all.
  const promptFn = prompt || ((msg) => (typeof window !== 'undefined'
    ? window.prompt(msg) : null));
  const mount = root || document.body;
  let node = null;
  // Which categories are expanded. UI STATE, NOT A SETTING: no schema path, no
  // persistence. Theme opens, the other eight start closed, every time. A
  // persisted collapse state is one more thing that can disagree with what is
  // on screen, for a control whose whole cost is one click.
  let openGroups = new Set(['theme']);
  let gradientBar = null;
  let presetSelect = null;
  let summaryLine = null;
  let stopRefs = [];
  // The value every row held when the panel opened -- what Revert returns to,
  // and what Keep re-baselines onto.
  let snapshot = new Map();
  // The live value of every row, as the panel last wrote it.
  let current = new Map();
  // Paths the person actually moved. Only these are ever written or reverted.
  let dirty = new Set();
  let rowRefs = new Map();

  function isOpen() { return node !== null; }

  function setNote(text) {
    const n = node && node.querySelector('.tuner-note');
    if (n) n.textContent = text || '';
  }

  /** How many rows are pending, in the header beside the buttons that act on
   *  them. Also the enable state of those two buttons: a Keep or a Revert over
   *  nothing teaches that the button does nothing, the same argument confirm.js
   *  makes about a yes/no over an action with no effect -- and it is what stops
   *  the confirmations ever asking a question with no meaning. */
  function refreshActions() {
    if (!node) return;
    const n = dirty.size;
    const count = node.querySelector('.tuner-count');
    if (count) {
      count.textContent = n
        ? `${n} setting${n === 1 ? '' : 's'} changed, not yet kept`
        : 'No changes';
    }
    const keep = node.querySelector('.tuner-keep');
    const revert = node.querySelector('.tuner-revert');
    if (keep) keep.disabled = n === 0 || !storage;
    if (revert) revert.disabled = n === 0;
    if (summaryLine) summaryLine.textContent = headerLine();
  }

  function markDirty(path, value) {
    current.set(path, value);
    dirty.add(path);
    const refs = rowRefs.get(path);
    if (refs) refs.row.classList.add('tuner-dirty');
    refreshActions();
  }

  /** Write one row live. The applier coerces and clamps, so what lands on the
   *  wall can differ from what the control asked for -- the readout is
   *  therefore set from what came BACK, never from the input's own value. */
  function write(path, value) {
    const out = preview.apply({ [path]: value });
    if (out.rejected && out.rejected.length) {
      setNote(`${path}: ${out.rejected[0].why}`);
      // A rejection never reaches the wall, so the control must snap back to
      // what is actually live rather than keep the refused value on screen --
      // otherwise the swatch/box disagrees with its own readout AND with the
      // globe, and since the path was never marked dirty, neither Revert nor
      // Close would ever put it right.
      syncRow(path);
      return false;
    }
    setNote('');
    markDirty(path, defaultOf(path));
    syncRow(path);
    return true;
  }

  /** Several paths in one apply, for the edits that are one decision but two
   *  writes -- a gradient stop forking the preset to `custom`, or a whole
   *  randomized roll. One `preview.apply()` call, so the fan-out that recolors
   *  every auto element runs once rather than once per key. */
  function writePatch(patch) {
    const out = preview.apply(patch) || {};
    if (out.rejected && out.rejected.length) {
      setNote(`${out.rejected[0].path}: ${out.rejected[0].why}`);
      for (const path of Object.keys(patch)) syncRow(path);
      return false;
    }
    setNote('');
    for (const path of Object.keys(patch)) {
      current.set(path, copyOf(defaultOf(path)));
      dirty.add(path);
      const refs = rowRefs.get(path);
      if (refs) refs.row.classList.add('tuner-dirty');
    }
    for (const path of Object.keys(patch)) syncRow(path);
    refreshActions();
    return true;
  }

  /** What a color row's SWATCH should show. `<input type=color>` cannot hold
   *  the string `'auto'` -- the browser silently sanitizes an invalid value
   *  to black, so a stock kiosk (appearance.background defaults to `'auto'`)
   *  showed a black chip beside the text "auto", which looked like the sky
   *  had no color at all rather than a resolved one. `appearance.background`
   *  is the only row on this panel that allows `auto` today; resolve it the
   *  same way applyTheme's own handler does in apply.js, so the swatch always
   *  shows what the sky actually is rather than a sanitizer's fallback. */
  function resolvedSwatch(path, v) {
    if (!isAuto(v)) return v;
    if (path === 'appearance.background') {
      return THEME_SKIES[defaultOf(THEME_PATH)] || THEME_SKIES.plasma;
    }
    // A catalogue color on `auto` resolves through the ACTIVE ramp, the same
    // way the wall resolves it -- one reader, so the swatch and the globe
    // cannot disagree. A wrong readout that looks confident is worse than no
    // readout, because it is still believed.
    const key = ELEMENT_KEYS.find((k) => elementPath(k) === path);
    return key ? resolveColor(key, AUTO) : v;
  }

  /** Put a row's controls back in step with the live value. */
  function syncRow(path) {
    if (path === THEME_PATH || path === RAMP_PATH) {
      syncPreset();
      syncGradient();
      // Every AUTO color row's displayed color is DERIVED from the active ramp
      // (resolveColor(key, AUTO)), not stored -- so the instant the ramp moves,
      // EVERY such row is stale, not just the one path this patch happened to
      // name. Found live by verify_theme.py case 4: the wall recolored
      // correctly (apply.js's applyTheme fan-out pushes every auto element),
      // but the panel kept showing the OLD swatches -- an element the panel
      // claims is following the theme while the wall disagrees.
      for (const key of ELEMENT_KEYS) syncRow(elementPath(key));
      return;
    }
    const refs = rowRefs.get(path);
    if (!refs) return;
    const v = defaultOf(path);
    if (refs.range) {
      refs.range.value = String(v);
      refs.number.value = String(v);
    } else if (refs.color) {
      refs.color.value = resolvedSwatch(path, v);
      refs.swatchText.textContent = String(v);
      // DISABLED WHEN ALREADY AUTO, which is the state in which clicking it
      // would do nothing -- the same rule renderRow applies when it builds the
      // button. This line was inverted from 0.6.0 until 0.7.0 and nothing
      // caught it: `appearance.background` was the only allowAuto row on this
      // panel, and its swatch is the one control an operator rarely returns to
      // the theme. The merge put twelve element rows through the same syncRow
      // and verify_theme.py's case 5 went red on the first live run.
      if (refs.autoBtn) refs.autoBtn.disabled = isAuto(v);
    } else if (refs.check) {
      refs.check.checked = !!v;
    }
  }

  function activeStops() {
    const theme = defaultOf(THEME_PATH);
    if (theme === 'custom') return copyOf(defaultOf(RAMP_PATH));
    return copyOf(RAMPS[theme] || RAMPS.plasma);
  }

  function syncPreset() {
    if (presetSelect) presetSelect.value = defaultOf(THEME_PATH);
    syncDeleteButton();
  }

  function syncGradient() {
    if (!gradientBar) return;
    const stops = activeStops();
    gradientBar.style.background = `linear-gradient(to right, ${
      stops.map((c, i) => `${c} ${(i / (STOP_COUNT - 1)) * 100}%`).join(', ')})`;
    for (let i = 0; i < STOP_COUNT; i += 1) {
      if (stopRefs[i]) stopRefs[i].value = stops[i];
    }
  }

  /** The one line that says which palette is active and how much of it has
   *  been overruled.
   *
   *  "set by you", not "overridden": the panel is read by whoever walks up to
   *  the wall, and `override` is the word the code uses for the mechanism, not
   *  a word that tells a person what they are looking at. Same reason `auto`
   *  and `ramp` do not appear in any string this file draws. */
  function headerLine() {
    const theme = defaultOf(THEME_PATH);
    const n = ELEMENT_KEYS.filter((k) => !isAuto(defaultOf(elementPath(k)))).length;
    return n ? `${theme}, ${n} set by you` : String(theme);
  }

  /** The first stop edit forks the active preset to `custom` IN THE SAME
   *  apply, so the fan-out that recolors every auto element runs once, not
   *  once per key. Every stop edit AFTER that sends only the ramp, never
   *  re-sending the theme: the ~4000-vertex city BufferAttribute rewrite the
   *  theme fan-out triggers is too expensive to repeat on every drag once the
   *  fork has already happened. */
  function setStop(index, hex) {
    const stops = activeStops();
    stops[index] = hex;
    const wasCustom = defaultOf(THEME_PATH) === 'custom';
    const patch = { [RAMP_PATH]: stops };
    if (!wasCustom) patch[THEME_PATH] = 'custom';
    return writePatch(patch);
  }

  /** Rebuild the picker from the built-ins plus the library.
   *
   *  A disabled `<option>` separates them rather than an <optgroup>: the fake
   *  DOM the unit suite runs against implements createElement and append and
   *  nothing else, and a control that is only correct in a real browser is a
   *  control whose correctness is untested. */
  function syncPresetOptions() {
    if (!presetSelect) return;
    presetSelect.replaceChildren();
    for (const id of BUILTIN_THEMES) {
      const opt = el('option', null, id);
      opt.value = id;
      presetSelect.append(opt);
    }
    const names = themeNames(loadThemes(storage).themes);
    if (names.length) {
      const sep = el('option', 'theme-sep', '--- saved ---');
      sep.disabled = true;
      presetSelect.append(sep);
      for (const name of names) {
        const opt = el('option', null, name);
        opt.value = name;
        presetSelect.append(opt);
      }
    }
    presetSelect.value = defaultOf(THEME_PATH);
    syncDeleteButton();
  }

  /** Delete is ABSENT while a built-in is selected, not disabled: netviz's own
   *  palettes cannot be deleted, and a greyed button advertises an action
   *  nobody in the room can take. Same rule the menu follows for a panel it was
   *  not built with. */
  function syncDeleteButton() {
    if (!node) return;
    const holder = node.querySelector('.theme-pick');
    if (!holder) return;
    const existing = holder.querySelector('.theme-delete');
    const deletable = !BUILTIN_THEMES.includes(defaultOf(THEME_PATH));
    if (deletable && !existing) {
      const btn = el('button', 'theme-delete', 'Delete');
      btn.title = 'Remove this saved theme from this display. The colors stay '
                + 'on the wall.';
      btn.addEventListener('click', askDelete);
      holder.append(btn);
    } else if (!deletable && existing) {
      existing.remove();
    }
  }

  /** Save the LIVE look under a name -- pending, un-Kept changes included,
   *  because "save this look" means the one on the wall. It is deliberately NOT
   *  a Keep: keeping is a statement about what this display starts with, saving
   *  is a statement about a look worth coming back to, and the note line says
   *  which one just happened so the two are never confused. */
  function saveThemeAs(name) {
    const patch = {};
    for (const path of capturePaths()) patch[path] = copyOf(defaultOf(path));
    const out = saveTheme(storage, name, patch);
    if (!out.ok) { setNote(out.error); return; }
    setThemeLibrary(themeNames(loadThemes(storage).themes));
    syncPresetOptions();
    setNote(`Saved the current colors as "${name}". This is not a Keep -- `
          + 'anything pending is still pending.');
  }

  function askSave() {
    const name = (promptFn('Name this theme') || '').trim();
    if (!name) return;
    if (BUILTIN_THEMES.includes(name)) {
      setNote(`"${name}" is one of netviz's own palettes -- pick another name.`);
      return;
    }
    const existing = loadThemes(storage).themes;
    if (!Object.prototype.hasOwnProperty.call(existing, name)) { saveThemeAs(name); return; }
    askThen({
      title: `Replace the saved theme "${name}"?`,
      lead: 'A theme with this name is already saved on this display.',
      will: [
        `Replace the saved theme "${name}" with the colors on screen now.`,
        'Lose the colors that theme held, which are not written down anywhere else.',
      ],
      wont: [
        'Change what is on the wall right now.',
        'Keep anything -- saving a theme and keeping a setting are different things.',
        'Touch any other saved theme.',
      ],
      confirmLabel: `Yes, replace "${name}"`,
      cancelLabel: 'No, keep the saved one',
    }, () => saveThemeAs(name));
  }

  function askDelete() {
    const name = defaultOf(THEME_PATH);
    if (BUILTIN_THEMES.includes(name)) return;
    askThen({
      title: `Delete the saved theme "${name}"?`,
      lead: "This removes it from this display's list of saved themes.",
      will: [
        `Delete the saved theme "${name}".`,
        'Leave the colors it holds on the wall, as Custom, until you change them.',
      ],
      wont: [
        'Change what is on the wall right now.',
        "Touch netviz's own palettes, or any other theme you have saved.",
        'Change anything on the collector, or on any other display.',
      ],
      confirmLabel: `Yes, delete "${name}"`,
      cancelLabel: 'No, keep it',
    }, () => {
      const out = deleteTheme(storage, name);
      if (!out.ok) { setNote(out.error); return; }
      setThemeLibrary(themeNames(loadThemes(storage).themes));
      // The look stays on the wall as Custom -- deleting a NAME is not deleting
      // the colors, and dropping the display back to plasma on a delete would
      // be a second, unasked-for change.
      write(THEME_PATH, 'custom');
      syncPresetOptions();
      setNote(`Deleted "${name}". The colors are still on screen, as Custom.`);
    });
  }

  function renderThemeExtras() {
    const wrap = el('div', 'theme-gradient-wrap');
    gradientBar = el('div', 'theme-gradient');
    const handles = el('div', 'theme-stops');
    stopRefs = [];
    for (let i = 0; i < STOP_COUNT; i += 1) {
      const input = el('input', 'theme-stop');
      input.type = 'color';
      input.title = `Stop ${i + 1} of ${STOP_COUNT}`;
      input.style.left = `${(i / (STOP_COUNT - 1)) * 100}%`;
      input.addEventListener('change', () => setStop(i, input.value));
      stopRefs.push(input);
      handles.append(input);
    }
    wrap.append(gradientBar, handles);

    const pick = el('div', 'theme-pick');
    presetSelect = el('select', 'theme-preset');
    presetSelect.title = 'The palette. Every color below follows it, unless '
                        + 'you have set that one yourself. Anything you have '
                        + 'saved is listed under the netviz palettes.';
    presetSelect.addEventListener('change', () => write(THEME_PATH, presetSelect.value));
    const saveBtn = el('button', 'theme-save', 'Save…');
    saveBtn.title = 'Keep the colors on screen now under a name, so you can '
                  + 'come back to them. This is not the same as "Keep".';
    saveBtn.addEventListener('click', askSave);
    summaryLine = el('div', 'theme-summary', headerLine());
    pick.append(presetSelect, saveBtn, summaryLine);
    syncPresetOptions();

    const out = el('div', 'theme-extras');
    out.append(wrap, pick);
    return out;
  }

  function renderRow(spec) {
    const row = el('div', 'tuner-row');
    row.title = spec.help;
    const label = el('div', 'tuner-label');
    // The mark goes INSIDE the label, never beside it. `.tuner-row` is a flex
    // row whose widths are already tight (~347px of content at 380px), so a
    // sixth flex child would take a slot from the slider and could push the
    // controls off. An inline span inside the label takes no slot at all.
    //
    // WHY A ROW CANNOT GO TO TWO LINES because of this, structurally rather
    // than by measurement: `.tuner-row` sets no `flex-wrap`, so its children
    // never wrap to a second line whatever the gutter costs -- a label short of
    // room wraps INSIDE itself and the row grows taller instead. Several labels
    // already do that at 380px. What the gutter does cost is width: 1.1em off
    // every label, which at the clamped 189px panel is about 13px.
    //
    // The gutter is reserved on EVERY row (the span is emitted empty for the
    // rest) so the labels stay in one column and marking a row shifts nothing.
    const mark = el('span', 'tuner-mark', panelRolls(spec) ? RANDOM_MARK : '');
    if (panelRolls(spec)) {
      row.classList.add('tuner-can-random');
      mark.title = 'Randomize can change this setting.';
    }
    label.append(mark, document.createTextNode(spec.label));
    // The rebuild suffix, emitted only on the rows that rebuild -- unlike the
    // randomize gutter, which is reserved on every row. It trails the label
    // text, so an absent one costs nothing and a present one cannot move the
    // label column. See REBUILD_MARK.
    if (clearsArcs(spec)) {
      row.classList.add('tuner-rebuilds');
      const rb = el('span', 'tuner-rebuild', REBUILD_MARK);
      rb.title = 'Changing this clears the arcs on screen; they come back over '
               + 'the next few seconds.';
      label.append(rb);
    }
    row.append(label);

    const refs = { row };
    const value = defaultOf(spec.path);
    current.set(spec.path, value);
    snapshot.set(spec.path, value);

    if (spec.control === 'slider') {
      const range = el('input', 'tuner-range');
      range.type = 'range';
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.value = String(value);
      range.title = spec.help;
      const number = el('input', 'tuner-number');
      number.type = 'number';
      number.min = String(spec.min);
      number.max = String(spec.max);
      number.step = String(spec.step);
      number.value = String(value);
      number.title = spec.help;
      range.addEventListener('input', () => write(spec.path, Number(range.value)));
      // `change`, not `input`, on the typed box: `input` fires on every
      // keystroke, so typing "0.5" writes 0 first and the slider jumps to the
      // floor under the cursor.
      number.addEventListener('change', () => write(spec.path, Number(number.value)));
      refs.range = range;
      refs.number = number;
      row.append(range, number);
    } else if (spec.control === 'color') {
      const color = el('input', 'tuner-color');
      color.type = 'color';
      color.value = resolvedSwatch(spec.path, value);
      color.title = spec.help;
      const swatchText = el('span', 'tuner-hex', String(value));
      // `change`, not `input`: a native color picker streams every pixel the
      // pointer crosses, and `appearance.background` REFUSES a value over its
      // luminance cap rather than clamping it -- so a drag across the light
      // half of the picker would fill the note line with refusals.
      color.addEventListener('change', () => write(spec.path, color.value));
      refs.color = color;
      refs.swatchText = swatchText;
      row.append(color, swatchText);
      // The one-way-door fix: a row that allows `auto` gets a return path
      // back to it, the same `↺` affordance the Theme section gives its twelve
      // element rows -- otherwise the only way off `auto` (picking a color)
      // has no way back, and one accidental click permanently detaches this
      // display's sky from the theme with nothing on the panel to undo it.
      if (entry(spec.path).allowAuto) {
        const autoBtn = el('button', 'theme-revert-el', '↺');
        autoBtn.title = 'Return this color to the theme (auto).';
        autoBtn.disabled = isAuto(value);
        autoBtn.addEventListener('click', () => write(spec.path, AUTO));
        refs.autoBtn = autoBtn;
        row.append(autoBtn);
      }
    } else {
      const check = el('input', 'tuner-check');
      check.type = 'checkbox';
      check.checked = !!value;
      check.title = spec.help;
      check.addEventListener('change', () => write(spec.path, check.checked));
      refs.check = check;
      row.append(check);
    }

    rowRefs.set(spec.path, refs);
    return row;
  }

  /** Keep RE-BASELINES: the kept values become the new snapshot and the dirty
   *  marks clear, with the panel left open. Without that, a later Revert would
   *  undo values that were deliberately kept while localStorage went on
   *  holding them -- the panel and the store disagreeing about what the
   *  display is set to. After a Keep, Revert means "back to what I last
   *  kept", which is the only reading true to both. */
  function doKeep(patch) {
    const n = Object.keys(patch).length;
    const out = savePatch(storage, patch);
    if (!out.ok) { setNote(out.error); return; }
    for (const [path, v] of Object.entries(patch)) snapshot.set(path, v);
    for (const path of dirty) {
      const refs = rowRefs.get(path);
      if (refs) refs.row.classList.remove('tuner-dirty');
    }
    dirty = new Set();
    setNote(`Kept ${n} setting${n === 1 ? '' : 's'} on this display.`);
    refreshActions();
  }

  /** Ask, then do -- or just do, when this panel was built with no confirmer.
   *
   *  `confirmer` is optional so the panel still works standing alone (some
   *  tests build it that way), but main.js passes the ONE dialog instance the
   *  page already has, so there is one implementation and one set of rules on
   *  screen rather than a second dialog with its own idea of which button is
   *  the safe one. Only one dialog can be up at a time -- confirm.js ignores a
   *  second `ask` while one is open -- so no extra guard is needed here. */
  function askThen(question, go) {
    if (!confirmer || !question) { go(); return; }
    confirmer.ask({ ...question, onConfirm: go });
  }

  function keep() {
    if (!storage) { setNote('This browser is not storing settings.'); return; }
    const patch = dirtyPatch(snapshot, current, dirty);
    const paths = Object.keys(patch);
    // Nothing to write, so nothing to ask: the button is disabled in this
    // state and a dialog here would be a question with no meaning.
    if (!paths.length) return;
    // The question names what a Keep ACTUALLY writes -- dirtyPatch's own keys,
    // after the `persist: false` filter -- not every row that happens to be
    // marked, or the dialog would promise to remember a path it then drops.
    askThen(keepQuestion(paths), () => doKeep(patch));
  }

  function doRevert() {
    const patch = revertPatch(snapshot, dirty);
    if (Object.keys(patch).length) {
      const out = preview.apply(patch);
      for (const r of out.rejected || []) console.warn(`netviz: ${r.path} -- ${r.why}`);
    }
    for (const path of dirty) {
      const refs = rowRefs.get(path);
      if (refs) refs.row.classList.remove('tuner-dirty');
      current.set(path, snapshot.get(path));
      syncRow(path);
    }
    dirty = new Set();
    setNote('');
    refreshActions();
  }

  function revert() {
    const paths = Object.keys(revertPatch(snapshot, dirty));
    if (!paths.length) return;
    askThen(revertQuestion(paths), () => { doRevert(); setNote('Put back.'); });
  }

  /** Roll every LOOK slider inside its own bounds.
   *
   *  The set is `tuner.js`'s `randomize` flag, asked per row rather than
   *  decided here: whether changing a setting changes the current frame is a
   *  fact about that setting, and it belongs beside the row it describes. The
   *  `control === 'slider'` test stays as well -- the flag says "this row is
   *  about the look", the control test says "this row has a bounded numeric
   *  range to roll inside", and they are two different questions.
   *
   *  It goes through `write()`, the same path a drag takes, so every row it
   *  moves is marked dirty, its readout is set from what came BACK rather than
   *  from what was asked for, and Revert puts the whole thing back in one
   *  click. A second write path here would be a second set of rules about what
   *  a changed row means.
   *
   *  No confirmation, deliberately, while Keep, Revert and Close all ask.
   *  confirm.js is for actions that clicking again does not undo, and this one
   *  is undone by the Revert button sitting immediately beside it. A dialog in
   *  front of a button whose entire point is to be quick is also the kind
   *  people learn to click through, which is what would make the other three
   *  stop being read. The net is already there: with 29 rows pending, Close
   *  asks.
   *
   *  A REFUSED ROW IS NAMED, never counted out silently. `write()` puts the
   *  refusal reason in the note line, and a final "Randomized N settings" would
   *  paint straight over it while the count reported successes only -- the
   *  "control that silently does nothing" shape this project treats as worse
   *  than a missing control. No slider can reach it today (every numeric path
   *  clamps; only `appearance.background` refuses, and Randomize does not touch
   *  it), so this is latent rather than live -- which is exactly when it is
   *  cheap to get right. */
  /** Every element color rolled independently, ignoring the ramp -- see
   *  randomize_color.js. Never touches the theme or the custom ramp, so a
   *  Revert on a roll puts back what was rolled and nothing about which preset
   *  was active.
   *
   *  It forks every element to an explicit override, after which picking a
   *  preset recolors nothing -- a preset only touches elements still on
   *  `auto`. Revert and the per-row `↺` are the ways back.
   *
   *  The arc floor is derived from the sky ACTUALLY on screen, not from the
   *  shipped one: a display running a brighter ground needs brighter arcs to
   *  stay legible, and that relationship is the luminance cap's own, inverted. */
  function randomizeColorsAll() {
    const sky = defaultOf('appearance.background');
    return writePatch(randomizePatch(Math.random, {
      skyLuminance: relativeLuminance(
        isAuto(sky) ? THEME_SKIES[defaultOf(THEME_PATH)] ?? THEME_SKIES.plasma : sky),
      bodyOpacity: defaultOf('arcs.bodyOpacity'),
    }));
  }

  /** Roll one category's sliders. `theme` is the exception and not an exception
   *  to the rule: its rows are colors, so the SLIDER scope is empty, and its
   *  button rolls the whole catalogue instead -- which is something to do. */
  function rollRows(rows) {
    let n = 0;
    const refused = [];
    for (const spec of rows) {
      if (!isRandomized(spec)) continue;
      const v = randomizeValue(spec, Math.random);
      if (v === null) continue;
      if (write(spec.path, v)) n += 1;
      else refused.push(spec.label);
    }
    return { n, refused };
  }

  /** Roll the CATALOGUE COLORS that have a row in this category.
   *
   *  A category's own button has to move every row it marks, and the rail's
   *  eight colors are marked -- they are catalogue entries, so the panel's
   *  Randomize reaches them. Rolling them from the same generator the whole
   *  catalogue uses keeps one source of "what is a legal element color",
   *  including its luminance floor. */
  function rollGroupColors(rows) {
    const keys = ELEMENT_KEYS.filter((k) => rows.some((r) => r.path === elementPath(k)));
    if (!keys.length) return 0;
    const rolled = randomizeColors(Math.random);
    const patch = {};
    for (const k of keys) patch[elementPath(k)] = rolled[k];
    return writePatch(patch) ? keys.length : 0;
  }

  function randomizeGroup(id) {
    if (id === 'theme') {
      // Theme's button is the WHOLE catalogue, not just the twelve rows it
      // draws: the roller also reaches the two arc colors, the two surface
      // tints and the three atmosphere numbers, which have no row anywhere.
      randomizeColorsAll();
      const n = RANDOMIZE_PATHS.length;
      setNote(`Randomized ${n} color${n === 1 ? '' : 's'}. "Revert" puts them back.`);
      return;
    }
    const mine = groupRows(id);
    const { n, refused } = rollRows(mine);
    const colors = rollGroupColors(mine);
    const total = n + colors;
    const done = `Randomized ${total} setting${total === 1 ? '' : 's'}. `
               + '"Revert" puts them back.';
    setNote(refused.length ? `${done} Refused: ${refused.join(', ')}.` : done);
  }

  /** Randomize ALL: every category's roller in turn, Theme's included. The
   *  printed count comes from what the rollers actually wrote, never a
   *  literal -- this release moved the counts twice. */
  function randomize() {
    const colors = randomizeColorsAll() ? RANDOMIZE_PATHS.length : 0;
    const { n, refused } = rollRows(tunerRows());
    const total = n + colors;
    const done = `Randomized ${total} setting${total === 1 ? '' : 's'}. `
               + '"Revert" puts them back.';
    setNote(refused.length
      ? `${done} Refused: ${refused.join(', ')}.`
      : done);
  }

  function toggleGroup(id) {
    if (openGroups.has(id)) openGroups.delete(id);
    else openGroups.add(id);
    if (!node) return;
    const head = node.querySelector(`.tuner-group[data-group="${id}"]`);
    const body = node.querySelector(`.tuner-group-body[data-group="${id}"]`);
    const on = openGroups.has(id);
    if (head) head.className = `tuner-group${on ? ' open' : ''}`;
    if (body) body.style.display = on ? '' : 'none';
  }

  /** One category heading: a disclosure button, and the category's own
   *  randomize when it has anything to roll.
   *
   *  A category with no randomizable rows draws NO button rather than a
   *  disabled one -- a control that cannot do anything is worse than a missing
   *  control, the same rule that keeps a menu row absent rather than greyed on
   *  a locked display. */
  function renderGroupHead(group, rows) {
    const on = openGroups.has(group.id);
    const head = el('h3', `tuner-group${on ? ' open' : ''}`, group.label);
    head.setAttribute('data-group', group.id);
    head.addEventListener('click', () => toggleGroup(group.id));
    // PRESENCE FROM THE MARKS, not from the slider scope. A category whose only
    // rolled rows are catalogue colors -- Rail, once its text sizes were taken
    // out of the roll -- has a slider count of zero and still has eight things
    // to roll, and a heading that marked eight rows while offering no button
    // would be the same kind of lie the scope line exists to prevent.
    const rolls = rows.some(panelRolls);
    const count = group.id === 'theme'
      ? RANDOMIZE_PATHS.length : rows.filter(panelRolls).length;
    if (rolls) {
      const btn = el('button', 'tuner-group-random', 'randomize');
      btn.setAttribute('data-group', group.id);
      btn.title = group.id === 'theme'
        ? `Give all ${count} colors a random value, ignoring the palette. `
          + '"Revert" puts them back in one click.'
        : `Give this section's ${count} settings a random value inside their `
          + 'own limits. "Revert" puts them back in one click.';
      btn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();   // not a collapse
        randomizeGroup(group.id);
      });
      head.append(btn);
    }
    return head;
  }

  function open() {
    if (node) return;
    snapshot = new Map();
    current = new Map();
    dirty = new Set();
    rowRefs = new Map();
    stopRefs = [];
    // Fresh every open: Theme expanded, the other eight closed. See openGroups.
    openGroups = new Set(['theme']);

    // Snapshot EVERY path Revert can be asked to restore, not just the ones
    // with a row -- see allPaths(). renderRow() re-seeds the ones it draws,
    // which is harmless: it writes the same live value.
    for (const path of allPaths()) {
      const v = defaultOf(path);
      snapshot.set(path, copyOf(v));
      current.set(path, copyOf(v));
    }

    node = el('div', 'tuner-panel');
    // No backdrop. The rules panel has one because editing a list is a modal
    // act; this one is a rail with the globe drawn BESIDE it, and it exists to
    // be used while watching that globe -- a scrim would dim the very thing
    // every one of these rows is being judged against.
    // ALL THREE BUTTONS IN THE HEADER, and the pending count and the feedback
    // line with them. Revert and Keep used to sit in a footer below the rows,
    // where the display this runs on reported never having seen them at all:
    // the panel is a scrolling rail, so a control past the fold is a control
    // that does not exist. Order is Revert, Keep, Close -- the exit on the
    // right, the two that act on pending work beside each other and beside the
    // count that says how much there is.
    const head = el('div', 'tuner-head');
    head.append(el('h2', 'tuner-title', 'Tuning'));
    const actions = el('div', 'tuner-actions');
    // Leftmost: Randomize MAKES pending changes, so it belongs beside Revert,
    // which is what undoes them -- and as far as possible from Close.
    // "Randomize all", not "Randomize": every category heading now carries its
    // own randomize, so an unqualified label on the one at the top reads as a
    // fourth button of the same kind rather than as the one that does all of
    // them at once.
    const randomBtn = el('button', 'tuner-randomize', 'Randomize all');
    // The tooltip keeps the LONGER version -- the held rows by name. The scope
    // itself is printed under the header rather than living only here: a wall
    // display is not hovered.
    randomBtn.title = randomizeTooltip(panelScope());
    randomBtn.addEventListener('click', randomize);
    const revertBtn = el('button', 'tuner-revert', 'Revert');
    revertBtn.title = 'Put the settings you changed back to how they were when '
                    + 'this panel opened, or to what you last kept.';
    revertBtn.addEventListener('click', revert);
    const keepBtn = el('button', 'tuner-keep', 'Keep');
    keepBtn.title = storage
      ? 'Remember the settings you changed, on this screen, in this browser.'
      : 'This browser is not storing settings.';
    keepBtn.addEventListener('click', keep);
    const close = el('button', 'tuner-close', 'Close');
    close.title = 'Close the panel. Anything not kept goes back to how it was.';
    // The BUTTON asks -- through requestClose(), which is what any PERSON's
    // close goes through, the menu's mutual exclusion included. The returned
    // close() is the force-close teardown paths and verifiers need.
    close.addEventListener('click', () => requestClose());
    actions.append(randomBtn, revertBtn, keepBtn, close);
    head.append(actions);
    // The header, the pending count and the feedback line ride in one STICKY
    // block, and that is what makes the four buttons reachable now the panel
    // is 39 rows deep. The panel scrolls -- 1975px of content against a
    // 1440px screen at the shipped 380px width, and 3636px at the clamped
    // 189px one -- so a header pinned to the top of the DOCUMENT flow is a
    // header that is off screen the moment anybody scrolls to the arc-shape
    // group at the bottom. That is the same failure that moved these buttons
    // out of a footer in the first place, arrived at from the other end: a
    // control past the fold is a control that does not exist.
    //
    // All three together rather than the header alone: the count is what
    // Revert and Keep act on and the note is what they report, so a pinned row
    // of buttons over a scrolled-away count would be the answer without the
    // question.
    const sticky = el('div', 'tuner-sticky');
    sticky.append(head);
    sticky.append(el('div', 'tuner-count', 'No changes'));
    sticky.append(el('div', 'tuner-note', ''));
    node.append(sticky);

    node.append(el('p', 'tuner-lead',
      'Changes show on the wall immediately and are forgotten on the next '
      + 'reload. "Keep" remembers them on this screen only.'));

    // The scope of Randomize, in visible copy directly under the button that
    // does it -- and the one explanation of what the row marks mean. It is a
    // second paragraph rather than a third sentence in the first: the two say
    // different things (what the panel does with your changes, what one button
    // touches), and the mark's key has to be findable at a glance rather than
    // read out of a block.
    node.append(el('p', 'tuner-lead tuner-scope', randomizeScopeLine(panelScope())));

    // The rebuild key, in its own paragraph for the same reason the scope is:
    // a mark on a row is only a key if something on the panel says what it
    // means, and a wall display is not hovered. Appended conditionally so an
    // empty line is never drawn -- see rebuildNoteLine.
    const rebuildLine = rebuildNoteLine();
    if (rebuildLine) {
      node.append(el('p', 'tuner-lead tuner-rebuild-note', rebuildLine));
    }

    // Nine collapsible categories. No fitRuleCap equivalent and none is
    // needed: the panel scrolls and a person is standing at it, so the rail's
    // "content past the fold is invisible for ever" argument -- which is about
    // an UNATTENDED display -- does not apply. The sticky header above is what
    // keeps the buttons reachable.
    const body = el('div', 'tuner-body');
    const rows = tunerRows();
    for (const group of GROUPS) {
      const mine = groupRows(group.id, rows);
      body.append(renderGroupHead(group, mine));
      const section = el('div', 'tuner-group-body');
      section.setAttribute('data-group', group.id);
      if (!openGroups.has(group.id)) section.style.display = 'none';
      // The gradient bar and the preset picker are not rows over schema paths
      // -- the bar edits ten entries of ONE path and the picker writes a path
      // with no control kind -- so they are drawn here rather than described
      // in tuner.js's table.
      if (group.id === 'theme') section.append(renderThemeExtras());
      if (group.id === 'rail') {
        // Said out loud, so a color row with no randomize mark beside it is
        // explained rather than looking like an oversight: the eight rail
        // colors are catalogue entries and Theme's randomize rolls them with
        // the rest. This section's own button rolls its five text scales.
        section.append(el('p', 'tuner-lead tuner-group-note',
          'Randomize leaves the five text sizes alone on purpose -- size is '
          + 'legibility, not a look, and it is the one thing you set once for '
          + 'your own room. The eight colors are part of the theme and are '
          + 'rolled with it.'));
      }
      for (const spec of mine) section.append(renderRow(spec));
      body.append(section);
    }
    node.append(body);
    syncPreset();
    syncGradient();

    // The class BEFORE the append and the relayout after both: `body.tuner`
    // is what narrows #stage, so setting it last would have the caller
    // measuring the full viewport for a panel that is already on screen.
    document.body.classList.add('tuner');
    mount.append(node);
    refreshActions();
    if (onLayout) onLayout();
  }

  /** Closing is a Revert. Nothing kept was ever meant to survive the panel --
   *  that is what makes dragging safe -- and leaving a preview on the wall
   *  after the panel is gone would be a display in a state nothing recorded
   *  and nobody could find their way back from.
   *
   *  This one NEVER asks. It is the force-close: the teardown path, and what a
   *  verifier calls to put the display back between cases, neither of which has
   *  anybody in front of it to answer a question. `requestClose()` below is the
   *  one a person's click goes through. Putting the dialog inside here instead
   *  would make every programmatic close blockable. */
  function closePanel() {
    if (!node) return;
    doRevert();
    node.remove();
    node = null;
    rowRefs = new Map();
    document.body.classList.remove('tuner');
    // One relayout on the way out too, and only after the class is gone: the
    // stage is back to the full viewport by the time anyone measures it.
    if (onLayout) onLayout();
    if (onClose) onClose();
  }

  /** A PERSON is closing the panel: ask when something is pending, close at
   *  once when nothing is.
   *
   *  Two callers, and the second is the reason this exists at all. The Close
   *  button is the obvious one. The other is menu.js, which enforces mutual
   *  exclusion between the two panels by closing this one before opening the
   *  color-rules panel -- and while that call was the force-close, an operator
   *  with pending changes who picked "Custom arcs..." had them DISCARDED
   *  SILENTLY, which is exactly the case the Close question was written for,
   *  reached by a door that skipped it.
   *
   *  `onClosed` is how a synchronous caller sequences work behind an
   *  asynchronous answer: the menu opens the other panel from it, so canceling
   *  leaves this panel open with its changes pending and the other panel shut.
   *  It is called only when the panel actually closed, and it is called
   *  immediately when there was nothing to ask about -- including when the
   *  panel was not open in the first place, so a caller can treat it as "once
   *  this panel is out of the way, do this". */
  function requestClose(onClosed) {
    const done = () => { if (onClosed) onClosed(); };
    if (!node) { done(); return; }
    const patch = dirtyPatch(snapshot, current, dirty);
    const question = closeQuestion(Object.keys(revertPatch(snapshot, dirty)));
    if (!question) { closePanel(); done(); return; }
    // Asked directly rather than through askThen(), which carries ONE callback
    // and this question has two answers that act. The alt KEEPS FIRST, then
    // closes -- and closePanel() reverts whatever is still dirty, which after a
    // successful doKeep() is nothing. Ordering matters: closing first would
    // revert the very values it is about to write.
    if (!confirmer) { closePanel(); done(); return; }
    confirmer.ask({
      ...question,
      onConfirm: () => { closePanel(); done(); },
      onAlt: () => { doKeep(patch); closePanel(); done(); },
    });
  }

  return { open, close: closePanel, requestClose, isOpen };
}
