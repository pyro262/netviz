// The colour-rules editor.
//
// Everything above the DOM line is pure and unit-tested: which rows exist,
// which of them are valid, and which are ready to apply. The DOM half below
// builds the modal and does nothing a test could decide.
//
// The panel writes ONLY through settings.apply({'arcs.rules': list}) -- never
// arcs.setRules, never CONFIG, never localStorage. That is the same rule
// menu.js follows, and it is what keeps one validator and one vocabulary
// between the panel, the menu, an imported file and any future write API.
import { parseRule } from './rules.js';
import { cfg } from './config.js';
import { serialiseRules, parseImport, exportFilename, clearPatch } from './rulestore.js';

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
      colour: rule ? rule.colour : (typeof src.colour === 'string' ? src.colour : ''),
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
      const out = { match: r.match, end: r.end, colour: r.colour,
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

const cfgRules = () => cfg('arcs.rules', []);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ENDS = ['either', 'src', 'dst'];

export function createRulesPanel({ settings, root, onClose } = {}) {
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
      const out = settings.apply({ 'arcs.rules': readyRules(rows) });
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
    const list = node.querySelector('.rules-list');
    list.replaceChildren();
    for (const row of rows) list.append(renderRow(row));
    list.append(renderAdd());
  }

  /** One line under the buttons. Import is the only action here whose result
   *  is invisible on the globe -- a refused file changes nothing, which is
   *  indistinguishable from a file that changed nothing. */
  function showNote(text) {
    const note = node && node.querySelector('.rules-note');
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
    refs.wrap.className = `rules-row${row.reason ? ' bad' : ''}`;
    refs.toggle.className = `rules-toggle${row.enabled ? ' on' : ''}`;
    refs.toggle.textContent = row.enabled ? '✓' : '';
    if (row.reason) {
      if (refs.reason) {
        refs.reason.textContent = row.reason;
      } else {
        refs.reason = el('div', 'rules-reason', row.reason);
        refs.wrap.append(refs.reason);
      }
    } else if (refs.reason) {
      refs.reason.remove();
      refs.reason = null;
    }
  }

  function renderRow(row) {
    const wrap = el('div', `rules-row${row.reason ? ' bad' : ''}`);
    wrap.setAttribute('data-index', String(row.index));

    const match = el('input', 'rules-match');
    match.value = row.match;
    match.placeholder = '10.20.50.0/24, DE, tcp/443';
    match.addEventListener('input', () => editField(row.index, 'match', match.value));
    wrap.append(match);

    const end = el('select', 'rules-end');
    for (const v of ENDS) {
      const opt = el('option', null, v);
      opt.value = v;
      if (v === row.end) opt.selected = true;
      end.append(opt);
    }
    end.addEventListener('change', () => editField(row.index, 'end', end.value));
    wrap.append(end);

    const colour = el('input', 'rules-colour');
    colour.type = 'color';
    colour.value = /^#[0-9a-f]{6}$/i.test(row.colour) ? row.colour : '#a855f7';
    colour.addEventListener('input', () => editField(row.index, 'colour', colour.value));
    wrap.append(colour);

    const name = el('input', 'rules-name');
    name.value = row.name;
    name.placeholder = 'name (optional)';
    name.addEventListener('input', () => editField(row.index, 'name', name.value));
    wrap.append(name);

    const on = el('button', `rules-toggle${row.enabled ? ' on' : ''}`, row.enabled ? '✓' : '');
    // NOT `!row.enabled`: `row` is a snapshot from whenever this closure was
    // built, and a non-structural edit patches the DOM in place without
    // re-rendering the row -- so a captured `row.enabled` goes stale after
    // the first click and every click after that flips the same frozen
    // value, a no-op. `draft` is the live state every editField() call reads
    // and writes, so reading it here at click time is what every other
    // handler already does implicitly by reading its own input's `.value`.
    on.addEventListener('click', () => editField(row.index, 'enabled', !draft[row.index].enabled));
    wrap.append(on);

    const del = el('button', 'rules-delete', '✕');
    del.addEventListener('click', () => {
      draft = draft.filter((_, i) => i !== row.index);
      dirty = true;
      redraw();
    });
    wrap.append(del);

    let reasonNode = null;
    if (row.reason) reasonNode = el('div', 'rules-reason', row.reason);
    if (reasonNode) wrap.append(reasonNode);

    rowRefs.set(row.index, { wrap, match, end, colour, name, toggle: on, reason: reasonNode });
    return wrap;
  }

  function renderAdd() {
    const add = el('button', 'rules-add', '+ Add rule');
    add.addEventListener('click', () => {
      // A new row starts EMPTY and therefore invalid, which is correct: it
      // contributes no rule until it says something, and its own reason line
      // explains why nothing changed on the globe yet.
      draft = [...draft, { match: '', colour: '#a855f7', end: 'either', enabled: true }];
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
    draft = (cfgRules() || []).map((r) => ({ ...r }));
    dirty = false;
    node = el('div', 'rules-panel');
    node.append(el('div', 'rules-title', 'Colour rules'));
    // Says what the engine does, and nothing it does not: rows are NOT
    // draggable in this build, so promising drag-to-reorder here would be a
    // control that does not exist. Order is changed by deleting and re-adding.
    node.append(el('div', 'rules-hint',
                   'The first enabled rule that matches an arc colours it.'));
    node.append(el('div', 'rules-list'));
    const foot = el('div', 'rules-foot');

    const exportBtn = el('button', 'rules-export', 'Export');
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

    const importInput = el('input', 'rules-import-input');
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
      showNote(`imported ${out.rules.length} rule(s)`);
    });
    const importBtn = el('button', 'rules-import', 'Import');
    importBtn.addEventListener('click', () => importInput.click());
    foot.append(importBtn, importInput);

    const resetBtn = el('button', 'rules-reset', 'Reset to collector');
    resetBtn.addEventListener('click', () => {
      // Forget everything, then reload: the collector's config and the
      // NETVIZ_HIGHLIGHT* migration are applied at boot, so there is no way to
      // restore them mid-session without re-running that path.
      //
      // The PROPERTY access can itself throw (a managed kiosk policy makes
      // window.localStorage a getter that raises SecurityError) -- same guard
      // main.js already applies before it ever calls withPersistence.
      let storage = null;
      try {
        storage = window.localStorage;
      } catch (e) {
        showNote(`settings storage unavailable -- ${e.message}`);
        return;
      }
      const out = clearPatch(storage);
      if (!out.ok) { showNote(out.error); return; }
      window.location.reload();
    });
    foot.append(resetBtn);

    const closeBtn = el('button', 'rules-close', 'Close');
    closeBtn.addEventListener('click', close);
    foot.append(closeBtn);
    node.append(foot);
    node.append(el('div', 'rules-note'));
    mount.appendChild(node);
    redraw();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onOutside, true);
    return true;
  }

  return { open, close, isOpen };
}
