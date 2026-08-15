import test from 'node:test';
import assert from 'node:assert/strict';

import {
  menuModel, isDoubleTap, DOUBLE_TAP, createMenu, firstSentence, schemaTitle,
} from '../../netviz/static/js/menu.js';
import { CONFIG } from '../../netviz/static/js/config.js';
import { entry } from '../../netviz/static/js/settings.js';

const ALL_LAYERS_ON = {
  cityLights: true, coastline: true, bordersWatched: true, bordersWorld: true,
  admin1: true, stars: true, aurora: true, atmosphere: true, ripples: true,
  countryFlash: true, clouds: true, lightning: true,
};

const STATE = {
  railOn: false,
  layers: ALL_LAYERS_ON,
  layersExpanded: false,
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
  assert.deepEqual(ids, ['lookHere', 'rail', 'testMode', 'layers', 'settings']);
});

test('a toggle reports the state it is actually in', () => {
  const on = byId(menuModel({ ...STATE, railOn: true }), 'rail');
  const off = byId(menuModel({ ...STATE, railOn: false }), 'rail');
  assert.equal(on.on, true);
  assert.equal(off.on, false);
  assert.equal(on.kind, 'toggle');
});

test('the Test mode row reflects state.testMode and sits directly above Layers', () => {
  const on = byId(menuModel({ ...STATE, testMode: true }), 'testMode');
  const off = byId(menuModel({ ...STATE, testMode: false }), 'testMode');
  assert.equal(on.on, true);
  assert.equal(off.on, false);
  assert.equal(on.kind, 'toggle');
  const ids = menuModel(STATE).map((i) => i.id);
  assert.equal(ids.indexOf('testMode') + 1, ids.indexOf('layers'),
    'Test mode must sit directly above Layers');
});

test('every layer toggle mirrors its layer', () => {
  const state = { ...STATE, layersExpanded: true, layers: { ...STATE.layers, stars: false } };
  assert.equal(byId(menuModel(state), 'layers.stars').on, false);
  assert.equal(byId(menuModel(state), 'layers.aurora').on, true);
});

test('all twelve layers are present, each toggle id the schema path unchanged', () => {
  const ids = [
    'layers.cityLights', 'layers.coastline', 'layers.bordersWatched', 'layers.bordersWorld',
    'layers.admin1', 'layers.stars', 'layers.aurora', 'layers.atmosphere', 'layers.ripples',
    'layers.countryFlash', 'layers.clouds', 'layers.lightning',
  ];
  const model = menuModel({ ...STATE, layersExpanded: true });
  for (const id of ids) {
    const item = byId(model, id);
    assert.ok(item, `missing layer row ${id}`);
    assert.equal(item.kind, 'toggle');
    assert.equal(item.on, STATE.layers[id.slice('layers.'.length)]);
  }
});

test('layers group headers are present, labeled and grouped in order, and are not toggles', () => {
  const model = menuModel({ ...STATE, layersExpanded: true });
  const layers = model.find((i) => i.id === 'layers');
  const groups = layers.items.filter((i) => i.kind === 'group').map((i) => i.label);
  assert.deepEqual(groups, ['SKY', 'WEATHER', 'MAP', 'EVENTS']);
  for (const g of layers.items.filter((i) => i.kind === 'group')) {
    assert.equal(g.on, undefined, `group header ${g.label} looks like a toggle`);
    assert.equal(g.enabled, undefined, `group header ${g.label} looks clickable`);
  }
  // A group's rows immediately follow its header, in the order given for
  // this task.
  const ids = layers.items.map((i) => i.id);
  const idx = (id) => ids.indexOf(id);
  assert.ok(idx('layers-group-sky') < idx('layers.stars'));
  assert.ok(idx('layers.stars') < idx('layers.aurora'));
  assert.ok(idx('layers.aurora') < idx('layers.atmosphere'));
  assert.ok(idx('layers.atmosphere') < idx('layers-group-weather'));
  assert.ok(idx('layers-group-weather') < idx('layers.clouds'));
  assert.ok(idx('layers.clouds') < idx('layers.lightning'));
  assert.ok(idx('layers.lightning') < idx('layers-group-map'));
  assert.ok(idx('layers-group-map') < idx('layers.coastline'));
  assert.ok(idx('layers.coastline') < idx('layers.bordersWatched'));
  assert.ok(idx('layers.bordersWatched') < idx('layers.bordersWorld'));
  assert.ok(idx('layers.bordersWorld') < idx('layers.admin1'));
  assert.ok(idx('layers.admin1') < idx('layers.cityLights'));
  assert.ok(idx('layers.cityLights') < idx('layers-group-events'));
  assert.ok(idx('layers-group-events') < idx('layers.ripples'));
  assert.ok(idx('layers.ripples') < idx('layers.countryFlash'));
});

