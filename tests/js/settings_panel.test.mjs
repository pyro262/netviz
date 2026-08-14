import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dirtyPatch, revertPatch, keepQuestion, revertQuestion, closeQuestion,
  randomizeValue, randomizeScopeLine, randomizeTooltip, randomizeHeldNames,
  RANDOM_MARK, REBUILD_MARK, rebuildNoteLine,
} from '../../netviz/static/js/settings_panel.js';
import { settingLabel } from '../../netviz/static/js/settings.js';
import {
  tunerRows, isRandomized, randomizeScope, clearsArcs,
} from '../../netviz/static/js/tuner.js';

test('a keep writes only the rows that were touched', () => {
  const snapshot = new Map([['a', 1], ['b', 2], ['c', 3]]);
  const current = new Map([['a', 9], ['b', 2], ['c', 7]]);
  assert.deepEqual(dirtyPatch(snapshot, current, new Set(['a', 'c'])),
                   { a: 9, c: 7 });
});

test('a touched row that was put back is still written', () => {
  // The branch's headline contract: touched, NOT changed. Somebody dragged
  // this row, looked at the wall and put it back -- that is a decision about
  // this display and it is kept, so the stored value stops tracking a later
  // config.js change to the same path. Adding "skip it if the value equals
  // the snapshot" is the plausible optimization this test exists to refuse.
  assert.deepEqual(dirtyPatch(new Map([['a', 1]]), new Map([['a', 1]]),
                              new Set(['a'])),
                   { a: 1 });
});

test('an untouched row is never written, even if its value moved elsewhere', () => {
  // Something else on the display changed `b` while the panel was open --
  // the menu, a stored patch, the collector. The panel did not touch it, so
  // Keep has no business freezing it into this display's localStorage.
  const snapshot = new Map([['a', 1], ['b', 2]]);
  const current = new Map([['a', 1], ['b', 5]]);
  assert.deepEqual(dirtyPatch(snapshot, current, new Set()), {});
});

test('a revert restores the snapshot for the touched rows only', () => {
  const snapshot = new Map([['a', 1], ['b', 2]]);
  assert.deepEqual(revertPatch(snapshot, new Set(['b'])), { b: 2 });
});

test('reverting nothing is an empty patch, not a full re-apply', () => {
  const snapshot = new Map([['a', 1], ['b', 2]]);
  assert.deepEqual(revertPatch(snapshot, new Set()), {});
});

test('a path with no snapshot entry is skipped rather than written undefined', () => {
  // Belt and braces: a dirty mark with no snapshot behind it would otherwise
  // apply `undefined` and coerce would report "not a finite number" on a
  // control the person never touched.
  assert.deepEqual(revertPatch(new Map(), new Set(['a'])), {});
  assert.deepEqual(dirtyPatch(new Map(), new Map([['a', 1]]), new Set(['a'])), {});
});

test('a persist: false path is applied live but never kept', () => {
  // Keep calls savePatch() directly rather than going through
  // withPersistence, so the schema's `persist: false` has to be honored here
  // too -- otherwise a collector-owned row that someone drags and Keeps is
  // frozen into this display's localStorage at the merged value it happened
  // to hold, and the display silently ignores every later change the
  // collector makes. `traffic.extraResolvers` is the path that declares it.
  const snapshot = new Map([['traffic.extraResolvers', []],
                            ['layers.stars', true]]);
  const current = new Map([['traffic.extraResolvers', ['203.0.113.53']],
                           ['layers.stars', false]]);
  const patch = dirtyPatch(snapshot, current,
                           new Set(['traffic.extraResolvers', 'layers.stars']));
  // Both halves, because either alone is passed by a bug that dropped
  // everything: the excluded path is absent AND the ordinary one is present.
  assert.deepEqual(patch, { 'layers.stars': false });
});

// ------------------------------------------------------------ randomize --
//
// Every one of these runs against the REAL catalogue, not a made-up row: the
// bounds are the only thing making a random wall a readable wall, so what is
// worth proving is that no roll of any shipped slider can leave them.

const SLIDERS = tunerRows().filter((r) => r.control === 'slider');

