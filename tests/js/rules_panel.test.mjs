import test from 'node:test';
import assert from 'node:assert/strict';
import { panelRows, readyRules, createRulesPanel } from '../../netviz/static/js/rules_panel.js';
import { CONFIG } from '../../netviz/static/js/config.js';

test('one row per rule, in list order, with its own validity', () => {
  const rows = panelRows([
    { match: '10.20.50.0/24', color: '#22d3ee', name: 'storj' },
    { match: 'nonsense', color: '#ffffff' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].index, 0);
  assert.equal(rows[0].match, '10.20.50.0/24');
  assert.equal(rows[0].name, 'storj');
  assert.equal(rows[0].reason, null);
  assert.equal(rows[1].index, 1);
  assert.match(rows[1].reason, /unrecognised/);
});

test('a refusal attaches to its own row and no other', () => {
  const rows = panelRows([
    { match: 'nonsense', color: '#fff' },
    { match: 'DE', color: '#fff' },
  ]);
  assert.ok(rows[0].reason);
  assert.equal(rows[1].reason, null);
});

test('defaults are filled in for display without being invented', () => {
  // `end` defaults to 'either' in rules.js; the panel shows what the engine
  // will do, not a blank that reads as "unset".
  const rows = panelRows([{ match: 'DE', color: '#0f8' }]);
  assert.equal(rows[0].end, 'either');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].color, '#00ff88');    // normalised through parseRule
});

test('a row that cannot parse keeps the text as typed', () => {
  // Re-rendering a half-typed matcher as anything other than what is in the
  // box would fight the person typing it.
  const rows = panelRows([{ match: '10.20.50.', color: '#fff' }]);
  assert.equal(rows[0].match, '10.20.50.');
  assert.ok(rows[0].reason);
});

test('readyRules drops the rows that do not parse and keeps the order', () => {
  const list = [
    { match: '10.20.50.0/24', color: '#22d3ee' },
    { match: 'nonsense', color: '#ffffff' },
    { match: 'DE', color: '#ff8800' },
  ];
  const ready = readyRules(panelRows(list));
  assert.equal(ready.length, 2);
  assert.equal(ready[0].match, '10.20.50.0/24');
  assert.equal(ready[1].match, 'DE');
});

test('a disabled row is ready and keeps its position', () => {
  // Position is precedence, so a disabled rule must still occupy its slot --
  // turning one off may not renumber, and therefore recolor, the rest.
  const ready = readyRules(panelRows([
    { match: '10.0.0.0/8', color: '#111111', enabled: false },
    { match: 'DE', color: '#222222' },
  ]));
  assert.equal(ready.length, 2);
  assert.equal(ready[0].enabled, false);
  assert.equal(ready[1].match, 'DE');
});

test('an empty list produces no rows and no error', () => {
  assert.deepEqual(panelRows([]), []);
  assert.deepEqual(readyRules([]), []);
  assert.deepEqual(panelRows(null), []);
});

test('gain and bloomScale survive panelRows -> readyRules unchanged', () => {
  // Neither field has a control in this build's UI, so the only way either
  // could change here is by accident -- opening the panel must not be a
  // silent way to strip them from a rule an imported file (Task 4) supplied.
  const list = [{ match: 'DE', color: '#ff8800', gain: 0.5, bloomScale: 0.3 }];
  const ready = readyRules(panelRows(list));
  assert.equal(ready.length, 1);
  assert.equal(ready[0].gain, 0.5);
  assert.equal(ready[0].bloomScale, 0.3);
});

test('a rule without gain/bloomScale does not acquire them', () => {
  const list = [{ match: 'DE', color: '#ff8800' }];
  const row = panelRows(list)[0];
  assert.equal('gain' in row, false);
  assert.equal('bloomScale' in row, false);
  const ready = readyRules(panelRows(list))[0];
  assert.equal('gain' in ready, false);
  assert.equal('bloomScale' in ready, false);
});

// ---------------------------------------------------------------- the DOM --
//
// Minimal fake, same discipline as menu.test.mjs's: createElement,
// classList, append/appendChild/replaceChildren, addEventListener/dispatch,
// never innerHTML. Extended with querySelector (class-only, depth-first) and
// a plain writable `value`/`textContent`, which rules_panel.js's DOM half
// needs and menu.js's never did.

function fakeDom() {
  function mk(tag) {
    const listeners = {};
    const attrs = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '', value: '',
      children: [],
      parentNode: null,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      setAttribute(name, v) { attrs[name] = String(v); },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      append(...cs) { for (const c of cs) this.appendChild(c); },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      },
      replaceChildren() {
        for (const c of this.children.slice()) c.parentNode = null;
        this.children = [];
      },
      contains(other) {
        let n = other;
        while (n) { if (n === this) return true; n = n.parentNode; }
        return false;
      },
      querySelector(sel) {
        const cls = sel.replace(/^\./, '');
        const walk = (n) => {
          if (n.className && n.className.split(' ').includes(cls)) return n;
          for (const c of n.children || []) {
            const found = walk(c);
            if (found) return found;
          }
          return null;
        };
        for (const c of this.children) {
          const found = walk(c);
          if (found) return found;
        }
        return null;
      },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      dispatch(type, evt) { (listeners[type] || []).slice().forEach((fn) => fn(evt)); },
    };
    return node;
  }

  const root = mk('div');
  const docListeners = {};
  const document = {
    createElement: (tag) => mk(tag),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, evt) { (docListeners[type] || []).slice().forEach((fn) => fn(evt)); },
  };
  return { root, document };
}

