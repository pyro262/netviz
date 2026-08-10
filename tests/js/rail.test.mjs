import test from 'node:test';
import assert from 'node:assert/strict';

import {
  railEnabled, formatCount, formatLag, formatPercent, formatAge, formatClock, panels,
} from '../../netviz/static/js/rail.js';

test('rail is off by default', () => {
  assert.equal(railEnabled(''), false);
  assert.equal(railEnabled('?quality=high'), false);
});

test('?rail turns it on in every spelling a person would try', () => {
  for (const q of ['?rail', '?rail=1', '?rail=true', '?rail=on', '?rail=YES']) {
    assert.equal(railEnabled(q), true, q);
  }
});

test('?rail=0 turns it off even when the site default is on', () => {
  for (const q of ['?rail=0', '?rail=false', '?rail=off', '?rail=no']) {
    assert.equal(railEnabled(q, true), false, q);
  }
});

test('an unrecognised value falls back rather than guessing', () => {
  assert.equal(railEnabled('?rail=maybe', true), true);
  assert.equal(railEnabled('?rail=maybe', false), false);
});

test('the config default applies when the URL says nothing', () => {
  assert.equal(railEnabled('', true), true);
  assert.equal(railEnabled('?other=1', true), true);
});

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