test('the catalogue really has sliders to randomize', () => {
  // Otherwise every loop below passes vacuously.
  assert.ok(SLIDERS.length > 10, `only ${SLIDERS.length} slider rows`);
});

test("a randomized value is always inside the row's own bounds", () => {
  // A deterministic sweep rather than Math.random: an out-of-bounds roll that
  // happens once in a thousand is a bug that reaches the wall and not the
  // suite.
  for (const row of SLIDERS) {
    for (let i = 0; i <= 200; i += 1) {
      const t = i / 200 - 1e-15;       // the top end just under 1
      const v = randomizeValue(row, () => Math.max(0, t));
      assert.ok(v >= row.min && v <= row.max,
                `${row.path}: rand=${t} gave ${v}, outside [${row.min}, ${row.max}]`);
    }
  }
});

test('a randomized value lands on a step boundary of its own row', () => {
  // So the typed readout shows a number a person could write down, and the
  // value is one the slider could have been dragged to.
  for (const row of SLIDERS) {
    for (let i = 0; i <= 50; i += 1) {
      const v = randomizeValue(row, () => i / 50 - 1e-15);
      const steps = (v - row.min) / row.step;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6,
                `${row.path}: ${v} is ${steps} steps from ${row.min}`);
    }
  }
});

test('rand 0 is exactly min, and rand just under 1 never passes max', () => {
  // The two ends are where a snap-to-step goes out of bounds.
  //
  // THE SYNTHETIC ROW IS THE POINT OF THIS TEST, and the shipped rows are the
  // weaker half. `stepFor` divides every range by 200 and rounds down to a
  // power of ten, so on the real catalogue `max - min` is always a whole
  // number of steps and the clamp in `randomizeValue` NEVER FIRES: the reviewer
  // deleted it and all 486 tests still passed, while three comments claimed
  // the case was proved. A guard that passes everything looks identical to a
  // clean tree.
  //
  // 0..1.3 by 0.5 is a range that is NOT a whole number of steps -- 2.6 of
  // them. Unclamped, a roll just under 1 rounds UP to 3 steps and returns
  // 1.5, past `max`; clamped it returns 1.0.
  //
  // The fraction has to be STRICTLY above 0.5, and two earlier attempts at
  // this row are worth recording because both looked right and proved
  // nothing. 0..1 by 0.3 is 3.33 steps and rounds DOWN to 3 -> 0.9, inside
  // the bound. 0..1 by 0.4 is 2.5 steps, which looks like the boundary case
  // -- but the roll is `1 - EPSILON`, so the count is 2.4999999999999996 and
  // rounds DOWN to 2 -> 0.8. Only a fraction above 0.5 rounds up far enough
  // to leave the range. Confirmed red with the clamp deleted and green with
  // it restored; keep this row if `stepFor` is ever changed, and keep it
  // especially if it is not.
  const ODD = { control: 'slider', path: '(synthetic 0..1.3 by 0.5)',
                min: 0, max: 1.3, step: 0.5 };
  for (const row of [...SLIDERS, ODD]) {
    assert.equal(randomizeValue(row, () => 0), row.min, `${row.path} floor`);
    const top = randomizeValue(row, () => 1 - Number.EPSILON);
    assert.ok(top <= row.max, `${row.path}: top roll ${top} > max ${row.max}`);
    assert.ok(top > row.max - row.step - 1e-9,
              `${row.path}: top roll ${top} is nowhere near max ${row.max}`);
  }
});

test('a non-slider row is never given a value', () => {
  // `appearance.background` is the one that matters: its luminance cap REFUSES
  // rather than clamps, so a randomizer aimed at it would spend half its rolls
  // being rejected -- and the ground color decides whether anything else on the
  // wall is legible.
  const others = tunerRows().filter((r) => r.control !== 'slider');
  assert.ok(others.length > 0, 'no non-slider rows in the catalogue to check');
  for (const row of others) {
    assert.equal(randomizeValue(row, () => 0.5), null, `${row.path} was given a value`);
  }
  assert.ok(others.some((r) => r.path === 'appearance.background'),
            'the color row is not in the catalogue any more -- check this test');
});

