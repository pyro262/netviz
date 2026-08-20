import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCount, formatLag, formatPercent, formatAge, formatClock, panels, sparkPoints, versionLabel,
  countryName,
} from '../../netviz/static/js/rail.js';

test('formatCount stays exact until a wall stops being able to read it', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(812), '812');
  assert.equal(formatCount(9999), '9999');
  assert.equal(formatCount(10000), '10.0k');
  assert.equal(formatCount(123456), '123k');
  assert.equal(formatCount(1600000), '1.6M');
  assert.equal(formatCount(23000000), '23M');
});

test('formatCount renders missing data as a dash, not as zero', () => {
  // A collector without an IPFIX decoder (synthetic mode) sends null for these
  // rows. Showing 0 would claim the router sent nothing, which is a different
  // and much more alarming statement.
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
});

test('formatLag keeps sub-second precision where it matters', () => {
  assert.equal(formatLag(0), '0.0s');
  assert.equal(formatLag(0.82), '0.8s');
  assert.equal(formatLag(9.94), '9.9s');
  assert.equal(formatLag(42), '42s');
  assert.equal(formatLag(600), '10m');
  assert.equal(formatLag(7200), '2h');
  assert.equal(formatLag(null), '—');
});

test('formatPercent matches how the miss rate is quoted elsewhere', () => {
  assert.equal(formatPercent(0.059), '5.9%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(null), '—');
});

test('formatAge distinguishes never-seen from just-seen', () => {
  assert.equal(formatAge(null), 'never');
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(59), '59s');
  assert.equal(formatAge(120), '2m');
  assert.equal(formatAge(7260), '2h 1m');
});

test('formatClock zero-pads both clocks', () => {
  const d = new Date(Date.UTC(2026, 7, 9, 4, 5, 6));
  const { utc } = formatClock(d);
  assert.equal(utc, '04:05:06');
});

const SNAPSHOT = {
  blocks: {
    total: 812,
    unplaced: 0,
    top: [{ cc: 'CN', n: 400 }, { cc: 'RU', n: 200 }, { cc: 'IR', n: 100 }],
  },
  netflow: {
    flows_per_min: 842,
    lag_seconds: 0.8,
    ipfix: { records: 1600000, no_template: 1 },
    syslog: { datagrams: 182 },
  },
  geoip: { miss_rate: 0.059 },
  feeds: {
    netflow: { ok: true, age: 2 },
    blocks: { ok: true, age: 240 },
    influx: { ok: false, age: 900 },
  },
};

test('panels reads the live snapshot into three panels', () => {
  const p = panels(SNAPSHOT);
  assert.deepEqual(p.map((x) => x.title), ['GEO BLOCKS', 'NETFLOW', 'FEED HEALTH']);
  assert.equal(p[0].big, '812');
  assert.equal(p[1].big, '842');
});

test('block bars are scaled to the leader, not to the total', () => {
  // Scaled to the total, a country holding 80% of the blocks leaves every other
  // bar a stub and the ranking below the top row unreadable.
  const rows = panels(SNAPSHOT)[0].rows;
  assert.equal(rows[0].bar, 1);
  assert.equal(rows[1].bar, 0.5);
  assert.equal(rows[2].bar, 0.25);
  assert.deepEqual(rows.map((r) => r.label), ['CN', 'RU', 'IR']);
});

test('a stale feed is marked, not merely aged', () => {
  const rows = panels(SNAPSHOT)[2].rows;
  const influx = rows.find((r) => r.label === 'INFLUX');
  assert.equal(influx.ok, false);
  assert.match(influx.value, /^STALE /);
  assert.equal(rows.find((r) => r.label === 'NETFLOW').ok, true);
});

test('a failed poll still renders every row', () => {
  // The rail emptying out on a failed poll looks exactly like a quiet network,
  // which is the confusion degraded mode exists to prevent.
  const p = panels(null);
  assert.equal(p.length, 3);
  assert.equal(p[0].big, '—');
  assert.equal(p[1].rows.find((r) => r.label === 'INGEST LAG').value, '—');
  assert.equal(p[2].rows[0].value, '—');
});

test('no blocks in 24h shows a row rather than an empty panel', () => {
  const p = panels({ blocks: { total: 0, top: [] }, netflow: {}, geoip: {} });
  assert.equal(p[0].big, '0');
  assert.equal(p[0].rows.length, 1);
  assert.equal(p[0].rows[0].muted, true);
});

test('bars never divide by zero when every count is zero', () => {
  const p = panels({ blocks: { total: 0, top: [{ cc: 'CN', n: 0 }] } });
  assert.equal(p[0].rows[0].bar, 0);
});