function withFakeGlobals(dom, fn) {
  const realDoc = globalThis.document;
  globalThis.document = dom.document;
  try {
    return fn();
  } finally {
    globalThis.document = realDoc;
  }
}

test('typing in the match field does not rebuild the row -- the input node stays the same object', () => {
  // This is the mechanism that keeps a browser's focus/caret: replacing a
  // node with a fresh one always loses focus, whatever the fresh node's
  // .value says, so proving the SAME node survives an edit is the load
  // -bearing assertion here -- actual focus retention needs a real browser
  // and is covered by Task 6's verify_rules_editor.py instead.
  const dom = fakeDom();
  const savedRules = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [{ match: '10.20.50.0/2', color: '#22d3ee' }];
  try {
    withFakeGlobals(dom, () => {
      const applied = [];
      const panel = createRulesPanel({
        settings: { apply: (patch) => { applied.push(patch); return { rejected: [] }; } },
        root: dom.root,
      });
      panel.open();
      const before = dom.root.querySelector('.rules-match');
      assert.ok(before, 'no .rules-match rendered');
      before.value = '10.20.50.0/24';
      before.dispatch('input', {});
      const after = dom.root.querySelector('.rules-match');
      assert.equal(after, before, 'the match input was replaced by a new node');
      // Live validation still fired on the keystroke. Opening the panel does
      // NOT call settings.apply on its own -- only an actual edit does, so
      // merely looking at the panel cannot capture a collector-migrated rule
      // list into localStorage or drop an unparseable rule nobody touched.
      assert.ok(applied.length >= 1, 'settings.apply was not called on the edit');
      const last = applied[applied.length - 1]['arcs.rules'];
      assert.equal(last[0].match, '10.20.50.0/24');
    });
  } finally {
    CONFIG.arcs.rules = savedRules;
  }
});

test('opening the panel alone never calls settings.apply -- only an edit does', () => {
  // open() -> redraw() -> applyDraft() used to call settings.apply
  // unconditionally, so merely looking at the panel persisted the current
  // rule list into localStorage. Two real failures followed: a display
  // whose rules came from the collector's NETVIZ_HIGHLIGHT* migration got
  // them captured the moment somebody opened the panel to look (after
  // which mergeServerConfig never migrates again, since it only fires on
  // an empty list), and any rule that fails to parse is silently dropped
  // by readyRules and the reduced list gets written back -- deleting a
  // rule nobody touched.
  const dom = fakeDom();
  const savedRules = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [{ match: 'DE', color: '#22d3ee', name: 'germany' }];
  try {
    withFakeGlobals(dom, () => {
      const applied = [];
      const panel = createRulesPanel({
        settings: { apply: (patch) => { applied.push(patch); return { rejected: [] }; } },
        root: dom.root,
      });
      panel.open();
      assert.equal(applied.length, 0,
        'opening the panel called settings.apply with no edit made');

      // An actual edit still applies, proving the gate is not just stuck off.
      const match = dom.root.querySelector('.rules-match');
      match.value = 'FR';
      match.dispatch('input', {});
      assert.ok(applied.length >= 1, 'an edit after opening did not apply');
    });
  } finally {
    CONFIG.arcs.rules = savedRules;
  }
});

test('adding a row is a structural change and does rebuild the list', () => {
  const dom = fakeDom();
  const savedRules = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [{ match: 'DE', color: '#22d3ee' }];
  try {
    withFakeGlobals(dom, () => {
      const panel = createRulesPanel({
        settings: { apply: () => ({ rejected: [] }) },
        root: dom.root,
      });
      panel.open();
      const before = dom.root.querySelector('.rules-match');
      const addBtn = dom.root.querySelector('.rules-add');
      assert.ok(addBtn, 'no .rules-add rendered');
      addBtn.dispatch('click', {});
      const after = dom.root.querySelector('.rules-match');
      assert.notEqual(after, before, 'a structural change did not rebuild the row');
    });
  } finally {
    CONFIG.arcs.rules = savedRules;
  }
});

test('the enabled toggle survives more than one click', () => {
  // A non-structural edit patches the DOM in place rather than re-rendering
  // the row, so a handler built from a snapshot captured at render time (as
  // opposed to reading live state at click time) goes stale after exactly
  // one click: every click after the first recomputes against the same
  // frozen value and is a no-op. A single click cannot tell that apart from
  // correct behaviour -- only a second click can, which is why this test
  // fires the button twice and checks the value is back where it started.
  const dom = fakeDom();
  const savedRules = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [{ match: 'DE', color: '#22d3ee', enabled: true }];
  try {
    withFakeGlobals(dom, () => {
      const applied = [];
      const panel = createRulesPanel({
        settings: { apply: (patch) => { applied.push(patch); return { rejected: [] }; } },
        root: dom.root,
      });
      panel.open();
      const toggle = dom.root.querySelector('.rules-toggle');
      assert.ok(toggle, 'no .rules-toggle rendered');
      assert.ok(toggle.className.includes(' on'), 'row did not start enabled');

      toggle.dispatch('click', {});
      let last = applied[applied.length - 1]['arcs.rules'];
      assert.equal(last[0].enabled, false, 'first click did not disable the rule');
      assert.equal(toggle.className.includes(' on'), false, 'button did not reflect disabled');

      toggle.dispatch('click', {});
      last = applied[applied.length - 1]['arcs.rules'];
      assert.equal(last[0].enabled, true, 'second click did not re-enable the rule -- toggle is stuck');
      assert.ok(toggle.className.includes(' on'), 'button did not reflect re-enabled');
    });
  } finally {
    CONFIG.arcs.rules = savedRules;
  }
});