test('the Layers submenu starts collapsed and carries no child items', () => {
  const layers = menuModel(STATE).find((i) => i.id === 'layers');
  assert.equal(layers.expanded, false);
  assert.deepEqual(layers.items, []);
});

test('expanded, the Layers submenu carries exactly sixteen items: four group headers and twelve toggles', () => {
  const layers = menuModel({ ...STATE, layersExpanded: true }).find((i) => i.id === 'layers');
  assert.equal(layers.items.length, 16);
  assert.equal(layers.items.filter((i) => i.kind === 'group').length, 4);
  assert.equal(layers.items.filter((i) => i.kind === 'toggle').length, 12);
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

test('the menu offers the rules editor', () => {
  const ids = menuModel({ ...STATE, rulesPanel: true }).map((i) => i.id);
  assert.ok(ids.includes('rules'));
});

test('the rules editor is absent, not disabled, when input is locked', () => {
  // On a public display the rules are configuration, and the lock exists to
  // say configuring is not on offer. A greyed-out row advertises a control
  // nobody can use.
  const ids = menuModel({ ...STATE, rulesPanel: false }).map((i) => i.id);
  assert.equal(ids.includes('rules'), false);
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
    const attrs = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '',
      children: [],
      parentNode: null,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      setAttribute(name, value) { attrs[name] = String(value); },
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
    // `dataset` is a getter with no setter on a real HTMLElement -- writing
    // to it, or replacing it, throws in strict mode. A fake that instead
    // handed back a plain writable `{}` let a real bug through Task 2's
    // suite: `row.dataset = row.dataset || {}; row.dataset.id = item.id`
    // passed here and would have thrown on an actual page, leaving the menu
    // built but never appended while isOpen() still reported true. This
    // getter-only definition reproduces the real failure so the same class
    // of bug fails loudly in `node --test` instead of silently on the wall.
    Object.defineProperty(node, 'dataset', {
      get() { return {}; },
      enumerable: true,
    });
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
  return { root, document, window, docListeners, winListeners };
}

/** Total handler count across every event type currently registered,
 *  regardless of type name -- so a leak in any listener the menu adds to
 *  document/window (pointerdown, keydown, blur, ...) fails this the same
 *  way. */
function listenerCount(listeners) {
  return Object.values(listeners).reduce((n, fns) => n + fns.length, 0);
}

/** Depth-first search for the row this test built, by the `data-id`
 *  attribute menu.js stamps with setAttribute (not dataset -- see the fake's
 *  getter-only `dataset` above for why). */
function findByDataId(node, id) {
  if (node.getAttribute && node.getAttribute('data-id') === id) return node;
  for (const c of node.children || []) {
    const found = findByDataId(c, id);
    if (found) return found;
  }
  return null;
}

// `async` so a caller whose body needs to `await` (the hover-preview tests
// below, which wait out a real setTimeout) keeps the fake document/window
// installed across those awaits -- `fn()` is awaited before the `finally`
// restores the real globals, rather than restoring them the instant a
// still-pending promise is returned. A synchronous caller is unaffected: its
// body -- assertions included -- runs to completion before this function
// ever reaches its own `await`, exactly as it did when this was synchronous.
async function withFakeGlobals(dom, fn) {
  const realDoc = globalThis.document;
  const realWin = globalThis.window;
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  try {
    return await fn();
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
        rig: { pointAt: () => null, lookHere: () => {} },
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
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    const opened = menu.open(10, 10, { x: 0, y: 0 });
    assert.equal(opened, true);
    assert.equal(menu.isOpen(), true);
    assert.ok(dom.root.children.length > 0, 'nothing was drawn');
  });
});

test('a menu built with no rulesPanel draws no Color rules row', () => {
  // createMenu({ rulesPanel }) is optional -- some callers (this test suite
  // included, until this fix) build a menu without one. `open()` used to
  // hardcode `rulesPanel: true` into the state it hands menuModel, so that
  // menu drew a row whose click handler (`if (item.id === 'rules' &&
  // rulesPanel) rulesPanel.open()`) was permanently guarded out -- a
  // control that is drawn but can never do anything.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
      // rulesPanel intentionally omitted
    });
    menu.open(10, 10, { x: 0, y: 0 });
    function find(node) {
      if (node.getAttribute && node.getAttribute('data-id') === 'rules') return node;
      for (const c of node.children || []) { const r = find(c); if (r) return r; }
      return null;
    }
    assert.equal(find(dom.root), null, 'a "rules" row was drawn with no panel to open');
  });
});

