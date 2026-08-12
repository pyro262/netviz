import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassCounter, ruleKey } from '../../netviz/static/js/classcount.js';

test('the rate is per minute over the rate window', () => {
  const c = createClassCounter();
  for (let i = 0; i < 30; i += 1) c.add('rule1', 1000 + i * 1000);
  // 30 events across the 60s window is 30/min.
  assert.equal(Math.round(c.ratePerMin('rule1', 31000)), 30);
});

test('a lapped slot is cleared rather than counted for ever', () => {
  // Without the absolute-bucket check an hour-old count survives indefinitely
  // as long as traffic keeps landing on the same slot index. This is the same
  // discipline netviz/stats.py's RollingCounter uses.
  const c = createClassCounter();
  c.add('rule1', 1000);
  assert.equal(c.ratePerMin('rule1', 2000) > 0, true);
  assert.equal(c.ratePerMin('rule1', 1000 + 10 * 60 * 1000), 0);
});

test('an hour with no events yields no sparkline at all', () => {
  // A flat line at zero is a claim, and it is exactly what a broken series
  // looks like. The rail draws nothing instead.
  const c = createClassCounter();
  assert.equal(c.spark('rule1', 60000), null);
});

test('the sparkline is oldest-first and covers the hour', () => {
  const c = createClassCounter();
  const t = 3600000;
  c.add('rule1', t - 30 * 60 * 1000);
  c.add('rule1', t - 1000);
  const s = c.spark('rule1', t);
  assert.equal(s.length, 20);
  assert.equal(s[s.length - 1] >= 1, true, 'the newest slot holds the newest event');
});

test('classes are counted independently', () => {
  const c = createClassCounter();
  c.add('rule1', 1000);
  c.add('rule2', 1000);
  c.add('rule2', 1500);
  assert.equal(c.ratePerMin('rule2', 2000), 2 * c.ratePerMin('rule1', 2000));
});

test('setKeys drops the history of a class that no longer exists', () => {
  // Deleting rule 1 must not hand its history to rule 2: the rows are keyed by
  // what the rule MATCHES, so a number that was about one rule can never be
  // shown beside another.
  const c = createClassCounter();
  c.add('rule1', 1000);
  c.add('rule2', 1000);
  c.setKeys(['rule2']);
  assert.equal(c.ratePerMin('rule1', 2000), 0);
  assert.equal(c.ratePerMin('rule2', 2000) > 0, true);
});

test('ruleKey ignores colour and name, so a recolour keeps its history', () => {
  assert.equal(ruleKey({ match: 'DE', end: 'dst', color: '#fff' }),
               ruleKey({ match: 'DE', end: 'dst', color: '#000', name: 'x' }));
  assert.notEqual(ruleKey({ match: 'DE', end: 'dst' }), ruleKey({ match: 'DE', end: 'src' }));
});
