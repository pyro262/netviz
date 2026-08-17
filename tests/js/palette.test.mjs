// Regression test for the white-sky bug: appearance.background shipped
// 'auto' as its CONFIG default (alongside the twelve element colors), and
// BACKGROUND used to hand that literal string straight to THREE.Color, which
// cannot parse it -- it warns and silently leaves the color at its
// constructor default, WHITE, on a wall display. palette.js now resolves
// 'auto' itself before THREE ever sees it.
//
// This file can exist because palette.js resolves 'three' by relative path
// (see palette.js's own header comment) rather than the bare specifier the
// browser's import map provides -- the bare specifier cannot resolve under
// `node --test` in a repo with no node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND } from '../../netviz/static/js/palette.js';
import { THEME_SKIES } from '../../netviz/static/js/ramp.js';

const HEX6 = /^#[0-9a-f]{6}$/i;

test('BACKGROUND is a parseable #rrggbb, never the auto sentinel', () => {
  assert.match(BACKGROUND, HEX6);
  assert.notEqual(BACKGROUND, 'auto');
});

test('BACKGROUND resolves to the plasma sky, the default theme, on a fresh CONFIG', () => {
  // No appearance.theme setting exists yet (that is Task 6's), and CONFIG's
  // appearance.background default is 'auto' -- so this is what every fresh
  // kiosk on this branch actually draws.
  assert.equal(BACKGROUND, THEME_SKIES.plasma);
  assert.equal(BACKGROUND, '#0b0916');
});

test('every theme sky is a parseable #rrggbb', () => {
  for (const [id, hex] of Object.entries(THEME_SKIES)) {
    assert.match(hex, HEX6, `${id} sky`);
  }
});