test('the reset row is drawn only when there is a handler behind it', () => {
  assert.equal(byId(menuModel({ ...STATE, canReset: false }), 'reset'), null);
  const row = byId(menuModel({ ...STATE, canReset: true }), 'reset');
  assert.ok(row, 'no reset row with a handler present');
  assert.equal(row.label, 'Reset to netviz defaults');
  assert.equal(row.enabled, true);
});

test('clicking reset calls the handler and closes the menu', () => {
  // The handler is main.js's, and what it does -- keep arcs.rules, drop the
  // rest, reload -- is proved by rulestore's own tests and by
  // verify_rules_editor case 6. What belongs here is only that the row is
  // wired to it at all, which is the failure mode a menu row has.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    let calls = 0;
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      onReset: () => { calls += 1; },
      root: dom.root,
    });
    menu.open(10, 10, { x: 0, y: 0 });
    function find(node) {
      if (node.getAttribute && node.getAttribute('data-id') === 'reset') return node;
      for (const c of node.children || []) { const r = find(c); if (r) return r; }
      return null;
    }
    const row = find(dom.root);
    assert.ok(row, 'no reset row drawn');
    row.dispatch('click', { target: row });
    assert.equal(calls, 1);
    assert.equal(menu.isOpen(), false, 'the menu stayed open over its own action');
  });
});

test('the settings row opens the panel it was built with', () => {
  // Same pattern as "clicking reset calls the handler and closes the menu"
  // above: a menu built with a real settingsPanel, find the row by data-id,
  // dispatch a click on the fake, assert the panel's own open() ran.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const opened = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      settingsPanel: { open: () => opened.push(true), isOpen: () => false },
      root: dom.root,
    });
    menu.open(10, 10, { x: 0, y: 0 });
    function find(node) {
      if (node.getAttribute && node.getAttribute('data-id') === 'settings') return node;
      for (const c of node.children || []) { const r = find(c); if (r) return r; }
      return null;
    }
    const row = find(dom.root);
    assert.ok(row, 'no settings row drawn');
    row.dispatch('click', { target: row });
    assert.deepEqual(opened, [true]);
    assert.equal(menu.isOpen(), false, 'the menu stayed open over its own action');
  });
});

