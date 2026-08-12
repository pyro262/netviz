import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFromNetworks } from '../../netviz/static/js/config.js';

test('a dotted prefix becomes the CIDR it was standing in for', () => {
  const { rules } = rulesFromNetworks([
    { prefix: '10.20.50.', label: 'storj', color: '#22d3ee', gain: 0.51 },
    { prefix: '192.168.', label: '', color: '#4ade80' },
    { prefix: '10.', label: '', color: '#a855f7' },
  ]);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].match, '10.20.50.0/24');
  assert.equal(rules[0].colour, '#22d3ee');
  assert.equal(rules[0].gain, 0.51);
  assert.equal(rules[0].name, 'storj');
  assert.equal(rules[1].match, '192.168.0.0/16');
  assert.equal(rules[2].match, '10.0.0.0/8');
});

test('an empty slot produces no rule at all', () => {
  // All three slots ship empty; the migration must not invent three rules
  // matching 0.0.0.0/0 out of them.
  const { rules, refused } = rulesFromNetworks([
    { prefix: '', color: '#a855f7' },
    { prefix: '', color: '#22d3ee' },
  ]);
  assert.equal(rules.length, 0);
  assert.equal(refused.length, 0);
});

test('a prefix that is not on an octet boundary is refused with a reason', () => {
  // Reported, not silently dropped: a network that stops being highlighted
  // with no message is indistinguishable from a network with no traffic.
  const { rules, refused } = rulesFromNetworks([{ prefix: '10.20.5', color: '#fff' }]);
  assert.equal(rules.length, 0);
  assert.equal(refused.length, 1);
  assert.match(refused[0].reason, /octet/i);
});

test('a slot with no colour takes the shipped colour for its position', () => {
  const { rules } = rulesFromNetworks([
    { prefix: '10.', label: '' },
    { prefix: '172.16.', label: '' },
  ]);
  assert.equal(rules[0].colour, '#a855f7');
  assert.equal(rules[1].colour, '#22d3ee');
});