// ------------------------------------------------- the three confirmations --
//
// Keep, Revert and Close each end the pending work in a way clicking again does
// not undo, so each asks first. The words are what is worth testing -- the
// dialog itself is confirm.js's, already proved, and the DOM half of the panel
// is proved by tools/verify_tuner.py against a real browser. What is proved
// here is that the question is built from what is ACTUALLY pending and that it
// honors confirm.js's contract.

const QUESTIONS = [
  ['keep', keepQuestion],
  ['revert', revertQuestion],
  ['close', closeQuestion],
];
const ONE = ['layers.stars'];
const THREE = ['layers.stars', 'arcs.bodyOpacity', 'appearance.bloom.strength'];

const allText = (q) => [q.title, q.lead, ...(q.will || []), ...(q.wont || []),
                        q.note || ''].join(' ');

for (const [name, build] of QUESTIONS) {
  test(`the ${name} question names every pending setting, in words`, () => {
    const q = build(THREE);
    const text = allText(q);
    for (const path of THREE) {
      const label = settingLabel(path);
      // The LABEL, not the raw path. `layers.stars` on a wall somebody else
      // walks up to is jargon; "the stars layer" is the same discipline
      // main.js's reset dialog follows, and settingLabel is the one place that
      // translation lives.
      assert.ok(text.includes(label),
                `${name}: no mention of ${label} (for ${path}) in:\n${text}`);
      assert.ok(!text.includes(path),
                `${name}: names the raw path ${path} rather than its label`);
    }
  });

  test(`the ${name} question says what it will NOT do`, () => {
    // The half confirm.js exists to enforce: a warning that only lists
    // consequences reads as "something bad is happening" and gets clicked
    // through. Deleting `wont` from any of the three must fail here.
    const q = build(THREE);
    assert.ok(Array.isArray(q.wont) && q.wont.length > 0,
              `${name} carries no 'wont'`);
    for (const line of q.wont) assert.ok(line.trim().length > 0);
  });

  test(`the ${name} question counts and pluralizes for one and for several`, () => {
    const one = allText(build(ONE));
    const many = allText(build(THREE));
    assert.ok(/\b1 (setting|change)\b/.test(one),
              `${name} does not say "1 setting"/"1 change": ${one}`);
    assert.ok(!/\b1 (settings|changes)\b/.test(one),
              `${name} pluralizes a single item: ${one}`);
    assert.ok(/\b3 (settings|changes)\b/.test(many),
              `${name} does not say "3 settings"/"3 changes": ${many}`);
  });

  test(`the ${name} question labels both buttons`, () => {
    const q = build(THREE);
    assert.ok(q.confirmLabel && q.cancelLabel, `${name} leaves a button unlabeled`);
  });
}

test('a long pending list is counted exactly and enumerated up to a limit', () => {
  // Randomize is what made this concrete: a Close after one has 17 settings
  // pending, and naming every one of them put a long sentence in a
  // dialog whose entire argument is that people read it. The COUNT stays exact
  // -- nothing is hidden, and the count is the number that tells somebody what they
  // are about to lose -- while the enumeration stops and says how much it left
  // out.
  const many = tunerRows().filter((r) => r.control === 'slider').map((r) => r.path);
  assert.ok(many.length > 10, `only ${many.length} paths to test with`);
  for (const [name, build] of QUESTIONS) {
    const q = build(many);
    const text = allText(q);
    assert.ok(text.includes(String(many.length)),
              `${name}: does not carry the exact count ${many.length}`);
    // THE REMAINDER IS ASSERTED, not just matched. `/and \d+ more/` passes
    // against any number at all -- an off-by-one, or the total printed where
    // the rest belongs -- so it holds the shape of the sentence and nothing
    // about its arithmetic, which is what the case is named for. Confirmed by
    // making `named()` say `labels.length`: this fails, the bare match does
    // not.
    const m = /and (\d+) more/.exec(text);
    assert.ok(m, `${name}: enumerates every one of ${many.length} settings`);
    // The listed labels are counted off the sentence rather than assumed to be
    // NAME_LIMIT, so the two halves have to agree with each other: named + more
    // is the whole list, whatever the limit is set to.
    const listed = many.filter((p) => text.includes(settingLabel(p))).length;
    assert.equal(Number(m[1]), many.length - listed,
                 `${name}: names ${listed} of ${many.length} and says `
                 + `"${m[1]} more" -- the rest is ${many.length - listed}`);
    // And against the shipped limit specifically, so a silent change to
    // NAME_LIMIT is a test that has to be updated deliberately.
    assert.equal(Number(m[1]), many.length - 6,
                 `${name}: expected ${many.length - 6} more at the shipped `
                 + `limit of 6, got ${m[1]}`);
    // The first few ARE still named -- a question that only counts answers
    // "how many" and not "which", and the short case is the common one.
    assert.ok(text.includes(settingLabel(many[0])),
              `${name}: names none of the pending settings`);
    for (const line of [...(q.will || []), ...(q.wont || [])]) {
      assert.ok(line.length < 320, `${name}: a ${line.length}-character bullet`);
    }
  }
});

