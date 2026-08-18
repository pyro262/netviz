// The theme panel: a live gradient bar, the twelve per-element color rows,
// preset picking and the two randomizers.
//
// Mirrors js/settings_panel.js closely -- same rail, same preview/persist
// split, same three-question confirm model -- because it is that panel's
// sibling and a wall operator should not have to relearn a different set of
// rules to change color instead of brightness. Read
// docs/notes/settings-and-panels.md's "tuning panel" section before touching
// this file; every rule there applies here too.
//
// A LEFT RAIL, not an overlay -- see settings_panel.js's header comment for
// the full argument (narrowing #stage really does shrink the globe, and the
// display must not cover it regardless). `--theme-panel-width` is its own
// custom property, read by both this panel's CSS width and
// `body.theme #stage`'s `left`, clamped the same way
// `--tuner-width` is: two copies of that number disagreeing is a panel back
// over the globe or a gap nothing fills.
//
// Mounted on document.body, NEVER on #stage: #stage is `position: fixed` and
// a fixed element creates a stacking context, so #rail -- a later sibling --
// paints over everything inside it. Measured and reproduced twice already in
// this codebase (the menu, then the tuning panel); a z-index of 9999 changes
// nothing.
//
// TWO WAYS TO WRITE:
//   preview   the UNWRAPPED applier. Every edit -- a stop, an element color,
//             a preset pick, Randomize ramp, Chaos -- goes through this, so
//             the wall changes and NOTHING is stored. A reload is the escape
//             hatch that makes experimenting free.
//   settings  the persisting applier (main.js's `withPersistence(preview,
//             storage)`). Keep hands it exactly the touched paths, at their
//             current values -- never the whole draft -- so it writes only
//             what somebody actually decided about this display.
import { RAMPS, THEME_SKIES } from './ramp.js';
import { ELEMENT_T, ELEMENT_LITERAL, AUTO, isAuto, resolveColor } from './elements.js';
import { defaultOf, entry, settingLabel, relativeLuminance } from './settings.js';
import { randomizeRamp, chaosPatch, CHAOS_PATHS } from './randomize_color.js';

/** The twelve element keys, in the same order apply.js's colorHandlers()
 *  declares them -- also the order chaosColors() returns, so a chaos patch
 *  and a row list never have to be reconciled against each other. */
export const ELEMENT_KEYS = [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)];

const THEME_PATH = 'appearance.theme';
const RAMP_PATH = 'appearance.customRamp';
const STOP_COUNT = 10;
const PRESET_IDS = ['plasma', 'viridis', 'magma', 'inferno', 'cividis'];

function elementPath(key) { return `appearance.colors.${key}`; }

/** Every path this panel snapshots, and therefore every path Revert, Keep and
 *  Close can act on.
 *
 *  CHAOS_PATHS is unioned in rather than listed here: Chaos reaches beyond the
 *  twelve element rows -- the two arc colors, the two surface tints, the three
 *  atmosphere numbers -- and a path Chaos can WRITE but Revert cannot RESTORE
 *  is a one-way door. Deriving the set from the roller means adding something
 *  to Chaos cannot silently escape the undo. The extra paths have no row on
 *  this panel; they are snapshotted and reverted all the same. */
function allPaths() {
  const base = [THEME_PATH, RAMP_PATH, ...ELEMENT_KEYS.map(elementPath)];
  return [...new Set([...base, ...CHAOS_PATHS])];
}

function copyOf(v) { return Array.isArray(v) ? v.slice() : v; }

// -------------------------------------------------------- the three questions --
//
// Same shape as settings_panel.js's keepQuestion/revertQuestion/closeQuestion:
// built from the paths ACTUALLY pending, named through settingLabel() rather
// than a generic "your changes", and each carrying a `wont` -- the half
// confirm.js exists to enforce, since a warning that only lists consequences
// reads as a fault and gets clicked through.

