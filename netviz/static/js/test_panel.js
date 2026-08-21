// Test Mode: show me how this looks.
//
// It used to be one boolean, then fifteen checkboxes across five categories
// that mixed three unrelated jobs -- hover previews, sample geometry, and a
// diagnostic self-test of the feeds and the map. Reported from the wall as
// covering everything and not making sense, which was fair: "is netflow
// arriving" and "what does an aurora look like" are not the same question and
// do not belong under one button.
//
// It asks ONE question now. A wall display is judged by eye, and the hard case
// is judging something that is NOT CURRENTLY HAPPENING: an aurora on a quiet
// night, a blocked arc when nothing is being blocked, a custom arc whose rule
// has never fired. Tick those, press Show, and they are on screen for a while.
//
// A MODAL, unlike the settings panel -- but one you are meant to CLOSE and then
// watch the globe. A showing runs on its own clock and closing the panel does
// not end it; that is the whole point.
//
// Every tick writes through `settings.apply`: these are ordinary persisted
// settings, and somebody who ticked four things and reloaded should find them
// still ticked.
import { cfg } from './config.js';
import { entry } from './settings.js';

/** The things a showing can put on screen, in the order the panel lists them.
 *  `param` is a slider that belongs to the row above it. */
export const SHOW_ITEMS = [
  { path: 'test.show.aurora', label: 'Aurora', param: 'test.show.auroraKp',
    paramLabel: 'Kp' },
  { path: 'test.show.blocked', label: 'Blocked arcs' },
  { path: 'test.show.flow', label: 'Ordinary arcs' },
  { path: 'test.show.customArcs', label: 'One arc per custom arc' },
  { path: 'test.show.ripples', label: 'Impact ripples' },
  { path: 'test.show.lightning', label: 'Lightning' },
  { path: 'test.show.clouds', label: 'Clouds' },
  { path: 'test.show.countryFlash', label: 'Country flash' },
];

/** The hover previews. Kept because they answer the same question -- what does
 *  this look like -- by a different route: point at a control rather than force
 *  the thing on. Their own block, so the panel does not read as a list of
 *  unrelated switches again. */
export const PREVIEW_ITEMS = [
  { path: 'test.preview.layers', label: 'Layer toggles in the menu' },
  { path: 'test.preview.rail', label: 'The stats rail (resizes the display)' },
];

