import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { R_INNER, R_OUTER } from '../../netviz/static/js/auroral_oval.js';

// The shader cannot be run here. What CAN be checked is that the module's
// contract with the rest of the renderer is intact and that the numbers baked
// into the GLSL are the ones auroral_oval.js exports -- the single way those
// two copies of the same arithmetic are known to still agree.
const SRC = await readFile(
  new URL('../../netviz/static/js/aurora.js', import.meta.url), 'utf8');

test('the shell is drawn at the outer aurora altitude, back faces', () => {
  assert.match(SRC, /BackSide/, 'a front-face shell has nothing to march through');
  assert.match(SRC, /radius \* R_OUTER/,
    'the mesh must reach the top of the span the shader marches');
});

test('the planet is clipped arithmetically, never by the depth buffer', () => {
  assert.match(SRC, /depthTest:\s*false/,
    'a back-face shell with depthTest on loses every near-side fragment');
  assert.match(SRC, /planetT|R_PLANET/,
    'depthTest off without a ray clip paints the oval through the Earth');
});

test('the GLSL constants are the module constants, not a second opinion', () => {
  // Interpolated from auroral_oval.js's exports, so the two copies of the same
  // arithmetic cannot drift apart silently.
  assert.match(SRC, /R_INNER\s*=\s*\$\{[^}]*R_INNER[^}]*\}/);
  assert.match(SRC, /R_OUTER\s*=\s*\$\{[^}]*R_OUTER[^}]*\}/);
  assert.ok(R_INNER < R_OUTER);
});

test('curtains are built in the magnetic frame, not on a planar projection', () => {
  assert.doesNotMatch(SRC, /noise\(vec3\(n\.xz/,
    'n.xz collapses at the poles -- which is the only place the oval is drawn');
});

test('the color split runs on altitude, which is the axis it is real on', () => {
  assert.match(SRC, /mix\(lowColor, highColor, smoothstep\([^)]*alt\)/,
    'green at 100km and red at 200km is a HEIGHT split; the old shader faked it '
    + 'across latitude and therefore had nothing to show at the limb');
});

test('the test hook is named so nobody mistakes it for product', () => {
  assert.match(SRC, /__setReading/);
  assert.match(SRC, /TEST HOOK/,
    'a hook that forces a storm has to say out loud that it is one');
});