const NAME_LIMIT = 6;

function named(paths) {
  const labels = paths.map(settingLabel);
  if (labels.length <= NAME_LIMIT) return labels.join(', ');
  const rest = labels.length - NAME_LIMIT;
  return `${labels.slice(0, NAME_LIMIT).join(', ')}, and ${rest} more`;
}

function keepQuestion(paths = []) {
  const n = paths.length;
  return {
    title: n ? `Remember ${n} color setting${n === 1 ? '' : 's'} on this screen?` : 'Nothing to keep',
    lead: 'Keeping writes the theme changes you made into this web browser, so '
        + 'this display starts with them next time. Everything else is left alone.',
    will: n ? [
      `Remember what you changed here: ${named(paths)}.`,
      'Write them to this web browser only, on this screen.',
      'Make them what this display starts with after a reload.',
    ] : [],
    wont: [
      'Change anything on the collector, or on any other display.',
      'Touch your color rules.',
      'Touch any setting you did not change in this panel.',
    ],
    note: n ? null
            : 'Nothing has been changed in this panel yet, so there is nothing to remember.',
    confirmLabel: 'Yes, keep them here',
    cancelLabel: 'No, leave them unkept',
  };
}

function revertQuestion(paths = []) {
  const n = paths.length;
  return {
    title: n ? `Put ${n} color setting${n === 1 ? '' : 's'} back?` : 'Nothing to put back',
    lead: 'Reverting returns the theme to what it showed when this panel opened, '
        + 'or to what you last kept, whichever is later.',
    will: n ? [
      `Put back: ${named(paths)}.`,
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
            : 'Nothing has been changed in this panel yet, so there is nothing to put back.',
    confirmLabel: 'Yes, put them back',
    cancelLabel: 'No, leave them as they are',
  };
}

function closeQuestion(paths = []) {
  const n = paths.length;
  if (!n) return null;
  return {
    title: `Close and discard ${n} change${n === 1 ? '' : 's'}?`,
    lead: 'Closing this panel is a revert: nothing you are trying out survives '
        + 'it, because a preview left on the wall after the panel is gone is a '
        + 'display in a state nothing recorded.',
    will: [
      `Discard what you changed and have not kept: ${named(paths)}.`,
      'Put the wall back to how it was before you opened this panel.',
      'Close the panel.',
    ],
    wont: [
      'Change anything you have already kept -- that stays kept.',
      'Change anything on the collector, or on any other display.',
      'Touch your color rules.',
    ],
    note: 'To keep these instead, cancel and click "Keep".',
    confirmLabel: 'Yes, close and discard',
    cancelLabel: 'No, go back to the panel',
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
 *   after it closes, with `body.theme` already set or cleared -- same
 *   ordering contract settings_panel.js's createSettingsPanel states, for the
 *   same reason: a relayout rebuilds the composer's render targets.
 */
export function createThemePanel({ settings, preview, confirmer, onLayout, root } = {}) {
  const mount = root || document.body;
  let node = null;

  // The value every row held when the panel opened -- what Revert returns
  // to, and what Keep re-baselines onto.
  let snapshot = new Map();
  // The live value of every row, as the panel last wrote it.
  let current = new Map();
  // Paths the person actually touched. Only these are ever kept or reverted.
  let dirty = new Set();

  let rowRefs = new Map();      // element key -> { row, color, hex }
  let stopRefs = [];            // 10 <input type=color>
  let presetSelect = null;
  let gradientBar = null;
  let summaryLine = null;

  function isOpen() { return node !== null; }

  /** The active ramp's ten stops, as currently held by the panel -- the
   *  custom array if the theme has been forked, the named preset otherwise.
   *  RAMPS is a module constant and is never mutated: every read here is a
   *  fresh `.slice()`. */
  function activeStops() {
    const theme = current.get(THEME_PATH);
    if (theme === 'custom') return copyOf(current.get(RAMP_PATH));
    return copyOf(RAMPS[theme] || RAMPS.plasma);
  }

  function setNote(text) {
    const n = node && node.querySelector('.tuner-note');
    if (n) n.textContent = text || '';
  }

  /** The patch a Keep writes / Close discards: the touched paths at their
   *  current values. Touched, not changed -- a row someone edited and put
   *  back is still a decision about this display. */
  function pendingPatch() {
    const out = {};
    for (const path of dirty) {
      if (!current.has(path)) continue;
      if (!snapshot.has(path)) continue;
      if (entry(path) && entry(path).persist === false) continue;
      out[path] = copyOf(current.get(path));
    }
    return out;
  }

  function pendingPaths() { return Object.keys(pendingPatch()); }

  /** The header's plain-language line: "plasma", or "plasma, 2 overridden"
   *  -- counted from the twelve element settings that are not `auto`, never
   *  cached, so a returned-to-auto row drops back out of the count the
   *  instant it happens. */
  function headerLine() {
    const theme = current.get(THEME_PATH);
    const n = ELEMENT_KEYS.filter((k) => current.get(elementPath(k)) !== AUTO).length;
    return n ? `${theme}, ${n} overridden` : theme;
  }

  function refreshActions() {
    if (!node) return;
    const n = pendingPaths().length;
    const count = node.querySelector('.tuner-count');
    if (count) {
      count.textContent = n
        ? `${n} setting${n === 1 ? '' : 's'} changed, not yet kept`
        : 'No changes';
    }
    const keepBtn = node.querySelector('.tuner-keep');
    const revertBtn = node.querySelector('.tuner-revert');
    if (keepBtn) keepBtn.disabled = n === 0 || !settings;
    if (revertBtn) revertBtn.disabled = n === 0;
    if (summaryLine) summaryLine.textContent = headerLine();
  }

  function syncElementRow(key) {
    const refs = rowRefs.get(key);
    if (!refs) return;
    const stored = current.get(elementPath(key));
    const isAuto = stored === AUTO;
    const shown = isAuto ? resolveColor(key, AUTO) : stored;
    refs.color.value = shown;
    refs.hex.textContent = isAuto ? 'auto' : stored;
    if (dirty.has(elementPath(key))) refs.row.classList.add('tuner-dirty');
    else refs.row.classList.remove('tuner-dirty');
  }

  function syncPreset() {
    if (presetSelect) presetSelect.value = current.get(THEME_PATH);
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

  /** Put one row's controls back in step with what `current` says. */
  function syncRow(path) {
    if (path === THEME_PATH || path === RAMP_PATH) {
      syncPreset();
      syncGradient();
      // Every AUTO element row's displayed color is DERIVED from the active
      // ramp (resolveColor(key, AUTO)), not stored -- so the instant the
      // ramp moves, all twelve rows are stale, not just the one path this
      // patch happened to name. Found live by verify_theme.py case 4: the
      // wall recolored correctly (apply.js's own applyTheme fan-out pushes
      // every auto element), but the panel kept showing the OLD swatches --
      // an element the panel claims is following the theme while the wall
      // disagrees, which is the exact drift this whole design exists to
      // prevent. A wrong readout that looks confident is worse than no
      // readout at all, because it is still believed.
      for (const key of ELEMENT_KEYS) syncElementRow(key);
      return;
    }
    const key = ELEMENT_KEYS.find((k) => elementPath(k) === path);
    if (key) syncElementRow(key);
  }

  /**
   * Write a patch of one or more paths through `preview`, live only.
   *
   * PARTIAL FAILURE IS HANDLED: `out.applied` may name only some of the
   * patch's keys (a real executor validates each path independently), so
   * every accepted key is marked dirty even when a sibling in the same call
   * was refused -- an early return on any rejection would silently drop the
   * half that worked. The note reports the first refusal; every row in the
   * patch is re-synced regardless, so a refused control snaps back to what
   * is actually live rather than showing the value that never landed.
   */
  function writePatch(patch) {
    const out = preview.apply(patch) || {};
    const applied = out.applied || Object.keys(patch);
    const rejected = out.rejected || [];
    for (const path of Object.keys(patch)) {
      if (applied.includes(path)) {
        current.set(path, copyOf(patch[path]));
        dirty.add(path);
      }
      syncRow(path);
    }
    setNote(rejected.length ? `${rejected[0].path}: ${rejected[0].why}` : '');
    refreshActions();
    return rejected.length === 0;
  }

  function write(path, value) { return writePatch({ [path]: value }); }

  /** One element row's color -- `AUTO` is the return-to-theme sentinel, the
   *  same value the `↺` button on the row sends. */
  function setElement(key, value) { return write(elementPath(key), value); }
  function resetElement(key) { return setElement(key, AUTO); }

  /**
   * Move one of the ten gradient stops.
   *
   * FORKS THE PRESET on the first edit only: if the theme is not already
   * `custom`, the patch carries both `appearance.theme: 'custom'` and the
   * full ten-stop array seeded from whatever preset was active, in ONE
   * `preview.apply()` call -- so the fan-out that recolors every auto
   * element runs once, not once per key. Every stop edit AFTER that sends
   * only `appearance.customRamp`, never re-sending `appearance.theme`: the
   * ~4000-vertex city BufferAttribute rewrite the theme fan-out triggers is
   * too expensive to repeat on every drag event once the fork has already
   * happened.
   */
  function setStop(index, hex) {
    const stops = activeStops();
    stops[index] = hex;
    const wasCustom = current.get(THEME_PATH) === 'custom';
    const patch = { [RAMP_PATH]: stops };
    if (!wasCustom) patch[THEME_PATH] = 'custom';
    return writePatch(patch);
  }

  /** Roll a whole new coherent ramp and fork to custom in one call, for the
   *  same reason setStop's first edit does. */
  function doRandomizeRamp(rand = Math.random) {
    const stops = randomizeRamp(rand);
    writePatch({ [RAMP_PATH]: stops, [THEME_PATH]: 'custom' });
  }

  /** Chaos: the whole display rolled independently, ignoring the ramp -- see
   *  randomize_color.js. Never touches the theme or the custom ramp, so a
   *  Revert on a chaos click puts back what was rolled and nothing about which
   *  preset was active.
   *
   *  The arc floor is derived from the sky that is actually on screen, not
   *  from the shipped one: a display running a brighter ground needs brighter
   *  arcs to stay legible, and that relationship is the luminance cap's own,
   *  inverted. */
  function chaos(rand = Math.random) {
    const sky = defaultOf('appearance.background');
    writePatch(chaosPatch(rand, {
      skyLuminance: relativeLuminance(
        isAuto(sky) ? THEME_SKIES[defaultOf(THEME_PATH)] ?? THEME_SKIES.plasma : sky),
      bodyOpacity: defaultOf('arcs.bodyOpacity'),
    }));
  }

  function askThen(question, go) {
    if (!confirmer || !question) { go(); return; }
    confirmer.ask({ ...question, onConfirm: go });
  }

  /** Keep RE-BASELINES: the kept values become the new snapshot and the
   *  dirty marks clear, with the panel left open. Without that, a later
   *  Revert would undo values that were deliberately kept while storage went
   *  on holding them. */
  /** Only ever called from keep(), which already refuses with nothing kept
   *  when `settings` is missing -- so this reads `settings` directly rather
   *  than falling back to `preview`, which would silently apply the patch
   *  live a second time without persisting it. */
  function doKeep(patch) {
    const n = Object.keys(patch).length;
    const out = settings.apply(patch) || {};
    if (out.rejected && out.rejected.length) {
      setNote(`could not keep: ${out.rejected[0].why}`);
      return;
    }
    for (const [path, v] of Object.entries(patch)) snapshot.set(path, copyOf(v));
    dirty = new Set();
    for (const key of ELEMENT_KEYS) syncElementRow(key);
    syncPreset();
    syncGradient();
    setNote(`Kept ${n} setting${n === 1 ? '' : 's'} on this display.`);
    refreshActions();
  }

  function keep() {
    if (!settings) { setNote('This browser is not storing settings.'); return; }
    const patch = pendingPatch();
    const paths = Object.keys(patch);
    if (!paths.length) return;
    askThen(keepQuestion(paths), () => doKeep(patch));
  }

  function doRevert() {
    const patch = {};
    for (const path of dirty) {
      if (snapshot.has(path)) patch[path] = copyOf(snapshot.get(path));
    }
    if (Object.keys(patch).length) {
      const out = preview.apply(patch) || {};
      for (const r of out.rejected || []) console.warn(`netviz: ${r.path} -- ${r.why}`);
    }
    for (const path of dirty) {
      if (snapshot.has(path)) current.set(path, copyOf(snapshot.get(path)));
      syncRow(path);
    }
    dirty = new Set();
    setNote('');
    refreshActions();
  }

  function revert() {
    const paths = pendingPaths();
    if (!paths.length) return;
    askThen(revertQuestion(paths), () => { doRevert(); setNote('Put back.'); });
  }

  function renderElementRow(key) {
    const row = el('div', 'tuner-row theme-row');
    const path = elementPath(key);
    const help = entry(path);
    if (help && help.help) row.title = help.help;
    const label = el('div', 'tuner-label', settingLabel(path));
    const color = el('input', 'tuner-color');
    color.type = 'color';
    const hex = el('span', 'tuner-hex');
    const revertBtn = el('button', 'theme-revert-el', '↺');
    revertBtn.title = 'Return this element to the theme (auto).';
    color.addEventListener('change', () => setElement(key, color.value));
    revertBtn.addEventListener('click', () => resetElement(key));
    row.append(label, color, hex, revertBtn);
    rowRefs.set(key, { row, color, hex });
    return row;
  }

  function renderGradient() {
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
    return wrap;
  }

  function open() {
    if (node) return;
    snapshot = new Map();
    current = new Map();
    dirty = new Set();
    rowRefs = new Map();
    stopRefs = [];

    for (const path of allPaths()) {
      const v = defaultOf(path);
      snapshot.set(path, copyOf(v));
      current.set(path, copyOf(v));
    }

    node = el('div', 'tuner-panel theme-panel');
    // No backdrop, same argument as the tuning panel: this is a rail meant
    // to be used while watching the globe it recolors, not a modal.

    const head = el('div', 'tuner-head');
    head.append(el('h2', 'tuner-title', 'Theme'));
    const actions = el('div', 'tuner-actions');

    presetSelect = el('select', 'theme-preset');
    for (const id of [...PRESET_IDS, 'custom']) {
      const opt = el('option', null, id === 'custom' ? 'Custom' : id);
      opt.value = id;
      presetSelect.append(opt);
    }
    presetSelect.title = 'The color ramp every element on auto follows.';
    presetSelect.addEventListener('change', () => write(THEME_PATH, presetSelect.value));

    const randomBtn = el('button', 'theme-randomize-ramp', 'Randomize ramp');
    randomBtn.title = 'Roll a new coherent ramp: one rotating hue family, dark '
                     + 'end to light end. Forks the preset to custom.';
    randomBtn.addEventListener('click', () => doRandomizeRamp());

    const chaosBtn = el('button', 'theme-chaos', 'Chaos');
    chaosBtn.title = 'Roll every element an independent random color, ignoring '
                    + 'the ramp entirely. Marks all twelve dirty; Revert puts '
                    + 'them all back in one click.';
    chaosBtn.addEventListener('click', () => chaos());

    const revertBtn = el('button', 'tuner-revert', 'Revert');
    revertBtn.title = 'Put the colors you changed back to how they were when '
                     + 'this panel opened, or to what you last kept.';
    revertBtn.addEventListener('click', revert);

    const keepBtn = el('button', 'tuner-keep', 'Keep');
    keepBtn.title = settings
      ? 'Remember the colors you changed, on this screen, in this browser.'
      : 'This browser is not storing settings.';
    keepBtn.addEventListener('click', keep);

    const closeBtn = el('button', 'tuner-close', 'Close');
    closeBtn.title = 'Close the panel. Anything not kept goes back to how it was.';
    // Through requestClose(), never close() directly: the button is a
    // PERSON's action, and the force-close is only for the teardown paths
    // that have nobody there to answer a dialog.
    closeBtn.addEventListener('click', () => requestClose());

    actions.append(presetSelect, randomBtn, chaosBtn, revertBtn, keepBtn, closeBtn);
    head.append(actions);

    const sticky = el('div', 'tuner-sticky');
    sticky.append(head);
    summaryLine = el('div', 'theme-summary', 'plasma');
    sticky.append(summaryLine);
    sticky.append(el('div', 'tuner-count', 'No changes'));
    sticky.append(el('div', 'tuner-note', ''));
    node.append(sticky);

    node.append(el('p', 'tuner-lead',
      'Changes show on the wall immediately and are forgotten on the next '
      + 'reload. "Keep" remembers them on this screen only. Dragging a stop '
      + 'below switches the ramp to a custom one built from what was active.'));

    node.append(renderGradient());

    const body = el('div', 'tuner-body');
    body.append(el('h3', 'tuner-group', 'Elements'));
    for (const key of ELEMENT_KEYS) body.append(renderElementRow(key));
    node.append(body);

    // The class BEFORE the append and the relayout after both: body.theme
    // is what narrows #stage, so setting it last would have the caller
    // measuring the full viewport for a panel that is already on screen.
    //
    // Deliberately NOT the same string as the panel's own root class
    // (`theme-panel`, below): `document.querySelector('.theme-panel')`
    // matching document.body itself, ahead of the panel in document order,
    // is exactly the kind of gap that hides a real mount bug from a
    // verifier -- found live while measuring this panel's own geometry,
    // where it briefly looked as though the panel were not a direct child
    // of body at all. body.tuner and .tuner-panel keep the same distinction
    // for the same reason.
    document.body.classList.add('theme');
    mount.append(node);

    syncPreset();
    syncGradient();
    for (const key of ELEMENT_KEYS) syncElementRow(key);
    refreshActions();
    if (onLayout) onLayout();
  }

  /** Closing is a Revert. This NEVER asks -- the force-close teardown path,
   *  same split as settings_panel.js's closePanel/requestClose. */
  function closePanel() {
    if (!node) return;
    doRevert();
    node.remove();
    node = null;
    rowRefs = new Map();
    stopRefs = [];
    presetSelect = null;
    gradientBar = null;
    summaryLine = null;
    document.body.classList.remove('theme');
    if (onLayout) onLayout();
  }

  /** A PERSON is closing the panel: ask when something is pending, close at
   *  once when nothing is. `onClosed` is how a synchronous caller sequences
   *  work behind an asynchronous answer -- menu.js opens another panel from
   *  it, so a Cancel leaves this panel open with its changes pending and the
   *  other panel unopened. */
  function requestClose(onClosed) {
    const done = () => { if (onClosed) onClosed(); };
    if (!node) { done(); return; }
    const question = closeQuestion(pendingPaths());
    if (!question) { closePanel(); done(); return; }
    askThen(question, () => { closePanel(); done(); });
  }

  return {
    open, close: closePanel, requestClose, isOpen,
    setStop, setElement, resetElement, headerLine, pendingPatch, pendingPaths, chaos,
  };
}
