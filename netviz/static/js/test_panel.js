// Test Mode: what to try on the wall, and what to check about it.
//
// One boolean until 0.7.0 -- `menu.testMode`, a bare toggle whose only
// explanation was a tooltip. A WALL DISPLAY IS NEVER HOVERED, so that
// explanation reached nobody; the same argument that printed Randomize's scope
// on the panel instead of leaving it in a `title`. It is a dialog now, and
// every option says in words what it does.
//
// A MODAL, unlike the settings panel. That panel is a rail meant to be used
// while watching the globe beside it; this one takes the display over for the
// length of a run, which is a modal act.
//
// Every tick writes through `settings.apply` -- these are ordinary persisted
// settings, and a person who ticked four checks and reloaded should find them
// still ticked.
import { cfg } from './config.js';
import { entry } from './settings.js';

/** The five categories, their options, and the plain-language sentence printed
 *  under each heading. The lead is NOT a tooltip, for the reason above. */
export const TEST_CATEGORIES = [
  {
    id: 'preview',
    label: 'Hover preview',
    lead: 'Hover a control and see it on the wall before you commit to it. '
        + 'Moving away puts it back.',
    options: [
      { path: 'test.preview.layers', label: 'Layer toggles in the menu' },
      { path: 'test.preview.settings', label: 'Sliders in the settings panel' },
      { path: 'test.preview.theme', label: 'Palettes in the Theme picker' },
      { path: 'test.preview.rail', label: 'The stats rail (resizes the display)' },
    ],
  },
  {
    id: 'arcs',
    label: 'Sample arcs',
    lead: 'Draw arcs on demand rather than waiting for traffic. Nothing here '
        + 'is injected as an event, so no counter on the rail moves.',
    options: [
      { path: 'test.arcs.flow', label: 'One flow arc' },
      { path: 'test.arcs.blocked', label: 'One blocked arc' },
      { path: 'test.arcs.custom', label: 'One arc per custom arc you have defined' },
      { path: 'test.arcs.flood', label: '200 arcs at once' },
    ],
  },
  {
    id: 'layers',
    label: 'Layers',
    lead: 'One pass through the layers, so you can see what each contributes.',
    options: [
      { path: 'test.layers.cycle', label: 'Cycle each layer on in turn' },
    ],
  },
  {
    id: 'feeds',
    label: 'Feeds',
    lead: 'Is data actually arriving, and how old is the newest of it.',
    options: [
      { path: 'test.feeds.netflow', label: 'Netflow is alive' },
      { path: 'test.feeds.blocks', label: 'The block feed is alive' },
      { path: 'test.feeds.socket', label: 'This display is connected' },
      { path: 'test.feeds.collector', label: 'The collector is reachable and healthy' },
    ],
  },
  {
    id: 'geo',
    label: 'Geography',
    lead: 'Is the map right. A mirrored globe looks perfectly fine until you '
        + 'know one of the landmarks on it.',
    options: [
      { path: 'test.geo.landmarks', label: 'Landmarks land where they should' },
      { path: 'test.geo.home', label: 'Home is where the collector says it is' },
    ],
  },
];

/** Every option path, in panel order. */
export function testPaths() {
  return TEST_CATEGORIES.flatMap((c) => c.options.map((o) => o.path));
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createTestPanel({ settings, confirmer, runner, root, onClose } = {}) {
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
  }

  /** Tick every option in one category. A category with a SINGLE option gets no
   *  button at all -- a control offering to enable one thing is the same empty
   *  question confirm.js already refuses to ask. */
  function enableCategory(id) {
    const cat = TEST_CATEGORIES.find((c) => c.id === id);
    if (!cat) return;
    for (const opt of cat.options) write(opt.path, true);
    sync();
    setNote(`Turned on all ${cat.options.length} ${cat.label.toLowerCase()} checks.`);
  }

  function enableEverything() {
    for (const path of testPaths()) write(path, true);
    sync();
    setNote(`Turned on all ${testPaths().length} checks.`);
  }

  function ticked() { return testPaths().filter((p) => cfg(p, false)); }

  function showReport(lines) {
    const box = node && node.querySelector('.test-report');
    if (!box) return;
    box.replaceChildren();
    for (const line of lines || []) {
      const row = el('div', `test-report-row ${line.ok ? 'pass' : 'fail'}`);
      row.append(el('span', 'test-report-mark', line.ok ? '✓' : '✕'));
      row.append(el('span', 'test-report-label', line.label));
      row.append(el('span', 'test-report-why', line.why || ''));
      box.append(row);
    }
  }

  function run() {
    const paths = ticked();
    if (!paths.length) {
      // A run of nothing is a run that always passes, which teaches that the
      // button means nothing. Say so instead.
      setNote('Nothing is ticked, so there is nothing to run.');
      showReport([]);
      return;
    }
    if (!runner) { setNote('No self-test runner is wired up.'); return; }
    setNote(`Running ${paths.length} check${paths.length === 1 ? '' : 's'}...`);
    const lines = runner(paths) || [];
    showReport(lines);
    const failed = lines.filter((l) => !l.ok).length;
    setNote(failed
      ? `${failed} of ${lines.length} checks failed.`
      : `All ${lines.length} checks passed.`);
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

  function open() {
    if (node) return true;
    boxRefs.clear();
    node = el('div', 'test-panel');
    node.append(el('div', 'test-title', 'Test Mode'));
    node.append(el('div', 'test-hint',
      'Nothing here changes what the collector sees or what any other display '
      + 'shows. What you tick is remembered on this screen.'));

    for (const cat of TEST_CATEGORIES) {
      const section = el('div', 'test-cat');
      const head = el('div', 'test-cat-head');
      head.append(el('h3', 'test-cat-title', cat.label));
      if (cat.options.length > 1) {
        const all = el('button', 'test-all', 'enable all');
        all.setAttribute('data-cat', cat.id);
        all.title = `Tick all ${cat.options.length} of these.`;
        all.addEventListener('click', () => enableCategory(cat.id));
        head.append(all);
      }
      section.append(head);
      section.append(el('p', 'test-cat-lead', cat.lead));
      for (const opt of cat.options) {
        const row = el('label', 'test-opt');
        const box = el('input', 'test-check');
        box.type = 'checkbox';
        box.checked = !!cfg(opt.path, false);
        box.addEventListener('change', () => write(opt.path, box.checked));
        boxRefs.set(opt.path, box);
        row.append(box, el('span', 'test-opt-label', opt.label));
        // The explanation goes ON the panel, not in a tooltip -- a wall
        // display is never hovered.
        const e = entry(opt.path);
        if (e && e.help) row.append(el('span', 'test-opt-help', e.help));
        section.append(row);
      }
      node.append(section);
    }

    node.append(el('div', 'test-report'));
    node.append(el('div', 'test-note'));

    const foot = el('div', 'test-foot');
    const allBtn = el('button', 'test-enable-all', 'Enable everything');
    allBtn.addEventListener('click', enableEverything);
    const runBtn = el('button', 'test-run', 'Run');
    runBtn.title = 'Run the checks that are ticked and report what each one found.';
    runBtn.addEventListener('click', run);
    const closeBtn = el('button', 'test-close', 'Close');
    closeBtn.addEventListener('click', close);
    foot.append(allBtn, runBtn, closeBtn);
    node.append(foot);

    mount.appendChild(node);
    document.addEventListener('keydown', onKeyDown, true);
    return true;
  }

  return { open, close, isOpen, report: showReport };
}
