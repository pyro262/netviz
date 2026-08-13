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
//     radius about centre x=1280, measured with `__netviz.project()` over a
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
// Persisting all 24 would freeze two dozen values at today's config.js
// numbers, after which the display silently stops tracking any later change
// to them -- the exact failure `traffic.extraResolvers` was just fixed for.
import { tunerRows } from './tuner.js';
import { defaultOf } from './settings.js';
import { savePatch } from './rulestore.js';

/** The patch a Keep writes: the touched paths at their current values.
 *
 *  Touched, not changed. A row someone dragged and put back is still their
 *  decision about this display and is written; a row that moved because
 *  something ELSE on the display wrote it is not the panel's to freeze. */
export function dirtyPatch(snapshot, current, dirty) {
  const out = {};
  for (const path of dirty) {
    if (!current.has(path)) continue;
    if (!snapshot.has(path)) continue;
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
export function createSettingsPanel({ preview, storage, root, onClose, onLayout } = {}) {
  const mount = root || document.body;
  let node = null;
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

  /** How many rows are pending, on the footer. Also the enable state of the
   *  two buttons: a Keep or a Revert over nothing teaches that the button
   *  does nothing, the same argument confirm.js makes about a yes/no over an
   *  action with no effect. */
  function refreshFooter() {
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
  }

  function markDirty(path, value) {
    current.set(path, value);
    dirty.add(path);
    const refs = rowRefs.get(path);
    if (refs) refs.row.classList.add('tuner-dirty');
    refreshFooter();
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

  /** Put a row's controls back in step with the live value. */
  function syncRow(path) {
    const refs = rowRefs.get(path);
    if (!refs) return;
    const v = defaultOf(path);
    if (refs.range) {
      refs.range.value = String(v);
      refs.number.value = String(v);
    } else if (refs.color) {
      refs.color.value = String(v);
      refs.swatchText.textContent = String(v);
    } else if (refs.check) {
      refs.check.checked = !!v;
    }
  }

  function renderRow(spec) {
    const row = el('div', 'tuner-row');
    row.title = spec.help;
    const label = el('div', 'tuner-label', spec.label);
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
      color.value = String(value);
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
  function keep() {
    if (!storage) { setNote('This browser is not storing settings.'); return; }
    const patch = dirtyPatch(snapshot, current, dirty);
    const n = Object.keys(patch).length;
    if (!n) return;
    const out = savePatch(storage, patch);
    if (!out.ok) { setNote(out.error); return; }
    for (const [path, v] of Object.entries(patch)) snapshot.set(path, v);
    for (const path of dirty) {
      const refs = rowRefs.get(path);
      if (refs) refs.row.classList.remove('tuner-dirty');
    }
    dirty = new Set();
    setNote(`Kept ${n} setting${n === 1 ? '' : 's'} on this display.`);
    refreshFooter();
  }

  function revert() {
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
    refreshFooter();
  }

  function open() {
    if (node) return;
    snapshot = new Map();
    current = new Map();
    dirty = new Set();
    rowRefs = new Map();

    node = el('div', 'tuner-panel');
    // No backdrop. The rules panel has one because editing a list is a modal
    // act; this one exists to be used while watching the wall behind it, and
    // a scrim over the globe would hide the measurement.
    const head = el('div', 'tuner-head');
    head.append(el('h2', 'tuner-title', 'Tuning'));
    const close = el('button', 'tuner-close', 'Close');
    close.title = 'Close the panel. Anything not kept goes back to how it was.';
    close.addEventListener('click', () => closePanel());
    head.append(close);
    node.append(head);

    node.append(el('p', 'tuner-lead',
      'Changes show on the wall immediately and are forgotten on the next '
      + 'reload. "Keep" remembers them on this screen only.'));

    const body = el('div', 'tuner-body');
    let seen = null;
    for (const spec of tunerRows()) {
      if (spec.group !== seen) {
        body.append(el('h3', 'tuner-group', spec.groupLabel));
        seen = spec.group;
      }
      body.append(renderRow(spec));
    }
    node.append(body);

    const foot = el('div', 'tuner-foot');
    foot.append(el('div', 'tuner-count', 'No changes'));
    const keepBtn = el('button', 'tuner-keep', 'Keep');
    keepBtn.title = storage
      ? 'Remember the settings you changed, on this screen, in this browser.'
      : 'This browser is not storing settings.';
    keepBtn.addEventListener('click', keep);
    const revertBtn = el('button', 'tuner-revert', 'Revert');
    revertBtn.title = 'Put the settings you changed back to how they were when '
                    + 'this panel opened, or to what you last kept.';
    revertBtn.addEventListener('click', revert);
    foot.append(revertBtn, keepBtn);
    node.append(foot);
    node.append(el('div', 'tuner-note', ''));

    // The class BEFORE the append and the relayout after both: `body.tuner`
    // is what narrows #stage, so setting it last would have the caller
    // measuring the full viewport for a panel that is already on screen.
    document.body.classList.add('tuner');
    mount.append(node);
    refreshFooter();
    if (onLayout) onLayout();
  }

  /** Closing is a Revert. Nothing kept was ever meant to survive the panel --
   *  that is what makes dragging safe -- and leaving a preview on the wall
   *  after the panel is gone would be a display in a state nothing recorded
   *  and nobody could find their way back from. */
  function closePanel() {
    if (!node) return;
    revert();
    node.remove();
    node = null;
    rowRefs = new Map();
    document.body.classList.remove('tuner');
    // One relayout on the way out too, and only after the class is gone: the
    // stage is back to the full viewport by the time anyone measures it.
    if (onLayout) onLayout();
    if (onClose) onClose();
  }

  return { open, close: closePanel, isOpen };
}
