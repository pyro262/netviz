import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA, paths, entry, defaultOf, coerce, validate, planApply, settingLabel,
  relativeLuminance,
} from '../../netviz/static/js/settings.js';
import { cfg } from '../../netviz/static/js/config.js';
import { withPersistence } from '../../netviz/static/js/rulestore.js';

test('every declared path exists in config.js', () => {
  // The schema is a description of config.js, not a second copy of it. A path
  // that resolves to undefined is a typo, and it would surface later as a
  // control whose default is blank.
  const missing = paths().filter((p) => cfg(p, undefined) === undefined);
  assert.deepEqual(missing, [], `paths not in config.js: ${missing.join(', ')}`);
});

test('every entry declares a type, a strategy and help text', () => {
  const TYPES = ['bool', 'int', 'number', 'enum', 'color', 'list', 'rules'];
  const STRATS = ['uniform', 'rebuild', 'relayout'];
  for (const p of paths()) {
    const e = entry(p);
    assert.ok(TYPES.includes(e.type), `${p}: bad type ${e.type}`);
    assert.ok(STRATS.includes(e.strategy), `${p}: bad strategy ${e.strategy}`);
    assert.ok(typeof e.help === 'string' && e.help.length > 10,
      `${p}: help text is missing or too short to be help`);
  }
});

test('every number declares both bounds', () => {
  // An unbounded number is how a display becomes unreadable: see spec 6.2.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'number' && e.type !== 'int') continue;
    assert.equal(typeof e.min, 'number', `${p}: no min`);
    assert.equal(typeof e.max, 'number', `${p}: no max`);
    assert.ok(e.min < e.max, `${p}: min ${e.min} is not below max ${e.max}`);
  }
});

test('the shipped default is inside its own bounds', () => {
  // Catches a bound written from memory rather than from the file.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'number' && e.type !== 'int') continue;
    const d = defaultOf(p);
    assert.ok(d >= e.min && d <= e.max,
      `${p}: shipped default ${d} is outside ${e.min}..${e.max}`);
  }
});

test('every list declares the type of its elements', () => {
  // "Is it an array" is not validation. dnsPorts: ["53"] is a perfectly good
  // array that then never matches anything, because isDnsPort tests numbers --
  // DNS quietly stops being filtered with nothing reporting a problem.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'list') continue;
    assert.ok(['number', 'string', 'boolean'].includes(e.of), `${p}: no 'of'`);
  }
});

test('coerce rejects a list whose elements are the wrong type', () => {
  assert.deepEqual(coerce('traffic.dnsPorts', [53, 853]), { ok: true, value: [53, 853] });
  assert.deepEqual(coerce('traffic.dnsPorts', []), { ok: true, value: [] });
  const bad = coerce('traffic.dnsPorts', [53, '853']);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /element 1 is string, not number/);
  // And the mirror case: an address list is strings, so a bare number is wrong.
  assert.equal(coerce('traffic.resolvers', ['1.1.1.1']).ok, true);
  assert.equal(coerce('traffic.resolvers', [1]).ok, false);
});

test('defaultOf reads config.js rather than a copy', () => {
  assert.equal(defaultOf('traffic.flowsPerSecond'), cfg('traffic.flowsPerSecond'));
  assert.equal(defaultOf('rail.enabled'), cfg('rail.enabled'));
});

test('coerce clamps a number into its bounds instead of refusing it', () => {
  // A slider dragged to the end and a hand-edited file are the same input here.
  // Clamping keeps a working display; refusing leaves the old value with no
  // feedback, which reads as a broken control.
  assert.deepEqual(coerce('traffic.flowsPerSecond', 500), { ok: true, value: 60 });
  assert.deepEqual(coerce('traffic.flowsPerSecond', 0), { ok: true, value: 1 });
  assert.deepEqual(coerce('traffic.flowsPerSecond', 20), { ok: true, value: 20 });
});

test('coerce rounds an int and keeps a number', () => {
  assert.deepEqual(coerce('traffic.flowsPerSecond', 12.7), { ok: true, value: 13 });
  assert.deepEqual(coerce('arcs.bodyOpacity', 0.235), { ok: true, value: 0.235 });
});

