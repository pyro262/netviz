import test from 'node:test';
import assert from 'node:assert/strict';

import { menuModel, isDoubleTap, DOUBLE_TAP, createMenu } from '../../netviz/static/js/menu.js';
import { CONFIG } from '../../netviz/static/js/config.js';

const STATE = {
  railOn: false,
  layers: { stars: true, aurora: true, bordersWatched: true, cityLights: true, ripples: true },
  canLookHere: true,
  settingsPanel: false,
};

const byId = (model, id) => {
  for (const item of model) {
    if (item.id === id) return item;
    for (const sub of item.items || []) if (sub.id === id) return sub;
  }
  return null;
};

test('the menu offers the handful of things worth one gesture', () => {
  // Not all 82 settings. A menu that lists everything is a panel with worse
  // ergonomics, and the panel is a later step.
  const ids = menuModel(STATE).map((i) => i.id);
  assert.deepEqual(ids, ['lookHere', 'rail', 'layers', 'settings']);
});

test('a toggle reports the state it is actually in', () => {
  const on = byId(menuModel({ ...STATE, railOn: true }), 'rail');
  const off = byId(menuModel({ ...STATE, railOn: false }), 'rail');
  assert.equal(on.on, true);
  assert.equal(off.on, false);
  assert.equal(on.kind, 'toggle');
});

test('every layer toggle mirrors its layer', () => {
  const state = { ...STATE, layers: { ...STATE.layers, stars: false } };
  assert.equal(byId(menuModel(state), 'layers.stars').on, false);
  assert.equal(byId(menuModel(state), 'layers.aurora').on, true);
});

test('Look here is disabled when the pointer was not on the globe', () => {
  // The globe is much smaller than the viewport -- at 4.6 radii its angular
  // radius is 12.56 deg against a 29.27 deg half-FOV -- so opening the menu
  // over empty sky is the common case, not the edge case.
  const item = byId(menuModel({ ...STATE, canLookHere: false }), 'lookHere');
  assert.equal(item.enabled, false);
});

test('Settings is present but disabled until the panel exists', () => {
  // Shown rather than hidden: it tells you the panel is coming and where it
  // will be. Enabled would be a lie, and hidden would make it undiscoverable.
  const item = byId(menuModel(STATE), 'settings');
  assert.equal(item.enabled, false);
  assert.ok(item.note && item.note.length > 0, 'a disabled item must say why');
  assert.equal(byId(menuModel({ ...STATE, settingsPanel: true }), 'settings').enabled, true);
});

test('nothing in the menu claims a change is saved', () => {
  // Nothing persists until step 2. A menu that says "saved" would be lying,
  // and the lie would only surface on the next reload.
  const words = JSON.stringify(menuModel(STATE)).toLowerCase();
  for (const w of ['save', 'saved', 'persist', 'stored']) {
    assert.ok(!words.includes(w), `the menu says "${w}"`);
  }
});

test('two quick taps in the same place are a double-tap', () => {
  assert.equal(isDoubleTap({ t: 1000, x: 500, y: 400 },
                           { t: 1200, x: 505, y: 402 }, DOUBLE_TAP), true);
});

test('two slow taps are two taps', () => {
  assert.equal(isDoubleTap({ t: 1000, x: 500, y: 400 },
                           { t: 1600, x: 500, y: 400 }, DOUBLE_TAP), false);
});

test('two quick taps far apart are not a double-tap', () => {
  // Someone tapping two different places quickly is not asking for a menu
  // between them.
  assert.equal(isDoubleTap({ t: 1000, x: 200, y: 400 },
                           { t: 1100, x: 600, y: 400 }, DOUBLE_TAP), false);
});

test('the first tap of the session is never a double-tap', () => {
  assert.equal(isDoubleTap(null, { t: 1000, x: 1, y: 1 }, DOUBLE_TAP), false);
});

test('the double-tap window is measured, not guessed', () => {
  // 320ms is inside the platform range for a double click (Windows default is
  // 500, macOS ~500 at the slowest setting, browsers commonly 300-500) and is
  // short enough that two deliberate separate taps do not merge. 24px lets a
  // finger wobble on a wall-mounted screen without losing the gesture.
  assert.equal(DOUBLE_TAP.maxMs, 320);
  assert.equal(DOUBLE_TAP.maxPx, 24);
});

test('a backwards time jump is rejected', () => {
  // Clock jumps or out-of-order events must not be misidentified as double-taps.
  // Same location, but now.t < prev.t by a large margin.
  assert.equal(isDoubleTap({ t: 2000, x: 500, y: 400 },
                           { t: 1000, x: 500, y: 400 }, DOUBLE_TAP), false);
});

test('at boundary: time exactly at maxMs is included', () => {
  // The boundary is inclusive: exactly 320ms apart, same location, is a double-tap.
  assert.equal(isDoubleTap({ t: 1000, x: 500, y: 400 },
                           { t: 1320, x: 500, y: 400 }, DOUBLE_TAP), true);
});

test('at boundary: distance exactly at maxPx is included', () => {
  // The boundary is inclusive: exactly 24px apart, within time window, is a double-tap.
  // 24px on one axis alone satisfies the 2D distance check.
  assert.equal(isDoubleTap({ t: 1000, x: 500, y: 400 },
                           { t: 1200, x: 524, y: 400 }, DOUBLE_TAP), true);
});

test('diagonal distance over the limit is rejected', () => {
  // A diagonal move where both axes are under the limit but 2D distance exceeds it.
  // dx=20, dy=20 → distSq=800 → dist≈28.3px, over the 24px limit.
  // This catches a regression to per-axis checking (which would incorrectly accept it).
  assert.equal(isDoubleTap({ t: 1000, x: 500, y: 400 },
                           { t: 1200, x: 520, y: 420 }, DOUBLE_TAP), false);
});

