import test from 'node:test';
import assert from 'node:assert/strict';
import { panelRows, readyRules } from '../../netviz/static/js/rules_panel.js';

test('one row per rule, in list order, with its own validity', () => {
  const rows = panelRows([
    { match: '10.20.50.0/24', colour: '#22d3ee', name: 'storj' },
    { match: 'nonsense', colour: '#ffffff' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].index, 0);
  assert.equal(rows[0].match, '10.20.50.0/24');
  assert.equal(rows[0].name, 'storj');
  assert.equal(rows[0].reason, null);
  assert.equal(rows[1].index, 1);
  assert.match(rows[1].reason, /unrecognised/);
});

test('a refusal attaches to its own row and no other', () => {
  const rows = panelRows([
    { match: 'nonsense', colour: '#fff' },
    { match: 'DE', colour: '#fff' },
  ]);
  assert.ok(rows[0].reason);
  assert.equal(rows[1].reason, null);
});

test('defaults are filled in for display without being invented', () => {
  // `end` defaults to 'either' in rules.js; the panel shows what the engine
  // will do, not a blank that reads as "unset".
  const rows = panelRows([{ match: 'DE', colour: '#0f8' }]);
  assert.equal(rows[0].end, 'either');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].colour, '#00ff88');    // normalised through parseRule
});

test('a row that cannot parse keeps the text as typed', () => {
  // Re-rendering a half-typed matcher as anything other than what is in the
  // box would fight the person typing it.
  const rows = panelRows([{ match: '10.20.50.', colour: '#fff' }]);
  assert.equal(rows[0].match, '10.20.50.');
  assert.ok(rows[0].reason);
});

test('readyRules drops the rows that do not parse and keeps the order', () => {
  const list = [
    { match: '10.20.50.0/24', colour: '#22d3ee' },
    { match: 'nonsense', colour: '#ffffff' },
    { match: 'DE', colour: '#ff8800' },
  ];
  const ready = readyRules(panelRows(list));
  assert.equal(ready.length, 2);
  assert.equal(ready[0].match, '10.20.50.0/24');
  assert.equal(ready[1].match, 'DE');
});

test('a disabled row is ready and keeps its position', () => {
  // Position is precedence, so a disabled rule must still occupy its slot --
  // turning one off may not renumber, and therefore recolour, the rest.
  const ready = readyRules(panelRows([
    { match: '10.0.0.0/8', colour: '#111111', enabled: false },
    { match: 'DE', colour: '#222222' },
  ]));
  assert.equal(ready.length, 2);
  assert.equal(ready[0].enabled, false);
  assert.equal(ready[1].match, 'DE');
});

test('an empty list produces no rows and no error', () => {
  assert.deepEqual(panelRows([]), []);
  assert.deepEqual(readyRules([]), []);
  assert.deepEqual(panelRows(null), []);
});