test('coerce rejects the wrong shape rather than guessing', () => {
  assert.equal(coerce('traffic.flowsPerSecond', 'lots').ok, false);
  assert.equal(coerce('traffic.flowsPerSecond', NaN).ok, false);
  assert.equal(coerce('rail.enabled', 'yes').ok, false);
  assert.equal(coerce('appearance.background', 'not-a-color').ok, false);
  assert.equal(coerce('nonsense.path', 1).ok, false);
});

test('coerce accepts a color in the form the renderer uses', () => {
  assert.deepEqual(coerce('appearance.background', '#0b0916'),
                   { ok: true, value: '#0b0916' });
  assert.deepEqual(coerce('appearance.background', '#000'),
                   { ok: true, value: '#000' });
  // Uppercase letters are preserved, not normalized to lowercase. The shipped
  // ground in uppercase is under the cap at luminance 0.0032.
  assert.deepEqual(coerce('appearance.background', '#0B0916'),
                   { ok: true, value: '#0B0916' });
});

test('validate splits a mixed patch and never throws', () => {
  const out = validate({
    'traffic.flowsPerSecond': 999,      // clamped
    'rail.enabled': true,               // fine
    'rail.enabled.deeper': true,        // unknown
    'arcs.bodyOpacity': 'thick',        // wrong type
  });
  assert.equal(out.accepted['traffic.flowsPerSecond'], 60);
  assert.equal(out.accepted['rail.enabled'], true);
  assert.equal(Object.keys(out.accepted).length, 2);
  assert.deepEqual(out.rejected.map((r) => r.path).sort(),
                   ['arcs.bodyOpacity', 'rail.enabled.deeper']);
  for (const r of out.rejected) assert.ok(r.why.length > 0, 'a rejection needs a reason');
});

test('planApply groups a patch by strategy', () => {
  const plan = planApply({
    'arcs.bodyOpacity': 0.2,        // uniform
    'appearance.background': '#000',// uniform
    'arcs.flow.tube': 0.004,        // rebuild
    'rail.enabled': true,           // relayout
  });
  assert.deepEqual(plan.uniform.sort(), ['appearance.background', 'arcs.bodyOpacity']);
  assert.deepEqual(plan.rebuild, ['arcs.flow.tube']);
  assert.equal(plan.relayout, true);
});

test('planApply collapses several relayouts into one', () => {
  // Toggling three things that each need a resize must cost one resize, not
  // three: a resize rebuilds the composer targets and is the expensive move.
  const plan = planApply({ 'rail.enabled': true, 'arcs.bodyOpacity': 0.2 });
  assert.equal(plan.relayout, true);
  assert.equal(typeof plan.relayout, 'boolean');
});

test('planApply ignores paths it does not know', () => {
  const plan = planApply({ 'made.up.path': 1, 'arcs.bodyOpacity': 0.2 });
  assert.deepEqual(plan.uniform, ['arcs.bodyOpacity']);
  assert.deepEqual(plan.rebuild, []);
  assert.equal(plan.relayout, false);
});

test('the rules type accepts a list every row of which parses', () => {
  const list = [{ match: '10.20.50.0/24', color: '#22d3ee' },
                { match: 'DE', color: '#ff8800', end: 'dst' }];
  const c = coerce('arcs.rules', list);
  assert.equal(c.ok, true);
  assert.deepEqual(c.value, list);      // stored raw; rules.js compiles at use
});

test('the rules type refuses a bad row by index, naming the reason', () => {
  // A patch is one deliberate act, so it is all-or-nothing here. Per-row
  // partial application belongs to the panel, which knows which row somebody
  // is mid-typing in.
  const c = coerce('arcs.rules', [{ match: '10.20.50.0/24', color: '#22d3ee' },
                                  { match: 'nonsense', color: '#fff' }]);
  assert.equal(c.ok, false);
  assert.match(c.why, /rule 2/);
  assert.match(c.why, /unrecognised/);
});

