// The custom-arcs editor.
//
// Everything above the DOM line is pure and unit-tested: which rows exist,
// which of them are valid, and which are ready to apply. The DOM half below
// builds the modal and does nothing a test could decide.
//
// The panel writes ONLY through settings.apply({'arcs.custom': list}) -- never
// arcs.setRules, never CONFIG, never localStorage. That is the same rule
// menu.js follows, and it is what keeps one validator and one vocabulary
// between the panel, the menu, an imported file and any future write API.
import { parseRule } from './rules.js';
import { cfg } from './config.js';
import { rampHexAt, activeRampStops } from './ramp.js';
import { serialiseRules, parseImport, exportFilename, KEY, loadPatch }
  from './rulestore.js';
import { stageConversion } from './convert.js';

/** One row per rule: what the boxes show, and why a row is refused.
 *
 *  The matcher is kept EXACTLY as typed on a row that does not parse --
 *  re-rendering a half-typed CIDR as anything else fights the person typing
 *  it. A row that does parse shows the normalised values the engine will
 *  actually use, so `#0f8` becomes `#00ff88` and an omitted end shows as
 *  `either` rather than as a blank that reads as unset.
 *
 *  `gain`/`bloomScale` ride through UNTOUCHED from the raw entry when present,
 *  and are left off the row entirely when absent -- never set to an explicit
 *  `undefined`, which would still be an own key and would round-trip into
 *  storage as "this rule now has a gain of nothing". Neither field has a
 *  control in this build's UI, so the only way either could change here is by
 *  accident; carrying them through is what keeps a rule imported with them
 *  (Task 4) from losing them the moment someone opens this panel. */
export function panelRows(list) {
  const raw = Array.isArray(list) ? list : [];
  return raw.map((entry, index) => {
    const { rule, reason } = parseRule(entry);
    const src = entry || {};
    const row = {
      index,
      match: typeof src.match === 'string' ? src.match : '',
      end: rule ? rule.end : (src.end || 'either'),
      color: rule ? rule.color : (typeof src.color === 'string' ? src.color : ''),
      name: rule ? rule.name : (typeof src.name === 'string' ? src.name : ''),
      enabled: src.enabled !== false,
      reason: reason || null,
    };
    if (typeof src.gain === 'number') row.gain = src.gain;
    if (typeof src.bloomScale === 'number') row.bloomScale = src.bloomScale;
    return row;
  });
}

/** The rows that parse, back as raw rule objects, in list order.
 *
 *  The panel filters here rather than letting settings.js do it, because the
 *  schema's `rules` coerce is deliberately all-or-nothing: a patch arriving
 *  through the API is one deliberate act, while a row someone is mid-typing in
 *  is not, and refusing the whole list on every keystroke would make the
 *  editor unusable.
 *
 *  `gain`/`bloomScale` are put back only when the row actually carries them --
 *  same rule as `panelRows`, so a rule that never had them does not acquire
 *  them, and a rule that did keeps them across every apply this panel makes.
 *  Opening the panel makes none on its own -- see `dirty` on `applyDraft`. */
export function readyRules(rows) {
  return (rows || [])
    .filter((r) => !r.reason)
    .map((r) => {
      const out = { match: r.match, end: r.end, color: r.color,
                    name: r.name, enabled: r.enabled };
      if (typeof r.gain === 'number') out.gain = r.gain;
      if (typeof r.bloomScale === 'number') out.bloomScale = r.bloomScale;
      return out;
    });
}

// ---------------------------------------------------------------- the DOM --
//
// Mounted on document.body, NEVER on #stage: #stage is `position: fixed` and a
// fixed element creates a stacking context, so #rail -- a later sibling of
// #stage -- paints over everything inside it. The menu hit exactly this and a
// z-index of 9999 changed nothing.

const cfgCustom = () => cfg('arcs.custom', []);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The stored value is the vocabulary `rules.js` validates and an exported file
// carries; only the label is spelled out. Abbreviating in the UI saved a few
// pixels and cost a reading -- "dst" is jargon on a wall somebody else walks up
// to. Never send the label back into a rule.
const ENDS = ['either', 'src', 'dst'];
const END_LABEL = { either: 'either', src: 'source', dst: 'dest' };