test('open draws exactly the rows menuModel describes, not just SOMETHING', () => {
  // children.length > 0 alone would pass against a menu that appended one
  // empty div and nothing else -- this walks the actual tree and checks the
  // rendered id set (top level plus the always-expanded Layers submenu)
  // against menuModel's own output for the equivalent state.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    // A rulesPanel IS supplied here -- createMenu draws the "Color rules"
    // row only when it has one (state.rulesPanel is `!!rulesPanel`, not a
    // hardcoded true), or a menu built without a panel would draw a row
    // whose click handler is guarded out and does nothing.
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      rulesPanel: { open: () => {}, isOpen: () => false },
      root: dom.root,
    });
    menu.open(10, 10, { x: 0, y: 0 });

    function collectIds(node, out) {
      if (node.getAttribute && node.getAttribute('data-id')) out.push(node.getAttribute('data-id'));
      for (const c of node.children || []) collectIds(c, out);
      return out;
    }
    const rendered = collectIds(dom.root, []).sort();

    // The state createMenu.open() builds when pointAt() returns null and
    // rail/layers are at their config.js defaults -- menuModel is pure, so
    // this expected set is derived the same way the page derives it.
    const expectedState = {
      railOn: false,
      layers: ALL_LAYERS_ON,
      // layersExpanded omitted -- collapsed is the real default too, and
      // menuModel's own `!!state.layersExpanded` treats undefined as false.
      canLookHere: false,
      settingsPanel: false,
      rulesPanel: true,
    };
    const expected = [];
    for (const item of menuModel(expectedState)) {
      expected.push(item.id);
      for (const sub of item.items || []) expected.push(sub.id);
    }
    assert.deepEqual(rendered, expected.sort());
  });
});

test('a toggle click applies the schema path with the flipped value, and closes', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const log = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
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
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (patch) => log.push(patch) },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    // Layers starts collapsed -- expand it first, the same click a real
    // operator makes, before the toggle row exists to click.
    const layersHeader = findByDataId(dom.root, 'layers');
    assert.ok(layersHeader, 'no row with data-id=layers');
    layersHeader.dispatch('click', { target: layersHeader });
    assert.equal(menu.isOpen(), true, 'expanding Layers must not close the menu');
    const starsRow = findByDataId(dom.root, 'layers.stars');
    assert.ok(starsRow, 'no row with data-id=layers.stars');
    starsRow.dispatch('click', { target: starsRow });
    // stars defaults true, so the flip is to false.
    assert.deepEqual(log, [{ 'layers.stars': false }]);
    assert.equal(menu.isOpen(), false, 'a successful toggle must close the menu');
  });
});

/** The mark lives in a child `<span>`, not on the header row's own
 *  textContent -- the row also carries the "Layers" label span, so
 *  concatenated textContent would read "Layers▸" and a substring check on
 *  that is fragile against unrelated label wording. Find the mark span by
 *  its class instead, the same way production CSS finds it. */
function markOf(headerRow) {
  return (headerRow.children || []).find((c) => c.className === 'menu-expand-mark');
}

test('clicking the Layers header expands it in place without closing the menu, and the marker flips', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => { throw new Error('must not be called'); } },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    assert.equal(findByDataId(dom.root, 'layers.stars'), null, 'started expanded');
    assert.equal(markOf(findByDataId(dom.root, 'layers')).textContent, '▸');

    // Each assertion below re-finds the header from the current tree rather
    // than reusing the reference from before the click: the click handler
    // rebuilds the menu's DOM (see toggleLayersExpand in menu.js), so the
    // pre-click node is now a detached, stale copy that would never show the
    // new marker no matter what the click actually did.
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    assert.equal(menu.isOpen(), true, 'expanding the header closed the menu');
    assert.ok(findByDataId(dom.root, 'layers.stars'), 'expanding drew no toggles');
    assert.equal(markOf(findByDataId(dom.root, 'layers')).textContent, '▾');

    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    assert.equal(menu.isOpen(), true, 'collapsing the header closed the menu');
    assert.equal(findByDataId(dom.root, 'layers.stars'), null, 'collapsing left toggles drawn');
    assert.equal(markOf(findByDataId(dom.root, 'layers')).textContent, '▸');
  });
});

test('Layers is collapsed again on every fresh open of the menu', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const header = findByDataId(dom.root, 'layers');
    header.dispatch('click', { target: header });
    assert.ok(findByDataId(dom.root, 'layers.stars'), 'did not expand');
    menu.close();
    menu.open(0, 0, { x: 0, y: 0 });
    // Expansion was remembered for the life of the page when the submenu
    // first shipped. On the wall that meant the menu opened twelve rows tall
    // for the rest of the session after one visit to Layers, so it is reset
    // per open: one click for the person who wants layers, nothing for
    // everybody else.
    assert.equal(findByDataId(dom.root, 'layers.stars'), null,
      'Layers reopened already expanded -- it must start collapsed on every open');
    // Still expandable after the reset, rather than stuck shut.
    const reopened = findByDataId(dom.root, 'layers');
    reopened.dispatch('click', { target: reopened });
    assert.ok(findByDataId(dom.root, 'layers.stars'), 'could not expand after the reset');
  });
});

