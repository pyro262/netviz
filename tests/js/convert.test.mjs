import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERTERS, pendingConversions, convertStored, stageConversion }
  from '../../netviz/static/js/convert.js';

const RULES = [{ match: '203.0.113.0/24', end: 'either', color: '#00ff88',
                 name: 'docs net', enabled: true }];

test('an old blob reads as the new path, in memory', () => {
  const { patch, pending } = convertStored({ 'arcs.rules': RULES,
                                             'rail.enabled': true });
  assert.deepEqual(patch['arcs.custom'], RULES);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'arcs.rules'), false);
  assert.equal(patch['rail.enabled'], true, 'untouched keys ride through');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'arcs.custom');
});

test('a blob already on the new path needs no conversion', () => {
  const { patch, pending } = convertStored({ 'arcs.custom': RULES });
  assert.deepEqual(patch['arcs.custom'], RULES);
  assert.equal(pending.length, 0);
});

test('the descriptor names the count, so the dialog cannot invent one', () => {
  const [c] = pendingConversions({ 'arcs.rules': RULES });
  assert.equal(c.count({ 'arcs.rules': RULES }), 1);
  assert.match(c.summary(1), /1 custom arc\b/);
  assert.match(c.summary(2), /2 custom arcs\b/);
});

test('staging validates only what the converter writes', () => {
  // `camera.nonsense` is not a schema path and is none of this conversion's
  // business: refusing over it would make the conversion uncompletable.
  const stored = { 'arcs.rules': RULES, 'camera.nonsense': 1 };
  const out = stageConversion(stored, pendingConversions(stored));
  assert.equal(out.ok, true);
  assert.deepEqual(out.next['arcs.custom'], RULES);
  assert.equal(out.next['camera.nonsense'], 1, 'left exactly as it was');
});

test('a bad entry refuses the whole conversion and leaves the original intact', () => {
  const stored = { 'arcs.rules': [{ match: 'not-a-matcher', color: '#fff' }] };
  const out = stageConversion(stored, pendingConversions(stored));
  assert.equal(out.ok, false);
  assert.equal(out.next, null);
  assert.match(out.error, /arcs\.custom/);
  assert.deepEqual(stored['arcs.rules'], [{ match: 'not-a-matcher', color: '#fff' }]);
});

test('convertStored does not mutate its input', () => {
  const stored = { 'arcs.rules': RULES };
  convertStored(stored);
  assert.deepEqual(Object.keys(stored), ['arcs.rules']);
});