test('the rules type refuses what is not a list', () => {
  for (const bad of [null, undefined, 'DE', 42, { match: 'DE' }]) {
    assert.equal(coerce('arcs.rules', bad).ok, false);
  }
});

test('an empty rule list is accepted -- it means no rules, not no opinion', () => {
  assert.equal(coerce('arcs.rules', []).ok, true);
});

test('rail.maxRules is bounded and rounds', () => {
  assert.equal(coerce('rail.maxRules', 5).value, 5);
  assert.equal(coerce('rail.maxRules', 0).value, 1);      // clamped, not refused
  assert.equal(coerce('rail.maxRules', 99).value, 20);
  assert.equal(coerce('rail.maxRules', 4.6).value, 5);
  assert.equal(coerce('rail.maxRules', 'five').ok, false);
});

test('settingLabel turns a path into something a person can recognise', () => {
  // It appears in the reset dialog's list of what would be forgotten, so the
  // bar is "recognise the setting you changed", not elegance.
  assert.equal(settingLabel('rail.enabled'), 'the stats rail');
  assert.equal(settingLabel('layers.cityLights'), 'the city lights layer');
  assert.equal(settingLabel('layers.stars'), 'the stars layer');
  assert.equal(settingLabel('camera.walk.holdSeconds'), 'camera walk hold seconds');
});

test('settingLabel never returns an empty string for a real path', () => {
  // A blank entry in "this will forget: , , and" is worse than the raw path.
  for (const p of paths()) {
    const label = settingLabel(p);
    assert.ok(typeof label === 'string' && label.trim().length > 0,
              `no label for ${p}`);
  }
});

test('relativeLuminance matches the sRGB definition', () => {
  // Measured from the shipped palette, not from memory. These are the grounds
  // the cap was derived against; see the spec's table.
  const cases = [
    ['#000000', 0.0000],
    ['#0b0916', 0.0032],   // the shipped ground
    ['#12081a', 0.0038],   // plum
    ['#0a1020', 0.0054],   // deep navy
    ['#1a1a2e', 0.0116],   // dark slate
    ['#333333', 0.0331],
    ['#808080', 0.2159],
    ['#ffffff', 1.0000],
  ];
  for (const [hex, want] of cases) {
    const got = relativeLuminance(hex);
    assert.ok(Math.abs(got - want) < 0.0001,
      `${hex}: got ${got.toFixed(4)}, want ${want.toFixed(4)}`);
  }
});

test('relativeLuminance expands the three-digit form', () => {
  // #fff and #ffffff are the same color and the HEX test accepts both, so a
  // cap that only understood the long form would let a white ground through
  // whenever somebody typed the short one.
  assert.equal(relativeLuminance('#fff'), relativeLuminance('#ffffff'));
  assert.equal(relativeLuminance('#000'), relativeLuminance('#000000'));
});

test('a ground brighter than the cap is refused, not darkened', () => {
  // Refused rather than scaled down: guessing what somebody meant is how a
  // control starts lying. Same call as a reversed zoom range.
  for (const hex of ['#ffffff', '#fff', '#808080', '#333333', '#1a1a2e']) {
    const c = coerce('appearance.background', hex);
    assert.equal(c.ok, false, `${hex} should be refused`);
    assert.match(c.why, /too bright to draw on/);
  }
});

test('the refusal names the measured luminance and the cap', () => {
  // A reason that only says "too bright" cannot be acted on -- the person
  // needs to know how far over they are. Check that both numbers are present
  // without pinning the exact wording, so re-derivations don't fail as string
  // diffs.
  const c = coerce('appearance.background', '#808080');
  assert.match(c.why, /too bright to draw on/);
  assert.ok(c.why.includes('0.2159'),
    `measured luminance not found in: ${c.why}`);
  assert.ok(c.why.includes(maxBackgroundLuminance().toFixed(4)),
    `cap not found in: ${c.why}`);
});