test('the close question is only ever built when something is pending', () => {
  // Null, not an acknowledgement: closing an untouched panel has nothing to
  // confirm, and a one-button modal in front of every ordinary close would
  // teach exactly what confirm.js's empty-`will` rule exists to prevent. The
  // panel reads this null and closes on the one click.
  assert.equal(closeQuestion([]), null);
  assert.equal(closeQuestion(), null);
  assert.ok(closeQuestion(ONE));
});

test('keep and revert degrade to an acknowledgement rather than a false yes/no', () => {
  // Both buttons are disabled with nothing pending, so this is the degenerate
  // case -- but an empty `will` is what confirm.js reads to drop the Yes
  // button, so the words must not promise an action either way.
  for (const build of [keepQuestion, revertQuestion]) {
    const q = build([]);
    assert.deepEqual(q.will, []);
    assert.ok(q.note, 'an acknowledgement with nothing to say is not one');
  }
});

test('the keep question says where the settings are written, and where they are not', () => {
  const text = allText(keepQuestion(ONE));
  assert.match(text, /browser/i);
  assert.match(text, /collector/i);
  assert.match(text, /other display/i);
  assert.match(text, /color rules/i);
});

test('the revert question says what the wall goes back to, and what survives', () => {
  const q = revertQuestion(ONE);
  assert.match(allText(q).toLowerCase(), /whichever is later/);
  assert.match(q.wont.join(' '), /already kept/i);
});

test('the close question points at Keep as the way not to lose the work', () => {
  const q = closeQuestion(ONE);
  assert.match(q.note, /Keep/);
  assert.match(q.wont.join(' '), /already kept/i);
});

// ------------------------------------------- what the panel SAYS Randomize does --
//
// The behavior was already right; these hold the panel to saying so. The
// project's own precedent is the color-rules MATCH legend (0.4.5): a control
// with no affordance of its own has to answer "what will this do" without being
// asked, and a tooltip on a wall display never gets asked.

test('the printed count is the number of rows Randomize actually moves', () => {
  // THE ASSERTION THIS SECTION EXISTS FOR. A sentence naming a number is a
  // claim about behavior, and more rows are about to be added to this panel --
  // so the number is derived and this ties it back to the flag. A hardcoded
  // count passes on the day it is typed and lies afterwards, with nothing red.
  const rolled = tunerRows().filter(isRandomized).length;
  const line = randomizeScopeLine();
  assert.match(line, new RegExp(`only the ${rolled} settings`));
  assert.match(line, new RegExp(`other ${tunerRows().length - rolled} `));
});

test('the scope line says it in plain language, and names the mark', () => {
  const line = randomizeScopeLine();
  // "how the display looks" is what a person can act on. The mark has to be IN
  // the sentence, or the marks on the rows are decoration nothing explains.
  assert.match(line, /how the display looks/);
  assert.ok(line.includes(RANDOM_MARK), 'the scope line does not show the mark');
  // Not the alarm hue, and not jargon: no schema paths, no flag names.
  assert.doesNotMatch(line, /randomize:|slider|flag|tunerRows/);
});