test('clicking a rendered group header does nothing: no apply, no expansion change, menu stays open', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const log = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (patch) => log.push(patch) },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    assert.ok(findByDataId(dom.root, 'layers.stars'), 'did not expand for the header lookup below');

    const skyHeader = findByDataId(dom.root, 'layers-group-sky');
    assert.ok(skyHeader, 'no row with data-id=layers-group-sky');

    skyHeader.dispatch('click', { target: skyHeader });

    assert.deepEqual(log, [], 'a group header must never call settings.apply');
    assert.ok(findByDataId(dom.root, 'layers.stars'),
      'the Layers submenu must stay expanded -- a header click is not a collapse');
    assert.equal(menu.isOpen(), true, 'a group header click must not close the menu');
  });
});

test('lookHere calls rig.lookHere (NOT rig.visit) with the lat/lon it was opened at, and closes', () => {
  // rig.lookHere, specifically -- not rig.visit, which is the automatic
  // block-burst detour's own path and must never override a held view (see
  // camera.js's comment on why the two cannot share a method). A menu whose
  // rig fake happened to expose both would not catch a regression back to
  // calling visit(); this fake only implements lookHere, so a regression
  // throws here instead of silently passing.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const visited = [];
    const menu = createMenu({
      rig: { pointAt: () => ({ lat: 12.5, lon: -45.25 }), lookHere: (lat, lon) => visited.push([lat, lon]) },
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
      rig: { pointAt: () => null, lookHere: (lat, lon) => visited.push([lat, lon]) },
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
      rig: { pointAt: () => null, lookHere: () => {} },
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
      rig: { pointAt: () => null, lookHere: () => {} },
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
      rig: { pointAt: () => null, lookHere: () => {} },
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
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    menu.open(50, 50, { x: 0, y: 0 });
    assert.equal(dom.root.children.length, 1, 'a second open left the first one drawn too');
  });
});

test('an open/close cycle leaves no listener behind on document or window', () => {
  // The fake already tracks docListeners/winListeners; nothing previously
  // asserted they end up empty. A leaked outside-click or blur listener
  // would still work by accident on a single menu, but pile up handler by
  // handler across many open/close cycles on a kiosk that never reloads.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    assert.equal(listenerCount(dom.docListeners), 0, 'listener present before any open');
    assert.equal(listenerCount(dom.winListeners), 0, 'listener present before any open');
    menu.open(0, 0, { x: 0, y: 0 });
    assert.ok(listenerCount(dom.docListeners) > 0, 'open registered nothing on document');
    assert.ok(listenerCount(dom.winListeners) > 0, 'open registered nothing on window');
    menu.close();
    assert.equal(listenerCount(dom.docListeners), 0, 'close left a document listener behind');
    assert.equal(listenerCount(dom.winListeners), 0, 'close left a window listener behind');
  });
});

test('close() is idempotent', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
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

test('dismissedBy names the exact event that closed the menu', () => {
  // The menu listens on `document` in the CAPTURE phase; input.js listens on
  // the canvas in the bubble phase. So by the time input.js sees the very
  // pointerdown that dismissed the menu, the menu has ALREADY closed and
  // isOpen() is false -- a dismissal is indistinguishable from an ordinary
  // press on the globe if you only ask "is the menu open".
  //
  // That mattered: input.js grabbed the camera on the dismissing click, and
  // a grab is "a drag's own claim", which resets the hand-back delay from the
  // menu's 2s to a drag's 15s. Closing the menu with a click therefore left
  // the walk parked for 15 seconds. Identity of the event is what
  // distinguishes the two, since no timing heuristic can.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const outsider = dom.document.createElement('div');
    const ev = { target: outsider };
    dom.document.dispatch('pointerdown', ev);
    assert.equal(menu.isOpen(), false);
    assert.equal(menu.dismissedBy(ev), true, 'the dismissing event');
    assert.equal(menu.dismissedBy({ target: outsider }), false,
                 'a different event object that merely looks the same');
    assert.equal(menu.dismissedBy(null), false);
    assert.equal(menu.dismissedBy(undefined), false);
  });
});