test('a dark ground is accepted', () => {
  for (const hex of ['#000000', '#0b0916', '#12081a', '#0a1020']) {
    const c = coerce('appearance.background', hex);
    assert.equal(c.ok, true, `${hex} should be accepted: ${c.why}`);
    assert.equal(c.value, hex);
  }
});

test('a malformed color is still refused for shape, not luminance', () => {
  // The shape test must run FIRST -- relativeLuminance('nope') would return a
  // number from NaN arithmetic rather than throwing, so a reordered check
  // would report a syntax error as a brightness problem.
  const c = coerce('appearance.background', 'nope');
  assert.equal(c.ok, false);
  assert.equal(c.why, 'not a #rgb or #rrggbb color');
});

test('maxLuminance is opt-in: a color entry without one accepts any hex', () => {
  // The previous version of this test asserted that the CAPPED entry has a
  // cap, which proves nothing about the opt-in path and would still pass if
  // the guard in coerce were inverted. SCHEMA is exported, so the uncapped
  // path is reachable: add an entry, drive a bright value through the real
  // coerce, and remove it again in a finally so no other test sees it.
  SCHEMA['appearance.__uncappedTestColor'] = {
    type: 'color', strategy: 'uniform',
    help: 'Test-only entry, added and removed inside one test.',
  };
  try {
    const c = coerce('appearance.__uncappedTestColor', '#ffffff');
    assert.equal(c.ok, true, `an uncapped color entry should accept any hex: ${c.why}`);
    assert.equal(c.value, '#ffffff');
  } finally {
    delete SCHEMA['appearance.__uncappedTestColor'];
  }
  // And the capped one still refuses the same value, so the two paths are
  // distinguished by the entry rather than by the value.
  assert.equal(coerce('appearance.background', '#ffffff').ok, false);
});

test('a shipped color default is inside its own luminance cap', () => {
  // The same protection the numeric bounds already have: catches a cap
  // written from memory, and catches a future palette change that darkens
  // the arcs without moving the ground.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'color') continue;
    const cap = e.derivedLuminanceCap ? maxBackgroundLuminance() : e.maxLuminance;
    if (typeof cap !== 'number') continue;
    const d = defaultOf(p);
    if (d === undefined || d === 'auto') continue;
    const L = relativeLuminance(d);
    assert.ok(L <= cap,
      `${p}: shipped ${d} has luminance ${L.toFixed(4)}, over ${cap}`);
  }
});

test('a refused background does not reach the accepted patch', () => {
  // validate() is what apply.js walks, so this is the assertion that the live
  // CONFIG value is left alone.
  const { accepted, rejected } = validate({
    'appearance.background': '#ffffff',
    'appearance.bloom.strength': 1.2,
  });
  assert.equal('appearance.background' in accepted, false);
  assert.equal(accepted['appearance.bloom.strength'], 1.2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].path, 'appearance.background');
});

test('an arc gain is clamped to the same floor rules.js enforces', () => {
  // rules.js floors a rule's gain at 0.05 already. The schema declaring 0 for
  // the identical quantity meant one of the two was wrong, and the schema was
  // the one that could multiply a whole arc class to black.
  //
  // Clamped rather than refused, unlike the background: every other number in
  // the schema clamps, and a floor is not an ambiguous intent the way a color
  // is.
  for (const p of ['arcs.flow.gain', 'arcs.block.gain', 'arcs.highlight.gain']) {
    const c = coerce(p, 0);
    assert.equal(c.ok, true, `${p}: ${c.why}`);
    assert.equal(c.value, 0.05, `${p} should clamp to the floor`);
    assert.equal(entry(p).min, 0.05);
  }
});

test('bloomScale keeps its zero', () => {
  // Glow only. An arc with no halo is still a visible arc, so 0 is a real
  // setting here rather than an invisible class.
  for (const p of ['arcs.flow.bloomScale', 'arcs.block.bloomScale',
                   'arcs.highlight.bloomScale']) {
    assert.equal(entry(p).min, 0);
    assert.equal(coerce(p, 0).value, 0);
  }
});