test('sparkPoints scales a series to its own peak', () => {
  assert.deepEqual(sparkPoints([0, 2, 4, 1]), [0, 0.5, 1, 0.25]);
});

test('sparkPoints returns null for an hour with no blocks', () => {
  // A flat line at zero is a claim, and it is also what a broken series looks
  // like. Nothing drawn is the honest answer.
  assert.equal(sparkPoints([0, 0, 0, 0]), null);
});

test('sparkPoints returns null when the collector serves no series', () => {
  assert.equal(sparkPoints(undefined), null);
  assert.equal(sparkPoints(null), null);
  assert.equal(sparkPoints('nope'), null);
});

test('sparkPoints refuses a series too short to be a line', () => {
  assert.equal(sparkPoints([]), null);
  assert.equal(sparkPoints([5]), null);
});

test('sparkPoints treats junk entries as zero rather than propagating NaN', () => {
  assert.deepEqual(sparkPoints([null, 4, undefined, 2]), [0, 1, 0, 0.5]);
});

test('sparkPoints ignores negatives instead of inverting the line', () => {
  assert.deepEqual(sparkPoints([-3, 0, 6]), [0, 0, 1]);
});

test('panels attaches a sparkline to each block row', () => {
  const rows = panels({
    blocks: { total: 9, top: [
      { cc: 'RU', n: 6, spark: [0, 3, 6] },
      { cc: 'CN', n: 3, spark: [3, 0, 0] },
    ] },
  })[0].rows;
  assert.deepEqual(rows.map((r) => r.label), ['RU', 'CN']);
  assert.deepEqual(rows[0].spark, [0, 0.5, 1]);
  assert.deepEqual(rows[1].spark, [1, 0, 0]);
});

test('each row scales to its own peak, not the leader', () => {
  // Otherwise every row below the top one flattens to nothing and the shape,
  // which is the only thing the line is for, is lost.
  const rows = panels({
    blocks: { total: 101, top: [
      { cc: 'RU', n: 100, spark: [0, 100] },
      { cc: 'CN', n: 1, spark: [0, 1] },
    ] },
  })[0].rows;
  assert.deepEqual(rows[0].spark, [0, 1]);
  assert.deepEqual(rows[1].spark, [0, 1]);
});

test('a failed poll renders no sparkline and no fake row', () => {
  const rows = panels(null)[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '—');
  assert.ok(!rows[0].spark);
});

test('a collector without spark support still renders its bars', () => {
  const rows = panels({ blocks: { total: 3, top: [{ cc: 'RU', n: 3 }] } })[0].rows;
  assert.equal(rows[0].value, '3');
  assert.equal(rows[0].bar, 1);
  assert.equal(rows[0].spark, null);
});

import { rulePanel } from '../../netviz/static/js/rail.js';
import { createClassCounter, ruleKey } from '../../netviz/static/js/classcount.js';

test('the rail lists a row per rule, busiest first', () => {
  const c = createClassCounter();
  const ruleA = { match: 'A', color: '#111111', name: 'a' };
  const ruleB = { match: 'B', color: '#222222', name: 'b' };
  // Seeded under ruleKey(rule) -- the same stable identity main.js counts
  // under -- not a positional 'rule1'/'rule2' label, which would desync from
  // the counter the moment a rule is reordered rather than recolored.
  for (let i = 0; i < 5; i += 1) c.add(ruleKey(ruleB), 1000 + i * 1000);
  c.add(ruleKey(ruleA), 1000);
  const p = rulePanel([ruleA, ruleB], c, 6000, 5);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].label, 'b', 'the busier rule leads');
});

test('the rail caps the list and names the overflow', () => {
  const c = createClassCounter();
  const rules = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    .map((m) => ({ match: m, color: '#111111' }));
  const p = rulePanel(rules, c, 1000, 5);
  assert.equal(p.rows.length, 6, 'five rules plus the overflow line');
  assert.equal(p.rows[5].label, '+2 more');
});

test('a disabled rule is not listed at all', () => {
  const p = rulePanel([{ match: 'A', color: '#111111', enabled: false }],
                      createClassCounter(), 1000, 5);
  assert.equal(p, null);
});

test('no rules means no panel, not an empty one', () => {
  assert.equal(rulePanel([], createClassCounter(), 1000, 5), null);
});

test('a rule with no name is labelled by its matcher', () => {
  // The matcher is already self-describing; forcing a label produces
  // "network 1", which says less than "10.20.50.0/24".
  const p = rulePanel([{ match: '10.20.50.0/24', color: '#111111' }],
                      createClassCounter(), 1000, 5);
  assert.equal(p.rows[0].label, '10.20.50.0/24');
});

import { start } from '../../netviz/static/js/rail.js';

