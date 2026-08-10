import test from 'node:test';
import assert from 'node:assert/strict';

import { updateAvailable, updateLabel } from '../../netviz/static/js/update.js';

test('shows when the collector reports an update', () => {
  assert.equal(updateAvailable({ stamp: 'x', update: { available: true } }), true);
});

test('stays hidden when the collector reports none', () => {
  assert.equal(updateAvailable({ stamp: 'x', update: { available: false } }), false);
});

test('stays hidden for a collector too old to serve the field', () => {
  // The field is new; an older collector serves only { stamp }.
  assert.equal(updateAvailable({ stamp: 'x' }), false);
});

test('stays hidden for a failed poll or a malformed body', () => {
  // An indicator that appears when something breaks is one everyone learns
  // to ignore.
  for (const bad of [null, undefined, 'nope', 42, {}, { update: null }, { update: 'yes' }]) {
    assert.equal(updateAvailable(bad), false);
  }
});

test('requires available to be exactly true, not merely truthy', () => {
  assert.equal(updateAvailable({ update: { available: 'yes' } }), false);
  assert.equal(updateAvailable({ update: { available: 1 } }), false);
});

test('the label carries the tag when there is one', () => {
  assert.equal(updateLabel({ update: { available: true, latest: 'v0.4.0' } }),
               'UPDATE AVAILABLE v0.4.0');
});

test('a missing tag never blanks the label', () => {
  assert.equal(updateLabel({ update: { available: true } }), 'UPDATE AVAILABLE');
  assert.equal(updateLabel({ update: { available: true, latest: '' } }), 'UPDATE AVAILABLE');
  assert.equal(updateLabel({ update: { available: true, latest: 7 } }), 'UPDATE AVAILABLE');
});

test('no label at all when there is no update', () => {
  assert.equal(updateLabel({ update: { available: false, latest: 'v0.4.0' } }), null);
  assert.equal(updateLabel(null), null);
});