// Every form the matcher accepts, in the order rules.js's parser tries to make
// sense of one, each with an example that really parses. Kept beside MATCH_HELP
// so the legend on the panel, the tooltip and the parser cannot drift: if a
// fifth form is ever added to rules.js, this list is the visible half of it.
//
// The examples are documentation ranges (RFC 5737 203.0.113.0/24, RFC 3849
// 2001:db8::/32) and an RFC 1918 block, never anything from the network this
// happens to be deployed on.
export const MATCH_FORMS = [
  ['subnet', '10.20.50.0/24', 'a whole network, v4 or v6 (2001:db8::/32)'],
  ['range', '203.0.113.10-203.0.113.40', 'first to last address, inclusive'],
  ['country', 'DE', 'two-letter code, matched against the arc\'s end'],
  ['port', 'tcp/443', 'or udp/51820, or just 443 for either protocol'],
];

// The help each control carries, as a `title` and in the header above it. Kept
// here rather than inline so the header and the field cannot drift apart, and
// so the wording is one edit rather than five.
const MATCH_HELP =
  'What this custom arc looks for, one of: a subnet (10.20.50.0/24 or 2001:db8::/32), '
  + 'an inclusive address range (203.0.113.10-203.0.113.40), a two-letter '
  + 'country code (DE), or a port with the protocol optional (tcp/443, '
  + 'udp/51820, 443).';
const END_HELP =
  'Which end of the arc has to match: the source, the destination, or either '
  + 'end. Country and port matchers read the same end.';
const COLOR_HELP =
  'The color arcs matching this custom arc are drawn in. It reaches arcs already on '
  + 'screen, not just the next one.';
// The two built-in classes. Their colors used to be two ramp-position sliders
// on the TUNING panel, one group away from the arc gains -- so "what color is
// a block" was answered in one place, "what color is this custom arc" in another,
// and the rail's legend in a third. They are the same question, so they are
// asked here.
//
// They sit IN the list, not in a block of their own above it, and in their
// real precedence order: a block is never recolored by a custom arc, so it is
// the first row; a flow no custom arc claims falls through to `arcs.flow`, so
// it is the
// last. The panel's own hint says the list is checked top to bottom, and with
// the defaults pulled out into a separate section that sentence described
// only the middle of what was on screen. Every row a person can see is now
// one list in the order the engine actually uses.
//
// `colorAt` is deliberately NOT reproduced here. A class either follows the
// theme (`auto`, which resolves through the ramp at the class's own position)
// or carries an explicit color, and those are the two states a person needs;
// a ramp POSITION is a third vocabulary for the same setting and the theme
// panel already owns "everything follows the ramp".
const BUILTIN = {
  block: {
    label: 'Geo-blocked',
    match: 'any blocked arc',
    end: 'first',
    help: 'The alarm layer: an arc the router refused. Blocks are never '
        + 'recolored by a custom arc, whatever the entries below say, which is '
        + 'why this row is at the top and cannot be turned off.',
  },
  flow: {
    label: 'All other traffic',
    match: 'everything else',
    end: 'fallback',
    help: 'Every arc no custom arc above has claimed. Add one to carve traffic '
        + 'out of this row; it cannot be turned off, because something has to '
        + 'color the rest.',
  },
};
const AUTO_HELP =
  'Back to the theme. On auto the class takes its color from the active ramp '
  + 'at its own position, so switching themes recolors it with everything else.';
const NAME_HELP =
  'Optional. What to call this custom arc in the stats rail -- "storj nodes" says '
  + 'more than the subnet does. Not used for matching.';