/** Minimal DOM: rail.js touches getElementById, classList, and builds nodes
 *  through createElement/append/replaceChildren -- never innerHTML. */
function fakeDom() {
  const mk = () => {
    const el = {
      className: '', innerHTML: '', children: [],
      style: {},
      setAttribute: () => {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      appendChild(c) { this.children.push(c); return c; },
      querySelector() { return null; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      textContent: '',
    };
    return el;
  };
  const rail = mk();
  const body = mk();
  return {
    rail,
    body,
    document: {
      body,
      getElementById: (id) => (id === 'rail' ? rail : null),
      createElement: () => mk(),
      createElementNS: () => mk(),
    },
  };
}

test('the rail can be taken back down again', async () => {
  const dom = fakeDom();
  const timers = [];
  const realDoc = globalThis.document;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realFetch = globalThis.fetch;
  globalThis.document = dom.document;
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  globalThis.clearInterval = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
  globalThis.fetch = async () => ({ ok: false });
  try {
    const handle = start();
    // start() does NOT resize -- the caller does, once. What it guarantees is
    // the ORDERING: by the time it returns, body.rail is set and the rail is
    // painted, so a caller measuring #stage next sees the narrowed box.
    assert.equal(dom.body.classList.contains('rail'), true);
    assert.ok(dom.rail.children.length > 0, 'the rail was not painted before start() returned');
    assert.equal(timers.filter((t) => t.live).length, 2, 'poll and clock');

    handle.stop();
    assert.equal(dom.body.classList.contains('rail'), false, 'body.rail survived stop()');
    assert.equal(timers.filter((t) => t.live).length, 0, 'a timer outlived the rail');
    // children, not innerHTML: paint() builds nodes with replaceChildren and
    // never touches innerHTML, so the old assertion held on a fake that started
    // at '' and would have passed with the teardown deleted entirely.
    assert.equal(dom.rail.children.length, 0, 'the rail still has content after stop()');

    handle.stop();          // idempotent: a double toggle must not throw
    // Give pending async operations time to complete with stubbed globals
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    globalThis.document = realDoc;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.fetch = realFetch;
  }
});

test('versionLabel prints the collector build, prefixed once', () => {
  assert.equal(versionLabel({ version: '0.3.0' }), 'v0.3.0');
  // A collector that already prefixed it must not become vv0.3.0.
  assert.equal(versionLabel({ version: 'v0.3.0' }), 'v0.3.0');
});

test('versionLabel shows nothing rather than guessing', () => {
  // An older collector serves no version at all. Printing a fabricated one --
  // or the renderer's own idea of it -- would be a claim about the far end of
  // a connection this page cannot see. Same rule as the update watermark:
  // false in every uncertain case.
  assert.equal(versionLabel(null), '');
  assert.equal(versionLabel({}), '');
  assert.equal(versionLabel({ version: '' }), '');
  assert.equal(versionLabel({ version: 42 }), '');
});

test('the legend rides at the top of COLOR RULES, naming what each arc means', () => {
  // "What am I looking at" is the question the wall cannot answer on its own.
  // The rail already carries a swatch per COLOR RULE; the two built-in
  // classes had none, so these two were the only colors on the display with
  // nothing anywhere saying what they meant.
  const rules = { id: 'rules', title: 'COLOR RULES', note: 'SINCE LOAD',
                  rows: [{ label: 'storj', value: '9.0/min', swatch: '#22d3ee' }] };
  const p = panels(SNAPSHOT, rules, { block: '#f0b000', flow: '#9112a1' });
  const legend = p.find((x) => x.id === 'rules');
  // One key, not two: the built-in classes and the rules mean the same thing
  // by the same swatch, so they share a panel -- built-ins first.
  assert.equal(p.some((x) => x.id === 'legend'), false, 'a second key panel appeared');
  assert.deepEqual(legend.rows.map((r) => [r.label, r.swatch]),
                   [['Geo-blocked', '#f0b000'], ['All other traffic', '#9112a1'],
                    ['storj', '#22d3ee']]);
  // `legend` marks the two fixed rows and nothing else: paint() keys the big
  // chip off it, and measure() keys the rule fitter's row set off it too.
  assert.deepEqual(legend.rows.map((r) => r.legend === true), [true, true, false]);
  // The color WORD is gone from both labels on purpose: the swatch is
  // sampled from the live display and cannot lie, while "amber" survives a
  // recolor through the theme, the tuning panel or Chaos and then contradicts
  // the arcs it names.
  for (const row of legend.rows.filter((r) => r.legend)) {
    assert.doesNotMatch(row.label, /amber|violet|purple|orange/i,
                        `${row.label} names a color the display can change`);
  }
  // And the data panels are back to nothing but data.
  assert.equal(p.find((x) => x.title === 'GEO BLOCKS').rows[0].label, 'CN');
  assert.equal(p.find((x) => x.title === 'NETFLOW').rows[0].label, 'INGEST LAG');
});

test('the legend swatch is the color it was handed, never a literal', () => {
  // The arc colors are tuned constants that have already moved several times,
  // and arcs.js cannot be imported here (it imports three), so the rail is
  // GIVEN the live color rather than knowing one. A hardcoded swatch would
  // keep claiming amber after somebody recolored the class through settings,
  // which is worse than no legend: the wall and its key would disagree.
  const p = panels(SNAPSHOT, null, { block: '#00ff00', flow: '#0000ff' });
  assert.deepEqual(p[p.length - 1].rows.map((r) => r.swatch), ['#00ff00', '#0000ff']);
});

test('with no rules at all the key stands alone, and never as the rules panel', () => {
  // `id: 'rules'` is the handle the rule fitter measures. A key wearing it
  // with no rule rows in it would put the fitter's arithmetic on two rows
  // that are not rules.
  const p = panels(SNAPSHOT, null, { block: '#00ff00', flow: '#0000ff' });
  const key = p[p.length - 1];
  assert.equal(key.id, 'legend');
  assert.equal(key.title, 'ARCS');
  assert.equal(p.some((x) => x.id === 'rules'), false);
});

test('no colors means no legend, and every other row is untouched', () => {
  // start() has one caller today, but panels() is called with two arguments
  // throughout this suite and a legend must not appear from nowhere.
  const p = panels(SNAPSHOT);
  assert.equal(p.some((x) => x.title === 'ARCS'), false);
  assert.equal(p.find((x) => x.title === 'GEO BLOCKS').rows[0].label, 'CN');
  assert.equal(p.find((x) => x.title === 'NETFLOW').rows[0].label, 'INGEST LAG');
});

// -------------------------------------------------------- country names --
//
// The GEO BLOCKS rows are two-letter codes, and a code is not a country to
// everybody who walks up to the wall. The name comes from `Intl.DisplayNames`,
// so no table ships and none can drift -- the rail can show ANY country that
// gets blocked, not only the watched ones.

test('a country code is named from the platform, with no table shipped', () => {
  assert.equal(countryName('CN'), 'China');
  assert.equal(countryName('RU'), 'Russia');
  assert.equal(countryName('KP'), 'North Korea');
  // Lower case is accepted too: the code comes off a wire format, not a
  // constant, and refusing on case would be a tooltip that vanishes for a
  // reason nobody could see.
  assert.equal(countryName('cn'), 'China');
});

test('the unplaceable code returns null AND does not throw', () => {
  // THE REASON THIS FUNCTION EXISTS. `--` is what foreign_country() yields
  // when neither end places, so it reaches the rail in normal operation --
  // and `Intl.DisplayNames.of('--')` throws a RangeError. Unguarded that
  // throw lands inside paint() and blanks the WHOLE RAIL, replacing every
  // live number with nothing, which is why both halves are asserted: it must
  // return null, and it must not throw on the way.
  assert.doesNotThrow(() => countryName('--'));
  assert.equal(countryName('--'), null);
  // The other shapes .of() refuses outright, for the same reason.
  for (const bad of ['', 'A', 'ABC', '1', '- ', null, undefined, 42]) {
    assert.doesNotThrow(() => countryName(bad), `threw on ${JSON.stringify(bad)}`);
    assert.equal(countryName(bad), null, `named ${JSON.stringify(bad)}`);
  }
});

test('a code with no name is treated as having no name', () => {
  // `ZZ` does NOT throw -- it returns "Unknown Region", which is noise over a
  // code that already says the same thing. No tooltip beats a useless one.
  assert.equal(countryName('ZZ'), null);
});

test('panels names the block rows and leaves the others alone', () => {
  const p = panels(SNAPSHOT, null, { block: '#00ff00', flow: '#0000ff' });
  const blocks = p.find((x) => x.title === 'GEO BLOCKS');
  const cn = blocks.rows.find((r) => r.label === 'CN');
  assert.equal(cn.title, 'China');
  // Nothing on the legend takes a country tooltip either: it explains a
  // color, not a place.
  for (const row of p[p.length - 1].rows) assert.equal(row.title, undefined);
  for (const row of p.find((x) => x.title === 'NETFLOW').rows) {
    assert.equal(row.title, undefined, `${row.label} was given a country name`);
  }
});

test('the NONE placeholder and an unnameable code carry no tooltip', () => {
  // Absent, not null: paint() tests the key, and a row whose title is an empty
  // string would set an empty `title` attribute -- a tooltip that opens and
  // says nothing, which reads as broken rather than as absent.
  const empty = panels({ blocks: { total: 0, top: [] } });
  const none = empty.find((x) => x.title === 'GEO BLOCKS').rows[0];
  assert.equal(none.label, 'NONE');
  assert.ok(!('title' in none), 'the NONE placeholder was given a tooltip');

  const unplaced = panels({ blocks: { total: 5, top: [{ cc: '--', n: 5 }] } });
  const row = unplaced.find((x) => x.title === 'GEO BLOCKS').rows[0];
  assert.equal(row.label, '--');
  assert.ok(!('title' in row), 'the unplaceable code was given a tooltip');
});

test('the painted row really carries the name as a title attribute', async () => {
  // panels() deciding the name proves nothing about it REACHING the DOM, and
  // that last hop is the whole feature. This mounts the rail against a fetch
  // that answers with a real snapshot and reads the row element back.
  //
  // It also checks the DOM fake tolerates a plain `title` assignment -- the
  // same class of trap as the label span above, where the fake implements
  // createElement and not createTextNode.
  const dom = fakeDom();
  const realDoc = globalThis.document;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realFetch = globalThis.fetch;
  globalThis.document = dom.document;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => SNAPSHOT });
  let handle = null;
  try {
    handle = start();
    // start() fires the first poll without awaiting it; two microtask turns
    // is enough for fetch + json + the redraw it ends with.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const rows = [];
    const walk = (node) => {
      if (String(node.className || '').startsWith('rail-row')) rows.push(node);
      for (const c of node.children || []) walk(c);
    };
    walk(dom.rail);
    const textOf = (node) => {
      if (node.textContent) return node.textContent;
      for (const c of node.children || []) {
        const t = textOf(c);
        if (t) return t;
      }
      return '';
    };
    const cn = rows.find((r) => textOf(r) === 'CN');
    assert.ok(cn, `no CN row painted (${rows.length} rows)`);
    assert.equal(cn.title, 'China');
    // And the row that cannot be named carries no title at all, on the
    // element rather than in the model -- an empty `title` attribute is a
    // tooltip that opens and says nothing.
    const legend = rows.find((r) => textOf(r) === 'INGEST LAG');
    assert.ok(legend, 'no INGEST LAG row painted');
    assert.equal(legend.title, undefined);
  } finally {
    if (handle) handle.stop();
    globalThis.document = realDoc;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.fetch = realFetch;
  }
});