test('traffic.extraResolvers declares persist: false', () => {
  // config.js CONCATENATES the collector's NETVIZ_EXTRA_RESOLVERS onto the
  // base list at boot, and the stored patch is applied over it -- so a
  // persisted value would freeze whatever the collector was serving the day
  // it was written, and that display would never see a later change.
  assert.equal(entry('traffic.extraResolvers').persist, false);
});

test('a persist: false path applies but is not stored', () => {
  const written = [];
  const storage = {
    getItem: () => null,
    setItem: (k, v) => written.push([k, v]),
    removeItem: () => {},
  };
  const fake = { apply: (patch) => ({ applied: Object.keys(patch), rejected: [] }) };
  const wrapped = withPersistence(fake, storage);
  const out = wrapped.apply({ 'traffic.extraResolvers': ['203.0.113.53'] });
  assert.deepEqual(out.applied, ['traffic.extraResolvers']);
  assert.equal(written.length, 0, 'nothing should have been written to storage');
});

test('an ordinary path still persists', () => {
  // The guard must be narrow: this is what proves persist: false is opt-in
  // rather than a switch that quietly turned persistence off for everything.
  const written = [];
  const storage = {
    getItem: () => null,
    setItem: (k, v) => written.push([k, v]),
    removeItem: () => {},
  };
  const fake = { apply: (patch) => ({ applied: Object.keys(patch), rejected: [] }) };
  const wrapped = withPersistence(fake, storage);
  wrapped.apply({ 'layers.stars': false });
  assert.equal(written.length, 1);
  assert.match(written[0][1], /layers\.stars/);
});

test('a mixed patch persists only the persistable half', () => {
  const written = [];
  const storage = {
    getItem: () => null,
    setItem: (k, v) => written.push([k, v]),
    removeItem: () => {},
  };
  const fake = { apply: (patch) => ({ applied: Object.keys(patch), rejected: [] }) };
  const wrapped = withPersistence(fake, storage);
  wrapped.apply({ 'layers.stars': false, 'traffic.extraResolvers': ['203.0.113.53'] });
  assert.equal(written.length, 1);
  assert.doesNotMatch(written[0][1], /extraResolvers/);
});

import { maxBackgroundLuminance } from '../../netviz/static/js/settings.js';
import { setActiveRamp, RAMPS } from '../../netviz/static/js/ramp.js';

test('the derived cap reproduces the shipped 0.0088 on plasma', () => {
  // This is the test that pins LIFT = 2.85. The constant is empirical --
  // back-solved from a cap that has been on a real wall -- so if someone
  // "corrects" it to the 1.5 the old note claimed, this goes red.
  // 0.0903 * 0.18 / 1.85 = 0.00879.
  setActiveRamp('plasma');
  assert.ok(Math.abs(maxBackgroundLuminance() - 0.0088) < 0.0002,
            `got ${maxBackgroundLuminance()}`);
});

test('the old derivation is wrong and the right numbers are asserted', () => {
  // The note derived the cap from #3b0f70 at L 0.0244. plasmaAt(0.30) is not
  // that color and never was.
  assert.ok(Math.abs(relativeLuminance('#9112a1') - 0.0903) < 0.0002);
  assert.ok(Math.abs(relativeLuminance('#3b0f70') - 0.0244) < 0.0002);
});

test('every preset sky sits under its own theme cap', () => {
  const SKIES = {
    plasma: '#0b0916', viridis: '#050d10', magma: '#0a0510',
    inferno: '#0d0604', cividis: '#060a14',
  };
  for (const id of Object.keys(RAMPS)) {
    setActiveRamp(id);
    const cap = maxBackgroundLuminance();
    const L = relativeLuminance(SKIES[id]);
    assert.ok(L <= cap, `${id}: sky L ${L.toFixed(5)} over cap ${cap.toFixed(5)}`);
  }
  setActiveRamp('plasma');
});

test('a darker ramp tightens the cap', () => {
  setActiveRamp('plasma');
  const plasma = maxBackgroundLuminance();
  setActiveRamp('inferno');           // darkest flow arc of the five
  assert.ok(maxBackgroundLuminance() < plasma);
  setActiveRamp('plasma');
});
