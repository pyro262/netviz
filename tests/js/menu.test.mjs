import test from 'node:test';
import assert from 'node:assert/strict';

import { menuModel, isDoubleTap, DOUBLE_TAP } from '../../netviz/static/js/menu.js';

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