export function createCustomArcsPanel({ settings, storage, confirmer, pending,
                                       root, onClose } = {}) {
  const mount = root || document.body;
  let node = null;
  // The working list, edited row by row. Kept here rather than read back out
  // of CONFIG on every keystroke: CONFIG holds only the rows that PARSE, so a
  // half-typed matcher would vanish from under the cursor between keystrokes.
  let draft = [];
  // Row DOM references, keyed by row index -- what lets a keystroke update
  // ONE row's validity in place instead of rebuilding every <input> on the
  // panel. Rebuilt only on a structural redraw (open, add, delete), which is
  // exactly when the indices this map is keyed by are changing anyway.
  let rowRefs = new Map();
  // Set by an actual edit (editField, add, delete, import) -- never by
  // opening the panel. `open()` seeds `draft` from CONFIG and calls
  // `redraw()` to paint it, and redraw() runs through applyDraft() same as
  // any other change; without this flag that first call persisted the
  // current rule list into localStorage from a look with no edit at all.
  // Two real failures followed from that: a display whose rules came from
  // the collector's NETVIZ_HIGHLIGHT* migration got them captured into
  // storage the moment somebody opened the panel to look, after which
  // mergeServerConfig never migrates again (it only fires on an empty
  // list) and a later .env change silently stops reaching that wall; and
  // any rule that fails to parse is dropped by readyRules, so the reduced
  // list got written back and quietly deleted a rule nobody touched.
  let dirty = false;

  function isOpen() { return node !== null; }

  /** Validate the whole draft and, if an edit actually happened, push it
   *  through settings.apply. Returns the full row list (index-aligned with
   *  `draft`) so a caller can read back just the row it cares about --
   *  validation runs every time regardless of `dirty`, since the row display
   *  (which fields are red, what the reason line says) has to reflect
   *  whatever is in the boxes even before anything is saved. Only the
   *  persisting write is gated. */
  function applyDraft() {
    const rows = panelRows(draft);
    if (dirty) {
      const out = settings.apply({ 'arcs.custom': readyRules(rows) });
      for (const r of out.rejected) console.warn(`netviz: ${r.path} -- ${r.why}`);
    }
    return rows;
  }

  /** Structural change: the row COUNT or ORDER is different, so every index
   *  after the change point is stale and there is no single row to patch.
   *  Rebuilds every input node -- fine here because the node whose focus
   *  would be lost (the +/x button just clicked) is not a text field a
   *  person is mid-keystroke in. */
  function redraw() {
    const rows = applyDraft();
    rowRefs = new Map();
    const list = node.querySelector('.custom-arc-list');
    list.replaceChildren();
    // Both built-ins on top, above the custom rows. PANEL LAYOUT ONLY:
    // precedence is unchanged and must stay so. `flow` is the FALLBACK -- it
    // matches whatever nothing else claimed -- so moving it above the custom
    // rows in PRECEDENCE would make it claim everything and no custom arc
    // would ever draw again.
    list.append(builtinRow('block'));
    list.append(builtinRow('flow'));
    for (const row of rows) list.append(renderRow(row));
    list.append(renderAdd());
  }

  /** One line under the buttons. Import is the only action here whose result
   *  is invisible on the globe -- a refused file changes nothing, which is
   *  indistinguishable from a file that changed nothing. */
  function showNote(text) {
    const note = node && node.querySelector('.custom-arc-note');
    if (note) note.textContent = text;
  }

  /** Non-structural change: one row's own field. Re-validates and re-applies
   *  the WHOLE draft (a row's validity cannot be judged in isolation from the
   *  schema without duplicating parseRule's rules here), but touches only
   *  that row's own DOM afterward -- never `list.replaceChildren()`, which
   *  would destroy the very <input> the person is typing into along with
   *  every other row's, and rebuild fresh nodes nobody has focused. */
  function editField(index, key, value) {
    draft[index] = { ...draft[index], [key]: value };
    dirty = true;
    const rows = applyDraft();
    updateRowDisplay(index, rows[index]);
  }

  /** Patch one row's validity class and reason line in place. Never touches
   *  an input's `.value` -- the field just edited already shows what the
   *  person typed (it IS the source of the value), and touching a sibling
   *  field's value here would fight anything mid-edit in that field too. */
  function updateRowDisplay(index, row) {
    const refs = rowRefs.get(index);
    if (!refs || !row) return;
    refs.wrap.className = `custom-arc-row${row.reason ? ' bad' : ''}`;
    refs.toggle.className = `custom-arc-toggle${row.enabled ? ' on' : ''}`;
    refs.toggle.textContent = row.enabled ? '✓' : '';
    if (row.reason) {
      if (refs.reason) {
        refs.reason.textContent = row.reason;
      } else {
        refs.reason = el('div', 'custom-arc-reason', row.reason);
        refs.wrap.append(refs.reason);
      }
    } else if (refs.reason) {
      refs.reason.remove();
      refs.reason = null;
    }
  }

  function renderRow(row) {
    const wrap = el('div', `custom-arc-row${row.reason ? ' bad' : ''}`);
    wrap.setAttribute('data-index', String(row.index));

    const match = el('input', 'custom-arc-match');
    match.value = row.match;
    match.placeholder = '10.20.50.0/24, DE, tcp/443';
    match.title = MATCH_HELP;
    match.addEventListener('input', () => editField(row.index, 'match', match.value));
    wrap.append(match);

    const end = el('select', 'custom-arc-end');
    for (const v of ENDS) {
      const opt = el('option', null, END_LABEL[v]);
      opt.value = v;
      if (v === row.end) opt.selected = true;
      end.append(opt);
    }
    end.title = END_HELP;
    end.addEventListener('change', () => editField(row.index, 'end', end.value));
    wrap.append(end);

    const swatch = el('input', 'custom-arc-color');
    swatch.type = 'color';
    swatch.value = /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : '#a855f7';
    swatch.title = COLOR_HELP;
    swatch.addEventListener('input', () => editField(row.index, 'color', swatch.value));
    wrap.append(swatch);

    const name = el('input', 'custom-arc-name');
    name.value = row.name;
    name.placeholder = 'label for the rail (optional)';
    name.title = NAME_HELP;
    name.addEventListener('input', () => editField(row.index, 'name', name.value));
    wrap.append(name);

    const on = el('button', `custom-arc-toggle${row.enabled ? ' on' : ''}`, row.enabled ? '✓' : '');
    // NOT `!row.enabled`: `row` is a snapshot from whenever this closure was
    // built, and a non-structural edit patches the DOM in place without
    // re-rendering the row -- so a captured `row.enabled` goes stale after
    // the first click and every click after that flips the same frozen
    // value, a no-op. `draft` is the live state every editField() call reads
    // and writes, so reading it here at click time is what every other
    // handler already does implicitly by reading its own input's `.value`.
    on.addEventListener('click', () => editField(row.index, 'enabled', !draft[row.index].enabled));
    wrap.append(on);

    const del = el('button', 'custom-arc-delete', '✕');
    del.addEventListener('click', () => {
      draft = draft.filter((_, i) => i !== row.index);
      dirty = true;
      redraw();
    });
    wrap.append(del);

    let reasonNode = null;
    if (row.reason) reasonNode = el('div', 'custom-arc-reason', row.reason);
    if (reasonNode) wrap.append(reasonNode);

    rowRefs.set(row.index, { wrap, match, end, swatch, name, toggle: on, reason: reasonNode });
    return wrap;
  }

  /** Resolved color of a built-in class right now: its own hex, or the ramp
   *  at its position when it is on `auto`. Read fresh on every redraw --
   *  cfg() is the live value, and a theme change moves it without this panel
   *  hearing about it. */
  function builtinColor(cls) {
    const explicit = cfg(`arcs.${cls}.color`, 'auto');
    if (explicit && explicit !== 'auto') return explicit;
    return rampHexAt(cfg(`arcs.${cls}.colorAt`, 0.3), activeRampStops());
  }

  function builtinRow(cls) {
    const spec = BUILTIN[cls];
    // `custom-arc-fixed`, NOT `custom-arc-row`: that class means "an editable
    // custom arc" to this panel's own code and to tools/verify_rules_editor.py,
    // which counts them with it. The CSS gives the two selectors the same columns, so the
    // rows line up under one header while the count stays honest.
    const wrap = el('div', 'custom-arc-fixed');
    wrap.title = spec.help;

    wrap.append(el('span', 'custom-arc-fixed-match', spec.match));
    wrap.append(el('span', 'custom-arc-fixed-end', spec.end));

    const onAuto = cfg(`arcs.${cls}.color`, 'auto') === 'auto';
    const swatch = el('input', 'custom-arc-color');
    swatch.type = 'color';
    swatch.value = builtinColor(cls);
    swatch.title = spec.help;
    swatch.addEventListener('input', () => {
      const out = settings.apply({ [`arcs.${cls}.color`]: swatch.value });
      for (const r of out.rejected) console.warn(`netviz: ${r.path} -- ${r.why}`);
      refreshBuiltin();
    });
    wrap.append(swatch);

    wrap.append(el('span', 'custom-arc-fixed-name', onAuto ? `${spec.label} (theme)` : spec.label));

    // The flags column, occupied rather than empty: these two rows have no
    // on/off and no delete -- one is never overridden and the other is the
    // fallback -- and a gap where every other row has buttons reads as a row
    // whose buttons failed to draw. The undo lives here instead.
    const undo = el('button', 'custom-arc-fixed-auto', '↺');
    undo.title = 'Back to the theme. On auto the class takes its color from '
               + 'the active ramp at its own position, so switching themes '
               + 'recolors it with everything else.';
    undo.disabled = onAuto;
    undo.addEventListener('click', () => {
      settings.apply({ [`arcs.${cls}.color`]: 'auto' });
      refreshBuiltin();
    });
    wrap.append(undo);
    return wrap;
  }

  /** Repaint just the two fixed rows. Their own edits change what they show --
   *  the swatch resolves through the ramp on auto, the label says so, and the
   *  undo button's disabled state is that same fact -- and rebuilding the
   *  whole list would destroy the rule row somebody may be mid-keystroke in. */
  function refreshBuiltin() {
    if (!node) return;
    // By POSITION -- block is the first fixed row and flow is the second --
    // rather than by a `dataset` attribute read back off the node. The unit
    // suite runs this file against a hand-built DOM fake with no `dataset`,
    // and a panel that only repaints under a real browser is a panel whose
    // repaint is untested.
    const fixed = [...node.querySelectorAll('.custom-arc-fixed')];
    if (fixed.length !== 2) return;
    fixed[0].replaceWith(builtinRow('block'));
    fixed[1].replaceWith(builtinRow('flow'));
  }

  function renderAdd() {
    const add = el('button', 'custom-arc-add', '+ Add custom arc');
    add.addEventListener('click', () => {
      // A new row starts EMPTY and therefore invalid, which is correct: it
      // contributes no rule until it says something, and its own reason line
      // explains why nothing changed on the globe yet.
      draft = [...draft, { match: '', color: '#a855f7', end: 'either', enabled: true }];
      dirty = true;
      redraw();
    });
    return add;
  }

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onOutside, true);
    if (onClose) onClose();
  }

  function onKeyDown(e) { if (e && e.key === 'Escape') close(); }
  function onOutside(e) {
    if (node && e && e.target && !node.contains(e.target)) close();
  }

  function open() {
    if (node) return true;
    draft = (cfgCustom() || []).map((r) => ({ ...r }));
    dirty = false;
    node = el('div', 'custom-arc-panel');
    node.append(el('div', 'custom-arc-title', 'Custom arcs'));
    // Says what the engine actually does. The old sentence -- "checked top to
    // bottom, the first enabled rule that matches colors it" -- stopped being
    // true the moment the two built-in rows moved above the list: the fallback
    // is on top now, and read top-to-bottom it would claim everything. The
    // PANEL's order is layout; the ENGINE's precedence is unchanged.
    //
    // Rows are NOT draggable in this build either, so promising drag-to-reorder
    // here would be a control that does not exist. Order is changed by deleting
    // and re-adding.
    node.append(el('div', 'custom-arc-hint',
                   'Blocked arcs are never recolored. Your custom arcs are '
                   + 'checked in their own order, and whatever none of them '
                   + 'claims is drawn in the fallback color.'));

    // Every form MATCH accepts, with a working example of each, on the panel
    // rather than in a tooltip. A matcher is the one field with no affordance
    // of its own -- the others are a dropdown, a swatch and free text -- so
    // "what can I even type here" is the question the panel has to answer
    // without being asked. A placeholder cannot: it shows one form out of
    // four and disappears on the first keystroke.
    const legend = el('div', 'custom-arc-legend');
    for (const [form, example, note] of MATCH_FORMS) {
      const rowEl = el('div', 'custom-arc-legend-row');
      rowEl.append(el('span', 'custom-arc-legend-form', form));
      rowEl.append(el('code', 'custom-arc-legend-eg', example));
      rowEl.append(el('span', 'custom-arc-legend-note', note));
      legend.append(rowEl);
    }
    node.append(legend);

    // A header row, not placeholder text alone: a placeholder vanishes the
    // moment somebody types, which is exactly when they are least sure which
    // box they are in. Deliberately NOT class `custom-arc-row` -- that selector
    // means "an editable rule" to the panel's own code and to the verify
    // tools, and a header answering to it would be counted as a rule.
    const head = el('div', 'custom-arc-head');
    for (const [cls, text, tip] of [
      ['h-match', 'Match', MATCH_HELP],
      ['h-end', 'Applies to', END_HELP],
      ['h-color', 'Color', COLOR_HELP],
      ['h-name', 'Label', NAME_HELP],
      // 'On' alone: the two buttons under this header are 50px between them
      // and 'On / Del' wraps to two lines inside that, which drags the whole
      // header row taller than the fields it labels. The tooltip carries the
      // rest.
      ['h-flags', 'On', 'Turn this custom arc off without deleting it, or '
                              + 'remove it. One turned off keeps its place '
                              + 'in the order.'],
    ]) {
      const cell = el('span', cls, text);
      cell.title = tip;
      head.append(cell);
    }
    node.append(head);
    node.append(el('div', 'custom-arc-list'));
    const foot = el('div', 'custom-arc-foot');

    const exportBtn = el('button', 'custom-arc-export', 'Export');
    exportBtn.addEventListener('click', () => {
      // The display's rules live in one browser; this is the only copy that
      // leaves it. A Blob URL rather than a data: URI so a long list is not
      // capped by a URL length nobody documents.
      const blob = new Blob([serialiseRules(readyRules(panelRows(draft)))],
                            { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = exportFilename(new Date());
      a.click();
      URL.revokeObjectURL(a.href);
    });
    foot.append(exportBtn);

    const importInput = el('input', 'custom-arc-import-input');
    importInput.type = 'file';
    importInput.accept = 'application/json,.json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const out = parseImport(await file.text());
      importInput.value = '';                 // so the same file re-imports
      if (out.error) { showNote(`import refused -- ${out.error}`); return; }
      // REPLACE, not merge: a merge cannot express a deleted rule, so an
      // imported backup would resurrect exactly what it was taken to undo.
      draft = out.rules.map((r) => ({ ...r }));
      dirty = true;
      redraw();
      showNote(out.converted
        ? `imported ${out.rules.length} custom arc(s) from an older file`
        : `imported ${out.rules.length} custom arc(s)`);
    });
    const importBtn = el('button', 'custom-arc-import', 'Import');
    importBtn.addEventListener('click', () => importInput.click());
    foot.append(importBtn, importInput);

    const closeBtn = el('button', 'custom-arc-close', 'Close');
    closeBtn.addEventListener('click', close);
    foot.append(closeBtn);
    node.append(foot);
    node.append(el('div', 'custom-arc-note'));
    mount.appendChild(node);
    redraw();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onOutside, true);
    askConversion();
    return true;
  }

  // Asked at most ONCE PER SESSION, never once per open. "Not now" is a real
  // answer and a dialog that reappears every time somebody looks at the panel
  // is one people learn to dismiss without reading -- which is what would make
  // the other questions in this panel stop being read too.
  let conversionAnswered = false;

  function conversionQuestion(descriptors, n) {
    return {
      title: `Store your ${n === 1 ? 'custom arc' : `${n} custom arcs`} under the new name?`,
      lead: 'This display saved them under a name netviz no longer uses. They '
          + 'are already drawing correctly -- this only decides what is written '
          + 'in this browser.',
      will: descriptors.map((d) => d.summary(n)).concat([
        'Rewrite this display\'s saved settings in this browser only.',
      ]),
      wont: [
        'Change which arcs are drawn, or what color any of them is.',
        'Change anything on the collector, or on any other display.',
        'Touch any other setting you have kept.',
      ],
      note: 'Answering "not now" leaves it exactly as it is; the display keeps '
          + 'working either way and you will be asked again after a reload.',
      confirmLabel: 'Yes, store them under the new name',
      cancelLabel: 'Not now',
    };
  }

  function askConversion() {
    if (conversionAnswered || !confirmer || !storage) return;
    const descriptors = pending || [];
    if (!descriptors.length) return;
    const raw = loadPatch(storage).patch;
    const n = descriptors.reduce((sum, d) => sum + d.count(raw), 0);
    confirmer.ask({
      ...conversionQuestion(descriptors, n),
      onConfirm: () => {
        conversionAnswered = true;
        // STAGE AND VALIDATE FIRST. A conversion that lands half its entries
        // reads as "those rules never existed", so the original blob is left
        // untouched and the reason is named on the panel's own note line.
        const out = stageConversion(raw, descriptors);
        if (!out.ok) { showNote(`could not convert -- ${out.error}`); return; }
        try {
          storage.setItem(KEY, JSON.stringify(out.next));
        } catch (e) {
          showNote(`could not convert -- ${e.message}`);
          return;
        }
        pending = [];
        showNote(`Stored ${n} custom arc${n === 1 ? '' : 's'} under the new name.`);
      },
      onCancel: () => { conversionAnswered = true; },
    });
  }

  return { open, close, isOpen };
}