test('a fresh open forgets the previous dismissal', () => {
  // Otherwise the event that closed the menu last time would still suppress a
  // grab the next time somebody presses on the globe -- a dead camera, and a
  // retained reference to a DOM event for as long as the page runs.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const outsider = dom.document.createElement('div');
    const ev = { target: outsider };
    dom.document.dispatch('pointerdown', ev);
    assert.equal(menu.dismissedBy(ev), true);
    menu.open(0, 0, { x: 0, y: 0 });
    assert.equal(menu.dismissedBy(ev), false, 'stale after a re-open');
  });
});


// -------------------------------------------------------- test mode hover --
//
// "there should be a 'test mode' where options we're highlighting with our
// mouse such as lightning will propagate so we can see how they look."
// Hovering a layer row previews it through the RAW `preview` applier --
// never `settings`, which persists -- after a short delay, and reverts to
// whatever was actually live before the hover on mouseleave or on any close
// route. `hoverDelayMs` is injected small here so these tests do not
// actually sleep 150ms apiece.

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every test below flips CONFIG.menu.testMode for the duration of one
 *  check; this restores it no matter how the body exits, the same discipline
 *  the input.lock test above uses. CONFIG is a shared module-level singleton
 *  and this file's tests run in one process, in order. */
async function withTestMode(on, fn) {
  CONFIG.menu.testMode = on;
  try {
    await fn();
  } finally {
    CONFIG.menu.testMode = false;
  }
}

test('with test mode OFF, hovering a layer row applies nothing', async () => {
  const dom = fakeDom();
  await withTestMode(false, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const settingsLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (p) => settingsLog.push(p) },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [], 'a hover applied something with test mode off');
    assert.deepEqual(settingsLog, [], 'a hover must never touch the persisting applier');
  }));
});

test('with test mode ON, hovering a layer row applies the flipped value through preview, not settings', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const settingsLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (p) => settingsLog.push(p) },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    // Nothing yet -- the delay has not elapsed.
    assert.deepEqual(previewLog, []);
    await sleep(20);
    // stars defaults true, so the previewed value is the flip: false.
    assert.deepEqual(previewLog, [{ 'layers.stars': false }]);
    assert.deepEqual(settingsLog, [], 'the preview must never reach the persisting applier');
  }));
});

test('leaving a previewed row reverts it to the value that was live before the hover', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [{ 'layers.stars': false }]);
    starsRow.dispatch('mouseleave', {});
    assert.deepEqual(previewLog, [{ 'layers.stars': false }, { 'layers.stars': true }],
      'leaving must revert to the value that was actually live, not the config default');
  }));
});

test('leaving a row before the delay elapses cancels the preview -- it never applied', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 30,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    starsRow.dispatch('mouseleave', {});
    await sleep(50);
    assert.deepEqual(previewLog, [], 'the delayed apply fired anyway after a quick pass-through');
  }));
});

test('closing the menu while a preview is live reverts it', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [{ 'layers.stars': false }]);
    menu.close();
    assert.deepEqual(previewLog, [{ 'layers.stars': false }, { 'layers.stars': true }],
      'the menu closed with a preview still live and nothing put it back');
  }));
});

test('clicking a previewed row commits through settings, not preview, and the close-revert does not undo it', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const settingsLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (p) => settingsLog.push(p) },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [{ 'layers.stars': false }]);
    starsRow.dispatch('click', { target: starsRow });
    assert.deepEqual(settingsLog, [{ 'layers.stars': false }], 'the click must commit through the persisting applier');
    // act()'s own close() runs synchronously inside the click dispatch above,
    // so by now any revert it might have fired has already happened -- and it
    // must not have, or the committed value has been silently erased.
    assert.deepEqual(previewLog, [{ 'layers.stars': false }],
      'a revert fired after the commit and undid it');
    assert.equal(menu.isOpen(), false);
  }));
});