test('the scope line follows a change to the table', () => {
  // Fed a smaller partition rather than mutating GROUPS: this proves the COPY
  // reads its numbers from the scope it is handed, which is the half of the
  // staleness guard that lives in this file.
  const line = randomizeScopeLine({ count: 3, heldCount: 21 });
  assert.match(line, /only the 3 settings/);
  assert.match(line, /other 21 /);
});

test('the default scope line and the shipped partition agree', () => {
  assert.equal(randomizeScopeLine(), randomizeScopeLine(randomizeScope()));
});

test('the tooltip names the held rows, and names ALL of them', () => {
  // Review caught the hand-written version claiming the held set was "the
  // camera's timings and the background color" -- which quietly omitted the
  // star ramp, held for a third reason again. The counts were already derived
  // and did NOT protect this: a characterization is a separate claim from a
  // count, and it is the half that goes stale when a row is held for a new
  // reason. So the names are derived, and this holds every one of them.
  const scope = randomizeScope();
  const tip = randomizeTooltip();
  for (const row of scope.held) {
    assert.ok(tip.includes(row.label),
              `the tooltip does not name the held row ${row.path}`);
  }
  assert.equal(randomizeHeldNames(scope).split(', ').length, scope.heldCount);
  assert.match(tip, new RegExp(`the ${scope.count} rows marked`));
  assert.match(tip, new RegExp(`other ${scope.heldCount} are left alone`));
});

test('the tooltip uses the on-screen labels, not schema paths', () => {
  // The tooltip points at rows a person can see: "Walk speed cap" is printed
  // beside the one it means, where settingLabel gives "camera walk degrees per
  // second" -- the schema talking to itself.
  const tip = randomizeTooltip();
  assert.match(tip, /Walk speed cap/);
  assert.doesNotMatch(tip, /camera walk degrees per second/);
});

test('the printed line stays hedged where the tooltip enumerates', () => {
  // Two jobs, deliberately. The line is the one-glance version and the marks
  // answer "which ones" precisely; a line that named all 10 would be the wall
  // of text NAME_LIMIT exists to refuse, three paragraphs up the panel.
  const line = randomizeScopeLine();
  assert.match(line, /including the camera's timings/);
  assert.ok(!line.includes('Star ramp minutes'), 'the line enumerates');
});

// ------------------------------- what the panel SAYS about the rebuild rows --
//
// Nine rows clear every arc on screen when they are dragged, because the shape
// of an arc is built when the arc is drawn. That is unavoidable and correct;
// what is not acceptable is it happening unannounced, since on a wall the arcs
// all vanishing reads as the feed dying. These hold the copy to the rows.

test('the rebuild note counts the rows that actually rebuild', () => {
  // Derived, for the same reason the randomize count is: a number typed into
  // the copy is a claim on a wall that nothing holds to the schema.
  const n = tunerRows().filter(clearsArcs).length;
  const line = rebuildNoteLine();
  assert.ok(n > 0, 'the panel has no rebuilding rows to describe');
  assert.match(line, new RegExp(`The ${n} rows marked`));
  assert.ok(line.includes(REBUILD_MARK), 'the note does not show the mark');
});

test('the rebuild note says what happens AND that it is not a fault', () => {
  // Same rule confirm.js enforces with `will` and `wont`: a warning that only
  // lists the consequence reads as a fault report. The half that says the arcs
  // come back is what makes the first half worth printing.
  const line = rebuildNoteLine();
  assert.match(line, /clears the arcs on screen/);
  assert.match(line, /come back/);
  assert.match(line, /not the feed dropping/);
  // No jargon: the panel does not say "rebuild strategy" or name a schema key.
  assert.doesNotMatch(line, /strategy|TubeGeometry|setSpec|arcs\./);
});

test('a panel with no rebuilding rows says nothing at all', () => {
  // An empty paragraph explaining a mark nobody can see is worse than silence,
  // and the caller appends the line only when it is non-empty.
  assert.equal(rebuildNoteLine([]), '');
  assert.equal(rebuildNoteLine([{ path: 'x', rebuilds: false }]), '');
});

test('the two marks are different glyphs', () => {
  // They appear on the same rows -- all nine rebuilding rows are randomizable
  // -- so one glyph doing both jobs would make each unreadable.
  assert.notEqual(RANDOM_MARK, REBUILD_MARK);
});