// ---------------------------------------------------------------- createMenu --
//
// Minimal DOM fake, same pattern as tests/js/rail.test.mjs: createElement,
// classList, append/appendChild/replaceChildren, never innerHTML. Extended
// with addEventListener/removeEventListener and parent links, since the menu
// (unlike the rail) has to find out about outside clicks and remove itself.

function fakeDom() {
  function mk(tag) {
    const listeners = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '',
      dataset: {},
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
      contains(other) {
        let n = other;
        while (n) { if (n === this) return true; n = n.parentNode; }
        return false;
      },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      // Test-only: fire a fake event at this node.
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
  const winListeners = {};
  const window = {
    innerWidth: 1920, innerHeight: 1080,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (winListeners[type]) winListeners[type] = winListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, evt) { (winListeners[type] || []).slice().forEach((fn) => fn(evt)); },
  };
  return { root, document, window };
}

/** Depth-first search for the row this test built, by the item id menu.js
 *  stamps into dataset.id. */
function findByDataId(node, id) {
  if (node.dataset && node.dataset.id === id) return node;
  for (const c of node.children || []) {
    const found = findByDataId(c, id);
    if (found) return found;
  }
  return null;
}

function withFakeGlobals(dom, fn) {
  const realDoc = globalThis.document;
  const realWin = globalThis.window;
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  try {
    return fn();
  } finally {
    globalThis.document = realDoc;
    globalThis.window = realWin;
  }
}

test('open refuses and draws nothing when input.lock is set', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    CONFIG.input.lock = true;
    try {
      const menu = createMenu({
        rig: { pointAt: () => null, visit: () => {} },
        settings: { apply: () => { throw new Error('must not be called'); } },
        root: dom.root,
      });
      const opened = menu.open(10, 10, { x: 0, y: 0 });
      assert.equal(opened, false);
      assert.equal(menu.isOpen(), false);
      assert.equal(dom.root.children.length, 0, 'the menu drew something anyway');
    } finally {
      CONFIG.input.lock = false;
    }
  });
});

test('open draws the menu when input.lock is not set', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    const opened = menu.open(10, 10, { x: 0, y: 0 });
    assert.equal(opened, true);
    assert.equal(menu.isOpen(), true);
    assert.ok(dom.root.children.length > 0, 'nothing was drawn');
  });
});

test('a toggle click applies the schema path with the flipped value, and closes', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const log = [];
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: (patch) => log.push(patch) },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    // 'rail' is the top-level toggle's id, but rail.enabled (default false)
    // is the schema path it actually has to write -- the two are not spelled
    // the same, and that mapping is exactly what this test guards.
    const railRow = findByDataId(dom.root, 'rail');
    assert.ok(railRow, 'no row with data-id=rail');
    railRow.dispatch('click', { target: railRow });
    assert.deepEqual(log, [{ 'rail.enabled': true }]);
    assert.equal(menu.isOpen(), false, 'a successful action must close the menu');
  });
});

test('a layer toggle applies its own id unchanged, since layer ids ARE schema paths', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const log = [];
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: (patch) => log.push(patch) },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    assert.ok(starsRow, 'no row with data-id=layers.stars');
    starsRow.dispatch('click', { target: starsRow });
    // stars defaults true, so the flip is to false.
    assert.deepEqual(log, [{ 'layers.stars': false }]);
  });
});

test('lookHere calls rig.visit with the lat/lon it was opened at, and closes', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const visited = [];
    const menu = createMenu({
      rig: { pointAt: () => ({ lat: 12.5, lon: -45.25 }), visit: (lat, lon) => visited.push([lat, lon]) },
      settings: { apply: () => { throw new Error('must not be called'); } },
      root: dom.root,
    });
    menu.open(20, 20, { x: 0.1, y: -0.05 });
    const row = findByDataId(dom.root, 'lookHere');
    assert.ok(row, 'no row with data-id=lookHere');
    assert.ok(!row.className.includes('disabled'), 'lookHere should be enabled');
    row.dispatch('click', { target: row });
    assert.deepEqual(visited, [[12.5, -45.25]]);
    assert.equal(menu.isOpen(), false);
  });
});

test('lookHere is disabled and inert when the pointer was over empty sky', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const visited = [];
    const menu = createMenu({
      rig: { pointAt: () => null, visit: (lat, lon) => visited.push([lat, lon]) },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(20, 20, { x: 0.9, y: 0.9 });
    const row = findByDataId(dom.root, 'lookHere');
    assert.ok(row.className.includes('disabled'));
    row.dispatch('click', { target: row });   // disabled items get no listener
    assert.equal(visited.length, 0);
    assert.equal(menu.isOpen(), true, 'a click with no listener must not close the menu');
  });
});

test('a click outside the menu closes it', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    assert.equal(menu.isOpen(), true);
    const outsider = dom.document.createElement('div');
    dom.document.dispatch('pointerdown', { target: outsider });
    assert.equal(menu.isOpen(), false);
  });
});

test('esc closes the menu', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    dom.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(menu.isOpen(), false);
  });
});

test('losing focus closes the menu', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    dom.window.dispatch('blur', {});
    assert.equal(menu.isOpen(), false);
  });
});

test('opening again replaces the old menu rather than stacking a second one', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    menu.open(50, 50, { x: 0, y: 0 });
    assert.equal(dom.root.children.length, 1, 'a second open left the first one drawn too');
  });
});

test('close() is idempotent', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, visit: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.close();               // never opened
    menu.open(0, 0, { x: 0, y: 0 });
    menu.close();
    menu.close();                // already closed
    assert.equal(menu.isOpen(), false);
  });
});
