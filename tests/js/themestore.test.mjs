import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_KEY, loadThemes, saveTheme, deleteTheme, themeNames, capturePaths }
  from '../../netviz/static/js/themestore.js';
import { RANDOMIZE_PATHS } from '../../netviz/static/js/randomize_color.js';

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    peek: (k) => map.get(k),
  };
}

const PATCH = { 'appearance.theme': 'custom', 'appearance.colors.cities': '#00ff88' };

test('a missing library is not an error', () => {
  const out = loadThemes(fakeStorage({}));
  assert.deepEqual(out.themes, {});
  assert.equal(out.error, null);
});

test('a corrupt library is reported AND left in place', () => {
  const s = fakeStorage({ [THEME_KEY]: '{not json' });
  const out = loadThemes(s);
  assert.deepEqual(out.themes, {});
  assert.match(out.error, /not JSON/i);
  assert.equal(s.peek(THEME_KEY), '{not json', 'recoverable by hand');
});

test('save and load round-trip', () => {
  const s = fakeStorage({});
  assert.equal(saveTheme(s, 'wall night', PATCH).ok, true);
  assert.deepEqual(loadThemes(s).themes['wall night'], PATCH);
});

test('saving over a name replaces it', () => {
  const s = fakeStorage({});
  saveTheme(s, 'a', PATCH);
  saveTheme(s, 'a', { 'appearance.theme': 'viridis' });
  assert.deepEqual(loadThemes(s).themes.a, { 'appearance.theme': 'viridis' });
});

test('delete removes one name and leaves the rest', () => {
  const s = fakeStorage({});
  saveTheme(s, 'a', PATCH); saveTheme(s, 'b', PATCH);
  deleteTheme(s, 'a');
  assert.deepEqual(themeNames(loadThemes(s).themes), ['b']);
});

test('names sort case-insensitively, so a picker reads alphabetically', () => {
  assert.deepEqual(themeNames({ Zulu: {}, alpha: {}, Bravo: {} }),
                   ['alpha', 'Bravo', 'Zulu']);
});

test('a storage failure degrades rather than throwing', () => {
  const s = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const out = saveTheme(s, 'a', PATCH);
  assert.equal(out.ok, false);
  assert.match(out.error, /quota/);
});

test('a captured theme carries the extras a Randomize can write', () => {
  const captured = capturePaths();
  for (const p of RANDOMIZE_PATHS) {
    assert.ok(captured.includes(p), `${p} must be captured or a saved roll reloads wrong`);
  }
  assert.ok(captured.includes('appearance.theme'));
  assert.ok(captured.includes('appearance.customRamp'));
});
