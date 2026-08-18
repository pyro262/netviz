import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAOS_PATHS } from '../../netviz/static/js/randomize_color.js';
import { createThemePanel, ELEMENT_KEYS } from '../../netviz/static/js/theme_panel.js';
import { RAMPS } from '../../netviz/static/js/ramp.js';
import { AUTO } from '../../netviz/static/js/elements.js';

// ---------------------------------------------------------------- the DOM --
//
// Same discipline as rules_panel.test.mjs's fake: createElement, classList,
// append/appendChild/replaceChildren, addEventListener/dispatch, never
// innerHTML. Extended with a fake `document.body`, which rules_panel.test.mjs
// never needed -- theme_panel.js toggles `document.body.classList` the same
// way settings_panel.js does, and a DOM fake that omits it would let a panel
// that crashes on a real page pass here anyway, which is exactly the kind of
// gap this project's own notes warn about (a menu that reported itself open
// while absent from the DOM got through a unit suite once).

function fakeDom() {
  function mk(tag) {
    const listeners = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '', value: '',
      title: '', disabled: false, type: '',
      children: [],
      parentNode: null,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
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
  const body = mk('body');
  const document = {
    body,
    createElement: (tag) => mk(tag),
  };
  return { root, body, document };
}

/** Builds the deps createThemePanel needs, wired to two optional callbacks:
 *  `onWrite` sees every patch handed to the LIVE (preview) applier, and
 *  `onAsk` fires whenever the panel puts up a confirmation. The fake
 *  confirmer never answers its own question -- same as a real dialog sitting
 *  on screen until a person clicks something -- so a test that wants the
 *  panel to actually close after asking has to be the one deciding that is
 *  out of scope here (none of the cases below need it: they only check
 *  whether the question was asked and whether the panel is still open). */
function fakeDeps(onWrite = null, onAsk = null) {
  const dom = fakeDom();
  globalThis.document = dom.document;
  return {
    root: dom.root,
    preview: {
      apply(patch) {
        if (onWrite) onWrite(patch);
        return { applied: Object.keys(patch), rejected: [] };
      },
    },
    settings: {
      apply(patch) {
        return { applied: Object.keys(patch), rejected: [] };
      },
    },
    confirmer: {
      ask(q) { if (onAsk) onAsk(q); },
    },
    onLayout: () => {},
  };
}

test('the twelve element keys match the twelve color settings', () => {
  assert.equal(ELEMENT_KEYS.length, 12);
  assert.ok(ELEMENT_KEYS.includes('coastline'));
  assert.ok(ELEMENT_KEYS.includes('auroraHigh'));
});

test('opening the panel writes nothing', () => {
  const writes = [];
  const panel = createThemePanel(fakeDeps((p) => writes.push(p)));
  panel.open();
  assert.deepEqual(writes, [],
    'merely looking at the panel must not capture the live values');
});

test('editing a stop forks the preset to custom and leaves it intact', () => {
  const panel = createThemePanel(fakeDeps());
  panel.open();
  panel.setStop(3, '#ff0088');
  const patch = panel.pendingPatch();
  assert.equal(patch['appearance.theme'], 'custom');
  assert.equal(patch['appearance.customRamp'][3], '#ff0088');
  // The preset itself is untouched -- RAMPS.plasma is a module constant.
  assert.equal(RAMPS.plasma[3], '#9c179e');
});

test('editing a second stop while already custom does not re-fork', () => {
  const panel = createThemePanel(fakeDeps());
  panel.open();
  panel.setStop(3, '#ff0088');
  panel.setStop(7, '#00ffaa');
  const patch = panel.pendingPatch();
  assert.equal(patch['appearance.theme'], 'custom');
  assert.equal(patch['appearance.customRamp'][3], '#ff0088');
  assert.equal(patch['appearance.customRamp'][7], '#00ffaa');
});

test('the header line says, in plain words, how many colors you set', () => {
  const panel = createThemePanel(fakeDeps());
  panel.open();
  assert.equal(panel.headerLine(), 'plasma');
  panel.setElement('atmosphere', '#ff0088');
  assert.equal(panel.headerLine(), 'plasma, 1 set by you');
  panel.setElement('coastline', '#00ff88');
  assert.equal(panel.headerLine(), 'plasma, 2 set by you');
  panel.setElement('coastline', AUTO);
  assert.equal(panel.headerLine(), 'plasma, 1 set by you');
});

test('close with nothing pending does not ask', () => {
  let asked = false;
  const panel = createThemePanel(fakeDeps(null, () => { asked = true; }));
  panel.open();
  panel.requestClose();
  assert.equal(asked, false);
  assert.equal(panel.isOpen(), false);
});

test('close with something pending asks', () => {
  let asked = false;
  const panel = createThemePanel(fakeDeps(null, () => { asked = true; }));
  panel.open();
  panel.setElement('atmosphere', '#ff0088');
  panel.requestClose();
  assert.equal(asked, true);
  assert.equal(panel.isOpen(), true, 'must stay open until the question is answered');
});

test('close() force-closes with no question, even with something pending', () => {
  // The teardown path -- what a verifier or a test calls between cases, with
  // nobody there to answer a dialog.
  let asked = false;
  const panel = createThemePanel(fakeDeps(null, () => { asked = true; }));
  panel.open();
  panel.setElement('atmosphere', '#ff0088');
  panel.close();
  assert.equal(asked, false);
  assert.equal(panel.isOpen(), false);
});

test('chaos marks everything it rolled dirty, so Revert covers the whole roll', () => {
  // Derived from CHAOS_PATHS, not a literal count: Chaos reaches past the
  // twelve element rows into the arc colors, the surface tints and the
  // atmosphere, and a path it can write but Revert cannot restore is a
  // one-way door. Adding to the roller must not silently escape the undo.
  const panel = createThemePanel(fakeDeps());
  panel.open();
  panel.chaos(() => 0.5);
  const pending = panel.pendingPaths();
  assert.equal(pending.length, CHAOS_PATHS.length);
  for (const p of CHAOS_PATHS) {
    assert.ok(pending.includes(p), `${p} was rolled but is not pending`);
  }
});

test('chaos never touches the theme or the custom ramp', () => {
  const panel = createThemePanel(fakeDeps());
  panel.open();
  panel.chaos(() => 0.5);
  const patch = panel.pendingPatch();
  assert.equal('appearance.theme' in patch, false);
  assert.equal('appearance.customRamp' in patch, false);
});

test('setElement back to auto is still a touched row', () => {
  // Touched, not changed -- the same rule the tuning panel's Keep follows.
  // Setting a row back to `auto` and leaving it there is still a decision
  // about this display.
  const panel = createThemePanel(fakeDeps());
  panel.open();
  panel.setElement('cities', AUTO);
  assert.deepEqual(panel.pendingPaths(), ['appearance.colors.cities']);
  assert.equal(panel.pendingPatch()['appearance.colors.cities'], AUTO);
});