test('the shape test PREVENTS the call, it does not merely survive it', () => {
  // Why this test is not "countryName('--') is null" again: that contract is
  // double-held. The shape test refuses `--`, and the try/catch would return
  // null for the same input if the shape test were deleted -- confirmed by
  // deleting it and watching all 497 tests stay green. A guard whose removal
  // changes nothing observable is a guard nobody can trust, which is exactly
  // the failure this repo already recorded for a pre-push hook that scanned
  // an empty range.
  //
  // So assert the CLAIM rather than the outcome: `.of()` is never reached for
  // a code that cannot be one. The stub throws unconditionally, so with the
  // shape test deleted the catch still returns null and a return-value
  // assertion would pass -- only the call COUNT tells the two apart.
  const calls = [];
  const throwing = {
    of(code) {
      calls.push(code);
      throw new RangeError(`Invalid region code: ${code}`);
    },
  };
  try {
    for (const bad of ['--', '', 'A', 'ABC', '- ', '1']) {
      assert.equal(countryName(bad, throwing), null, `named ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(calls, [],
                     `.of() was called for ${JSON.stringify(calls)} -- the shape `
                     + 'test is not preventing the call');
    // ...and the seam is real: a code that PASSES the shape test does reach
    // the formatter. Without this half the test would pass against a
    // countryName that never calls .of() at all.
    assert.equal(countryName('CN', throwing), null, 'a throwing formatter must yield null');
    assert.deepEqual(calls, ['CN']);
  } finally {
    // Nothing global was patched -- the stub is a parameter, not a monkey
    // patch -- so there is nothing to restore, and that is the point of the
    // seam: a failure here cannot leak into the rest of the file.
    calls.length = 0;
  }
});

// ------------------------------------------- fitting the rail to the screen --
//
// MEASURED FIRST, on a real page with `rail.maxRules` at its 20 ceiling: the
// rail's content first exceeds the viewport at 9 rules at 2560x1440 and 8 at
// 1920x1080, and overflows by 502px / 378px at 20. `#rail` had no overflow
// property, so that content spilled off the bottom of the screen unreachable --
// and a scrollbar alone is no answer on a wall nobody is standing at. These
// hold the arithmetic that decides how many rows are drawn instead.

import { fitRuleCap, railContentHeight, ruleBoxMetrics } from '../../netviz/static/js/rail.js';

// One row 30px, 200px of other panels, 40px of panel chrome. 600 - 200 - 40 is
// 360px of room, so 12 rows fit.
const BOX = { available: 600, other: 200, chrome: 40, rowHeight: 30 };

test('a list that fits is not reduced', () => {
  assert.equal(fitRuleCap({ ...BOX, total: 5, maxRules: 20 }), 5);
  assert.equal(fitRuleCap({ ...BOX, total: 12, maxRules: 20 }), 12);
});

test('a list that does not fit loses a row to "+N more"', () => {
  // 12 rows of room and 20 rules: 11 rules plus the line that says 9 are
  // missing. Returning 12 would draw the overflow row off the bottom, which is
  // the one row that must survive -- it is what stops the truncation being
  // silent.
  assert.equal(fitRuleCap({ ...BOX, total: 20, maxRules: 20 }), 11);
});

test('fitting never exceeds rail.maxRules', () => {
  // A fit is a REDUCTION of the operator's setting. Plenty of room and a cap of
  // 3 is still 3 -- the setting is a decision, not a hint.
  assert.equal(fitRuleCap({ ...BOX, total: 20, maxRules: 3 }), 3);
  assert.equal(fitRuleCap({ ...BOX, available: 4000, total: 20, maxRules: 5 }), 5);
});

test('a rail with no room still shows one rule, never zero', () => {
  // Below the floor the scrollbar is the net. Zero would drop the "+N more"
  // line with the rows and the display would stop saying the rules exist.
  assert.equal(fitRuleCap({ ...BOX, available: 240, total: 20, maxRules: 20 }), 1);
  assert.equal(fitRuleCap({ ...BOX, available: 0, total: 20, maxRules: 20 }), 20);
  assert.equal(fitRuleCap({ ...BOX, available: -50, total: 20, maxRules: 20 }), 20);
});

test('an unmeasurable rail falls back to the setting, not to a guess', () => {
  // First paint, or a row of zero height. The un-fitted rail is what shipped,
  // so falling back to it is the honest failure -- inventing a number from a
  // measurement that is not there is how a control starts lying.
  assert.equal(fitRuleCap({ ...BOX, rowHeight: 0, total: 20, maxRules: 7 }), 7);
  assert.equal(fitRuleCap({ ...BOX, rowHeight: NaN, total: 20, maxRules: 7 }), 7);
  assert.equal(fitRuleCap({ available: NaN, other: 0, chrome: 0, rowHeight: 10,
                            total: 20, maxRules: 7 }), 7);
});

test('the fit is idempotent under a lowered maxRules', () => {
  // Named for what it actually proves. It does NOT prove the oscillation is
  // gone -- that needs the measurements to be re-derived from the new row
  // count, which is a DOM fact this cannot see; the simulation below is what
  // covers it. Left in because a cap that moved when re-applied to itself
  // would be a bug on its own.
  const first = fitRuleCap({ ...BOX, total: 20, maxRules: 20 });
  assert.equal(fitRuleCap({ ...BOX, total: 20, maxRules: first }), first);
  assert.equal(fitRuleCap({ ...BOX, total: first, maxRules: first }), first);
});

test('lowering the cap only ever drops the SHORT rows', () => {
  // INVARIANT 1 OF THE FITTER, asserted rather than only described. A rule that
  // has fired carries a sparkline and is nearly twice the height of an idle
  // one, so `ruleBoxMetrics`'s `max` only stays put across a re-measure while
  // the busy rules are the ones kept. That holds because `rulePanel` ranks by
  // the last hour descending -- and this asserts the PROPERTY (the rows kept at
  // a lower cap are a prefix of those kept at a higher one) rather than the
  // sort call, so a re-ranking that preserves it stays legal while a reversal
  // fails. Reverse the sort and the fit alternates between two caps on every
  // poll: dropping a tall row lowers the max, which frees room, which puts it
  // back.
  const c = createClassCounter();
  const rules = [];
  for (let i = 0; i < 6; i += 1) {
    const r = { match: `203.0.113.${i}/32`, color: '#111111', name: `r${i}` };
    rules.push(r);
    // r0 busiest, r5 silent -- so list order is the REVERSE of the ranking and
    // a missing sort cannot pass this by accident.
    for (let n = 0; n < (5 - i) * 3; n += 1) c.add(ruleKey(r), 1000);
  }
  const kept = (cap) => rulePanel(rules, c, 1000, cap).rows
    .filter((row) => !row.muted).map((row) => row.label);
  const wide = kept(6);
  // Busiest first: the ranking is the reverse of the list order.
  assert.deepEqual(wide, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  for (let cap = 1; cap < 6; cap += 1) {
    assert.deepEqual(kept(cap), wide.slice(0, cap),
                     `cap ${cap} did not keep the top ${cap} rows`);
  }
  // And the silent rules -- the short rows -- are exactly the ones let go.
  assert.ok(!kept(3).includes('r5'), 'a silent rule outranked a busy one');
});

test('re-measuring after each fit settles, and does not oscillate', () => {
  // THE OSCILLATION PROPERTY, driven properly: a fake rail that RE-DERIVES
  // `other` and `chrome` from the rows it just drew, the way measure() does
  // against a real DOM, iterated the way successive draws would. The previous
  // version of this test fed the cap back into unchanged measurements, which
  // any monotone function passes.
  //
  // MIXED HEIGHTS, not `Array(n).fill(ROW)`. With uniform rows the old and new
  // arithmetic produce identical numbers, so a uniform simulation would pass
  // unchanged against the buggy divisor while reading as though it covered
  // heterogeneity. These are the measured shapes: a fired rule 77px, an idle
  // one 41.4px, the "+N more" line shorter again -- laid out the way the panel
  // really orders them, tall rows first.
  const TALL = 77, SHORT = 41.4, MORE = 30;
  const BUSY = 4;                       // rules that have fired in the hour
  const CHROME = 40, OTHER = 200, AVAIL = 600, TOTAL = 20;
  const drawnRows = (cap) => {
    const n = Math.min(cap, TOTAL);
    const rows = Array.from({ length: n }, (_, i) => (i < BUSY ? TALL : SHORT));
    if (TOTAL > cap) rows.push(MORE);
    return rows;
  };
  const measureAfter = (cap) => {
    const rows = drawnRows(cap);
    const box = CHROME + rows.reduce((a, b) => a + b, 0);
    return { available: AVAIL, other: OTHER, ...ruleBoxMetrics(box, rows) };
  };
  const seen = [];
  let cap = 20;
  for (let i = 0; i < 10; i += 1) {
    cap = fitRuleCap({ ...measureAfter(cap), total: TOTAL, maxRules: 20 });
    seen.push(cap);
  }
  // Settles on the first step and never moves again. A shrink/grow loop over
  // these same numbers alternates, which is what this refuses.
  assert.equal(new Set(seen).size, 1, `cap oscillated: ${seen.join(',')}`);
  // And it settled somewhere the content actually fits.
  const fitsIn = CHROME + OTHER
    + drawnRows(seen[0]).reduce((a, b) => a + b, 0);
  assert.ok(fitsIn <= AVAIL, `settled at ${seen[0]}, needing ${fitsIn} of ${AVAIL}`);
});

// ------------------------------------------- rule rows are NOT equal height --

test('a fired rule row is measured, not assumed equal to an idle one', () => {
  // Measured live at 2560x1440: a rule with a sparkline is 77px, an idle one
  // 41.4px -- the svg lands as a third child of a two-column grid because
  // rulePanel gives a rule row a `spark` and no `bar`.
  //
  // THIS IS THE TEST THAT FAILS AGAINST `rows[0]`. Ranked by traffic, row 0 is
  // the tallest, and `boxHeight - n * rows[0]` is 585 - 12 x 77 = -339: the
  // fitter subtracted a negative chrome and handed itself 339px of room that
  // does not exist.
  const rows = [77, ...Array(11).fill(41.4)];
  const m = ruleBoxMetrics(585, rows);
  assert.equal(m.rowHeight, 77, 'the worst row is what the divisor must be');
  assert.ok(Math.abs(m.chrome - 52.6) < 0.01, `chrome ${m.chrome}, expected 52.6`);
  assert.ok(m.chrome >= 0, 'chrome can never be negative');
});

test('the wrong divisor really would overflow, and the right one does not', () => {
  // The same numbers carried through to the decision, so the fix is held at
  // the level that matters rather than only at the arithmetic.
  const rows = [77, ...Array(11).fill(41.4)];
  const boxHeight = 585;
  const common = { available: 1440, other: 900, total: 20, maxRules: 20 };
  const good = fitRuleCap({ ...common, ...ruleBoxMetrics(boxHeight, rows) });
  const bad = fitRuleCap({
    ...common, rowHeight: rows[0], chrome: boxHeight - rows.length * rows[0],
  });
  assert.ok(good < bad, `fixed cap ${good} is not below the buggy ${bad}`);
  // The fixed cap leaves the drawn panel inside the room it was given.
  const drawn = Math.min(good, common.total) + (common.total > good ? 1 : 0);
  const used = common.other + ruleBoxMetrics(boxHeight, rows).chrome + drawn * 77;
  assert.ok(used <= common.available, `fitted panel needs ${used} of 1440`);
});

test('ruleBoxMetrics refuses what it cannot measure', () => {
  assert.equal(ruleBoxMetrics(500, []), null);
  assert.equal(ruleBoxMetrics(500, [0, 0]), null);
  assert.equal(ruleBoxMetrics(0, [30]), null);
  assert.equal(ruleBoxMetrics(500, null), null);
});

test('a bad maxRules cannot blank the panel', () => {
  // rail.maxRules is schema-bounded 1..20, but rulePanel already defends its
  // own cap the same way and this is the same argument: a 0 or a NaN arriving
  // from anywhere must not mean "draw nothing".
  assert.equal(fitRuleCap({ ...BOX, total: 3, maxRules: 0 }), 3);
  assert.equal(fitRuleCap({ ...BOX, total: 3, maxRules: NaN }), 3);
});

test('rulePanel tags itself so the fitter can find it', () => {
  // The measurement needs to know which section is this panel. A class, not a
  // dataset write -- the DOM fake and a real HTMLElement disagree about that.
  const c = createClassCounter();
  const p = rulePanel([{ match: 'DE', color: '#111111' }], c, 1000, 5);
  assert.equal(p.id, 'rules');
});

test('the rail is measured by its content, not by its scroll height', () => {
  // THE BUG THIS EXISTS FOR, measured live at 2560x1440 against the real
  // container: three rules with `maxRules: 2` drew ONE rule row plus a
  // "+2 more", with ~315px of the rail standing empty below the foot.
  //
  // `measure()` derived `other` as `scrollHeight - boxHeight`. #rail is a flex
  // column whose `.rail-foot` carries `margin-top: auto`, so until content
  // genuinely exceeds the viewport there is nothing to scroll and
  // `scrollHeight === clientHeight`. That makes `available - other` collapse to
  // `boxHeight` -- the fitter hands the panel exactly the room it already
  // occupies, every time, and free space can never reach it. With rows of two
  // different heights (77px fired, 41.4px idle) `floor(boxHeight / 77)` then
  // undercounts, so the panel loses a row on every draw regardless of viewport.
  //
  // The content height is the sum of the rail's own children plus its gaps and
  // padding -- the flex slack the `margin-top: auto` opens up is deliberately
  // NOT part of it, since that slack is precisely the room being competed for.
  const kids = [40, 223, 347, 177, 171, 20];   // head, three panels, rules, foot
  const boxHeight = 171;
  const content = railContentHeight({ childHeights: kids, gap: 20.16, padding: 46 });
  assert.ok(Math.abs(content - 1124.8) < 0.5, `content measured ${content}`);

  const rows = [77, 41.4];
  const common = { available: 1440, other: content - boxHeight, total: 3, maxRules: 2 };
  assert.equal(fitRuleCap({ ...common, ...ruleBoxMetrics(boxHeight, rows) }), 2);

  // The old arithmetic, for the record: it reduces to 1 on the same numbers.
  const scrollHeight = 1440;                    // no overflow -> equals available
  assert.equal(fitRuleCap({
    ...common, other: scrollHeight - boxHeight, ...ruleBoxMetrics(boxHeight, rows),
  }), 1);
});

test('railContentHeight refuses what it cannot measure', () => {
  assert.equal(railContentHeight({ childHeights: [], gap: 10, padding: 4 }), 0);
  assert.equal(railContentHeight({ childHeights: null, gap: NaN, padding: NaN }), 0);
  // One child means no gap at all, not one gap.
  assert.equal(railContentHeight({ childHeights: [100], gap: 20, padding: 0 }), 100);
  assert.equal(railContentHeight({ childHeights: [100, 100], gap: 20, padding: 0 }), 220);
});

test('the health panel carries a lightning row when the layer is playing', () => {
  const out = panels({ feeds: { netflow: { ok: true, age: 3 } } },
                     null, null,
                     { bucket: '2026-08-15T06:50:00Z', count: 6000, age: 2280 });
  const health = out.find((p) => p.rows.some((r) => r.label === 'LIGHTNING'));
  assert.ok(health, 'no lightning row');
  const row = health.rows.find((r) => r.label === 'LIGHTNING');
  // The delay is the whole point of the row: a viewer must not be able to read
  // these strikes as current.
  assert.match(row.value, /38m behind/);
  assert.match(row.value, /6\.0k|6000/);
});

test('no lightning row at all when the layer is off or has no bucket', () => {
  for (const state of [null, undefined, { bucket: null, count: 0, age: null }]) {
    const out = panels({ feeds: { netflow: { ok: true, age: 3 } } }, null, null, state);
    const found = out.some((p) => p.rows.some((r) => r.label === 'LIGHTNING'));
    assert.equal(found, false);
  }
});