test('moving from one layer row to another reverts the first before previewing the second', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    const auroraRow = findByDataId(dom.root, 'layers.aurora');
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [{ 'layers.stars': false }]);
    // No mouseleave on starsRow -- moving straight to a sibling must still
    // revert the first on its own.
    auroraRow.dispatch('mouseenter', {});
    assert.deepEqual(previewLog, [{ 'layers.stars': false }, { 'layers.stars': true }],
      'entering a second row did not revert the first');
    await sleep(20);
    assert.deepEqual(previewLog, [
      { 'layers.stars': false }, { 'layers.stars': true }, { 'layers.aurora': false },
    ]);
  }));
});

test('the rail toggle does not preview on hover, even with test mode on', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const previewLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      preview: { apply: (p) => previewLog.push(p) },
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const railRow = findByDataId(dom.root, 'rail');
    railRow.dispatch('mouseenter', {});
    await sleep(20);
    assert.deepEqual(previewLog, [],
      'the rail toggle previewed on hover -- it resizes the renderer and must not');
  }));
});

test('a menu built with no `preview` option attaches no hover listeners and behaves as before', async () => {
  const dom = fakeDom();
  await withTestMode(true, () => withFakeGlobals(dom, async () => {
    const settingsLog = [];
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: (p) => settingsLog.push(p) },
      // preview intentionally omitted
      root: dom.root,
      hoverDelayMs: 5,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    findByDataId(dom.root, 'layers').dispatch('click', { target: findByDataId(dom.root, 'layers') });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    // Must not throw for lack of a preview applier, and must apply nothing.
    starsRow.dispatch('mouseenter', {});
    await sleep(20);
    starsRow.dispatch('mouseleave', {});
    assert.deepEqual(settingsLog, []);
  }));
});

// ------------------------------------------------------------ hover text --
//
// The menu was the one surface with no hover description at all -- the
// tuning panel (`settings_panel.js`) sets `row.title = spec.help` and
// `rules_panel.js` does the same, so a person could change a color rule or a
// bloom setting and read why, but flipping a layer here or resetting the
// display had nothing. This closes that gap with the SAME native-tooltip
// mechanism (`row.title`), not a bespoke styled one.

test('firstSentence: real schema strings with a decimal or an abbreviation-like period are not split early', () => {
  // "magnitude 6.5" -- the period is followed by a digit, not whitespace.
  assert.equal(
    firstSentence(entry('layers.stars').help),
    entry('layers.stars').help,
    'a decimal point split the sentence early',
  );
  // "1px crisp" -- no sentence break to find at all; the coastline help is
  // one sentence with no internal period, so the whole string comes back.
  assert.equal(
    firstSentence(entry('layers.coastline').help),
    entry('layers.coastline').help,
  );
  // "rules.js puts" -- the period in a filename is followed by a letter, not
  // whitespace, so it must not read as a sentence end either.
  assert.ok(entry('arcs.flow.gain').help.includes('rules.js puts'),
    'the fixture text this case depends on changed underneath it');
  assert.ok(
    !firstSentence(entry('arcs.flow.gain').help).includes('below it the class is black'),
    'the sentence after "rules.js puts" leaked into the first sentence',
  );
});

test('firstSentence: text with no terminal period comes back unchanged', () => {
  assert.equal(firstSentence('no period at all'), 'no period at all');
});

test('firstSentence: text that is already exactly one sentence comes back unchanged', () => {
  const one = 'Strike color is cold white-blue on purpose.';
  assert.equal(firstSentence(one), one);
});

test('firstSentence: a multi-sentence string is cut at the first period-plus-whitespace', () => {
  assert.equal(
    firstSentence('First bit. Second bit. Third bit.'),
    'First bit.',
  );
});

test('schemaTitle: a path with no schema entry gets no title, not undefined-as-a-string or empty', () => {
  assert.equal(schemaTitle('layers.doesNotExist'), undefined);
  assert.equal(schemaTitle('not.a.real.path.at.all'), undefined);
});