export function showPaths() {
  return SHOW_ITEMS.map((i) => i.path);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createTestPanel({ settings, showcase, root, onClose } = {}) {
  const mount = root || document.body;
  let node = null;
  const boxRefs = new Map();

  function isOpen() { return node !== null; }

  function setNote(text) {
    const n = node && node.querySelector('.test-note');
    if (n) n.textContent = text || '';
  }

  function write(path, value) {
    if (!settings) return;
    const out = settings.apply({ [path]: value }) || {};
    if (out.rejected && out.rejected.length) {
      setNote(`${out.rejected[0].path}: ${out.rejected[0].why}`);
    }
  }

  function sync() {
    for (const [path, box] of boxRefs) box.checked = !!cfg(path, false);
    refreshActions();
  }

  function anyTicked() { return showPaths().some((p) => cfg(p, false)); }

  function refreshActions() {
    if (!node) return;
    const show = node.querySelector('.test-show');
    const stop = node.querySelector('.test-stop');
    // A Show with nothing ticked would be a button that does nothing, which is
    // the same empty control confirm.js refuses to draw a dialog for.
    if (show) show.disabled = !anyTicked();
    if (stop) stop.disabled = !(showcase && showcase.isRunning());
  }

  function report(lines) {
    const box = node && node.querySelector('.test-report');
    if (!box) return;
    box.replaceChildren();
    for (const line of lines || []) {
      const row = el('div', `test-report-row ${line.state}`);
      row.append(el('span', 'test-report-mark',
                    line.state === 'skip' ? '–' : '•'));
      row.append(el('span', 'test-report-label', line.label));
      row.append(el('span', 'test-report-why', line.why || ''));
      box.append(row);
    }
  }

  const labelFor = (path) => {
    const item = SHOW_ITEMS.find((i) => i.path === path);
    return item ? item.label : path;
  };

  function show() {
    if (!showcase) { setNote('This display cannot run a showing.'); return; }
    const out = showcase.start();
    const lines = [
      ...(out.items || []).map((id) => ({
        state: 'on', label: labelFor(`test.show.${id}`), why: 'on screen now',
      })),
      ...(out.skipped || []).map((s) => ({
        state: 'skip', label: labelFor(`test.show.${s.id}`), why: s.why,
      })),
    ];
    report(lines);
    const secs = cfg('test.show.seconds', 30);
    setNote(out.started
      ? `Showing ${out.items.length} thing${out.items.length === 1 ? '' : 's'} `
        + `for ${secs}s. Close this panel and watch -- it keeps going.`
      : 'Nothing could be shown; see the reasons above.');
    refreshActions();
  }

  function stop() {
    if (showcase && showcase.stop()) {
      setNote('Stopped. Everything is back to how it was.');
    }
    refreshActions();
  }

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    boxRefs.clear();
    document.removeEventListener('keydown', onKeyDown, true);
    if (onClose) onClose();
  }

  function onKeyDown(e) { if (e && e.key === 'Escape') close(); }

  /** One checkbox row, with its explanation ON the panel. A wall display is
   *  never hovered, so an explanation in a `title` reaches nobody -- the same
   *  call that printed Randomize's scope under its button. */
  function renderRow(item, cls) {
    const row = el('label', 'test-opt');
    const box = el('input', 'test-check');
    box.type = 'checkbox';
    box.checked = !!cfg(item.path, false);
    box.setAttribute('data-path', item.path);
    box.addEventListener('change', () => { write(item.path, box.checked); refreshActions(); });
    boxRefs.set(item.path, box);
    row.append(box, el('span', 'test-opt-label', item.label));

    if (item.param) {
      const e = entry(item.param);
      const wrap = el('span', 'test-param');
      wrap.append(el('span', 'test-param-label', `${item.paramLabel} `));
      const range = el('input', 'test-param-range');
      range.type = 'range';
      range.min = String(e.min);
      range.max = String(e.max);
      range.step = '1';
      range.value = String(cfg(item.param, e.min));
      const out = el('span', 'test-param-value', String(cfg(item.param, e.min)));
      range.addEventListener('input', () => {
        write(item.param, Number(range.value));
        out.textContent = String(cfg(item.param, e.min));
      });
      wrap.append(range, out);
      row.append(wrap);
    }

    const e = entry(item.path);
    if (e && e.help) row.append(el('span', 'test-opt-help', e.help));
    row.className = cls ? `test-opt ${cls}` : 'test-opt';
    return row;
  }

  function open() {
    if (node) return true;
    boxRefs.clear();
    node = el('div', 'test-panel');
    node.append(el('div', 'test-title', 'Test Mode'));
    node.append(el('div', 'test-hint',
      'Put things on screen that are not happening right now, so you can see '
      + 'how they look. Nothing here changes what the collector records or what '
      + 'any other display shows.'));

    const showSec = el('div', 'test-cat');
    const head = el('div', 'test-cat-head');
    head.append(el('h3', 'test-cat-title', 'Show me'));
    showSec.append(head);
    for (const item of SHOW_ITEMS) showSec.append(renderRow(item));
    node.append(showSec);

    node.append(el('div', 'test-report'));
    node.append(el('div', 'test-note'));

    const foot = el('div', 'test-foot');
    const showBtn = el('button', 'test-show', 'Show these');
    showBtn.title = 'Put the ticked things on screen for a while.';
    showBtn.addEventListener('click', show);
    const stopBtn = el('button', 'test-stop', 'Stop');
    stopBtn.title = 'End the showing now and put everything back.';
    stopBtn.addEventListener('click', stop);
    const closeBtn = el('button', 'test-close', 'Close');
    closeBtn.title = 'Close this panel. A showing keeps going -- that is the point.';
    closeBtn.addEventListener('click', close);
    foot.append(showBtn, stopBtn, closeBtn);
    node.append(foot);

    // The previews last, and visibly separate: they are the same question by a
    // different route, and mixing them into the list above is what made the old
    // panel read as a grab bag.
    const prevSec = el('div', 'test-cat test-preview-cat');
    const phead = el('div', 'test-cat-head');
    phead.append(el('h3', 'test-cat-title', 'Or preview by pointing at it'));
    prevSec.append(phead);
    prevSec.append(el('p', 'test-cat-lead',
      'Hover a control and it applies live until you move away. Nothing is '
      + 'saved and nothing needs to be stopped.'));
    for (const item of PREVIEW_ITEMS) prevSec.append(renderRow(item));
    node.append(prevSec);

    mount.appendChild(node);
    refreshActions();
    document.addEventListener('keydown', onKeyDown, true);
    return true;
  }

  return { open, close, isOpen, sync };
}
