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

/** One row per rule: what the boxes show, and why a row is refused.
 *
 *  The matcher is kept EXACTLY as typed on a row that does not parse --
 *  re-rendering a half-typed CIDR as anything else fights the person typing
 *  it. A row that does parse shows the normalised values the engine will
 *  actually use, so `#0f8` becomes `#00ff88` and an omitted end shows as
 *  `either` rather than as a blank that reads as unset. */
export function panelRows(list) {
  const raw = Array.isArray(list) ? list : [];
  return raw.map((entry, index) => {
    const { rule, reason } = parseRule(entry);
    const src = entry || {};
    return {
      index,
      match: typeof src.match === 'string' ? src.match : '',
      end: rule ? rule.end : (src.end || 'either'),
      colour: rule ? rule.colour : (typeof src.colour === 'string' ? src.colour : ''),
      name: rule ? rule.name : (typeof src.name === 'string' ? src.name : ''),
      enabled: src.enabled !== false,
      reason: reason || null,
    };
  });
}

/** The rows that parse, back as raw rule objects, in list order.
 *
 *  The panel filters here rather than letting settings.js do it, because the
 *  schema's `rules` coerce is deliberately all-or-nothing: a patch arriving
 *  through the API is one deliberate act, while a row someone is mid-typing in
 *  is not, and refusing the whole list on every keystroke would make the
 *  editor unusable. */
export function readyRules(rows) {
  return (rows || [])
    .filter((r) => !r.reason)
    .map((r) => ({ match: r.match, end: r.end, colour: r.colour,
                   name: r.name, enabled: r.enabled }));
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

  function isOpen() { return node !== null; }

  function push() {
    const rows = panelRows(draft);
    const out = settings.apply({ 'arcs.rules': readyRules(rows) });
    for (const r of out.rejected) console.warn(`netviz: ${r.path} -- ${r.why}`);
    return rows;
  }

  function redraw() {
    const rows = push();
    const list = node.querySelector('.rules-list');
    list.replaceChildren();
    for (const row of rows) list.append(renderRow(row));
    list.append(renderAdd());
  }

  function edit(index, key, value) {
    draft[index] = { ...draft[index], [key]: value };
    redraw();
  }

  function renderRow(row) {
    const wrap = el('div', `rules-row${row.reason ? ' bad' : ''}`);
    wrap.setAttribute('data-index', String(row.index));

    const match = el('input', 'rules-match');
    match.value = row.match;
    match.placeholder = '10.20.50.0/24, DE, tcp/443';
    match.addEventListener('input', () => edit(row.index, 'match', match.value));
    wrap.append(match);

    const end = el('select', 'rules-end');
    for (const v of ENDS) {
      const opt = el('option', null, v);
      opt.value = v;
      if (v === row.end) opt.selected = true;
      end.append(opt);
    }
    end.addEventListener('change', () => edit(row.index, 'end', end.value));
    wrap.append(end);

    const colour = el('input', 'rules-colour');
    colour.type = 'color';
    colour.value = /^#[0-9a-f]{6}$/i.test(row.colour) ? row.colour : '#a855f7';
    colour.addEventListener('input', () => edit(row.index, 'colour', colour.value));
    wrap.append(colour);

    const name = el('input', 'rules-name');
    name.value = row.name;
    name.placeholder = 'name (optional)';
    name.addEventListener('input', () => edit(row.index, 'name', name.value));
    wrap.append(name);

    const on = el('button', `rules-toggle${row.enabled ? ' on' : ''}`, row.enabled ? '✓' : '');
    on.addEventListener('click', () => edit(row.index, 'enabled', !row.enabled));
    wrap.append(on);

    const del = el('button', 'rules-delete', '✕');
    del.addEventListener('click', () => {
      draft = draft.filter((_, i) => i !== row.index);
      redraw();
    });
    wrap.append(del);

    if (row.reason) wrap.append(el('div', 'rules-reason', row.reason));
    return wrap;
  }

  function renderAdd() {
    const add = el('button', 'rules-add', '+ Add rule');
    add.addEventListener('click', () => {
      // A new row starts EMPTY and therefore invalid, which is correct: it
      // contributes no rule until it says something, and its own reason line
      // explains why nothing changed on the globe yet.
      draft = [...draft, { match: '', colour: '#a855f7', end: 'either', enabled: true }];
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
    node = el('div', 'rules-panel');
    node.append(el('div', 'rules-title', 'Colour rules'));
    // Says what the engine does, and nothing it does not: rows are NOT
    // draggable in this build, so promising drag-to-reorder here would be a
    // control that does not exist. Order is changed by deleting and re-adding.
    node.append(el('div', 'rules-hint',
                   'The first enabled rule that matches an arc colours it.'));
    node.append(el('div', 'rules-list'));
    const foot = el('div', 'rules-foot');
    const closeBtn = el('button', 'rules-close', 'Close');
    closeBtn.addEventListener('click', close);
    foot.append(closeBtn);
    node.append(foot);
    mount.appendChild(node);
    redraw();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onOutside, true);
    return true;
  }

  return { open, close, isOpen };
}