test('schemaTitle: every one of the fourteen schema-backed menu rows has a schema help string', () => {
  // If any of these ever lost its `help` in settings.js, this menu row would
  // silently go tooltip-less -- catch that here rather than on the wall.
  const paths = [
    'rail.enabled', 'menu.testMode',
    'layers.cityLights', 'layers.coastline', 'layers.bordersWatched',
    'layers.bordersWorld', 'layers.admin1', 'layers.stars', 'layers.aurora',
    'layers.atmosphere', 'layers.ripples', 'layers.countryFlash',
    'layers.clouds', 'layers.lightning',
  ];
  assert.equal(paths.length, 14);
  for (const path of paths) {
    const e = entry(path);
    assert.ok(e, `no schema entry for ${path}`);
    assert.ok(e.help && e.help.length > 0, `${path} has no help text`);
    assert.equal(schemaTitle(path), firstSentence(e.help),
      `${path}'s menu title is not derived from its schema help`);
  }
});

test('every layer toggle row carries a title matching the first sentence of its schema help', () => {
  const model = menuModel({ ...STATE, layersExpanded: true });
  const layerKeys = [
    'cityLights', 'coastline', 'bordersWatched', 'bordersWorld', 'admin1',
    'stars', 'aurora', 'atmosphere', 'ripples', 'countryFlash', 'clouds', 'lightning',
  ];
  for (const key of layerKeys) {
    const path = `layers.${key}`;
    const item = byId(model, path);
    assert.ok(item, `no menu row for ${path}`);
    assert.ok(item.title, `${path} row has no title`);
    assert.equal(item.title, firstSentence(entry(path).help));
  }
});

test('the rail and Test mode rows carry a title from their own schema paths', () => {
  const model = menuModel(STATE);
  const rail = byId(model, 'rail');
  const testMode = byId(model, 'testMode');
  assert.ok(rail.title, 'rail row has no title');
  assert.equal(rail.title, firstSentence(entry('rail.enabled').help));
  assert.ok(testMode.title, 'testMode row has no title');
  assert.equal(testMode.title, firstSentence(entry('menu.testMode').help));
});

test('every action row -- Look here, Color rules, Settings, Reset -- has a hand-written one-sentence title', () => {
  const model = menuModel({ ...STATE, rulesPanel: true, canReset: true });
  for (const id of ['lookHere', 'rules', 'settings', 'reset']) {
    const item = byId(model, id);
    assert.ok(item, `no row for ${id}`);
    assert.ok(item.title && item.title.length > 0, `${id} row has no title`);
  }
});

test('the reset row title says the color rules are kept -- the exact misreading its label was changed to avoid', () => {
  const item = byId(menuModel({ ...STATE, canReset: true }), 'reset');
  assert.match(item.title, /color rules.*kept/i);
});

test('group headers (SKY/WEATHER/MAP/EVENTS) carry no title -- they are labels, not controls', () => {
  const model = menuModel({ ...STATE, layersExpanded: true });
  const layers = model.find((i) => i.id === 'layers');
  const groups = layers.items.filter((i) => i.kind === 'group');
  assert.equal(groups.length, 4, 'expected the four group headers');
  for (const g of groups) {
    assert.ok(!('title' in g) || g.title === undefined, `${g.label} group header was given a title`);
  }
});

test('a rendered layer row really carries its title as a DOM attribute, not just on the model', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const layersHeader = findByDataId(dom.root, 'layers');
    layersHeader.dispatch('click', { target: layersHeader });
    const starsRow = findByDataId(dom.root, 'layers.stars');
    assert.ok(starsRow, 'no row with data-id=layers.stars');
    assert.equal(starsRow.title, firstSentence(entry('layers.stars').help));
  });
});

test('a rendered group header carries no title as a DOM attribute either', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const menu = createMenu({
      rig: { pointAt: () => null, lookHere: () => {} },
      settings: { apply: () => {} },
      root: dom.root,
    });
    menu.open(0, 0, { x: 0, y: 0 });
    const layersHeader = findByDataId(dom.root, 'layers');
    layersHeader.dispatch('click', { target: layersHeader });
    const skyHeader = findByDataId(dom.root, 'layers-group-sky');
    assert.ok(skyHeader, 'no SKY group header rendered');
    assert.equal(skyHeader.title, undefined, 'a group header was given a title');
  });
});
