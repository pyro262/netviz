import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, parseRule } from '../../netviz/static/js/rules.js';

test('parseAddress reads IPv4 as a 32-bit number', () => {
  assert.equal(parseAddress('10.20.50.0').n, 0x0a143200n);
  assert.equal(parseAddress('255.255.255.255').n, 0xffffffffn);
  assert.equal(parseAddress('0.0.0.0').n, 0n);
  assert.equal(parseAddress('10.20.50.0').family, 4);
});

test('parseAddress refuses what is not an address', () => {
  // Every one of these reached the old string matcher and was compared with
  // startsWith, which cannot tell an address from a sentence.
  for (const bad of ['', '10.20.50', '10.20.50.256', '10.20.50.0.1', 'hello',
                     null, undefined, 42, '10.20.50.-1']) {
    assert.equal(parseAddress(bad), null, `${bad} should not parse`);
  }
});

test('parseAddress reads IPv6, including :: and an embedded v4 tail', () => {
  assert.equal(parseAddress('::1').n, 1n);
  assert.equal(parseAddress('2001:db8::').family, 6);
  assert.equal(parseAddress('2001:db8::1').n, 0x20010db8000000000000000000000001n);
  // The full form and the compressed form are the same number, or a rule
  // written one way silently misses traffic written the other.
  assert.equal(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001').n,
               parseAddress('2001:db8::1').n);
  assert.equal(parseAddress('::ffff:1.2.3.4').n, 0xffff01020304n);
});

test('an IPv4 address and its v6-mapped form are different numbers', () => {
  // Deliberate: a v4 rule must never claim v6 traffic. Normalising v4 into v6
  // space would make 0.0.0.0/0 match every IPv6 address on the feed.
  assert.notEqual(parseAddress('1.2.3.4').family, parseAddress('::ffff:1.2.3.4').family);
});

test('parseRule reads a CIDR rule and keeps the colour', () => {
  const { rule, reason } = parseRule({ match: '10.20.50.0/24', colour: '#22d3ee' });
  assert.equal(reason, undefined);
  assert.equal(rule.match.kind, 'cidr');
  assert.equal(rule.match.family, 4);
  assert.equal(rule.match.bits, 24);
  assert.equal(rule.colour, '#22d3ee');
  // Defaults that are NOT invented here: gain and bloomScale stay undefined so
  // arcs.js can supply the shipped highlight values. end and enabled are the
  // behaviour the prefix matcher already had.
  assert.equal(rule.gain, undefined);
  assert.equal(rule.bloomScale, undefined);
  assert.equal(rule.end, 'either');
  assert.equal(rule.enabled, true);
});

test('parseRule reads ranges, countries and ports', () => {
  const r1 = parseRule({ match: '203.0.113.10-203.0.113.40', colour: '#fff' }).rule;
  assert.equal(r1.match.kind, 'range');
  assert.equal(r1.match.lo, parseAddress('203.0.113.10').n);
  assert.equal(r1.match.hi, parseAddress('203.0.113.40').n);

  const r2 = parseRule({ match: 'de', colour: '#fff' }).rule;
  assert.equal(r2.match.kind, 'country');
  assert.equal(r2.match.code, 'DE');          // stored upper-case; sc/dc are upper-case

  const r3 = parseRule({ match: 'tcp/443', colour: '#fff' }).rule;
  assert.deepEqual(r3.match, { kind: 'port', proto: 6, port: 443 });

  const r4 = parseRule({ match: '51820', colour: '#fff' }).rule;
  assert.deepEqual(r4.match, { kind: 'port', proto: null, port: 51820 });
});

test('a reversed range is refused, not sorted', () => {
  // Guessing which end was meant is how a control starts lying -- the same
  // call orbit.validateZoomRange makes for a reversed zoom pair.
  const { rule, reason } = parseRule({ match: '203.0.113.40-203.0.113.10', colour: '#fff' });
  assert.equal(rule, undefined);
  assert.match(reason, /range/i);
});

test('every malformed rule gives a reason rather than throwing', () => {
  const bad = [
    { match: '10.20.50.0/33', colour: '#fff' },     // v4 has 32 bits
    { match: '2001:db8::/129', colour: '#fff' },
    { match: '10.20.50.0/24', colour: 'blue' },     // not a hex colour
    { match: '10.20.50.0/24' },                     // no colour at all
    { match: 'nonsense', colour: '#fff' },
    { match: '10.20.50.0-2001:db8::1', colour: '#fff' },  // mixed families
    { match: 'tcp/70000', colour: '#fff' },
    { colour: '#fff' },                             // no matcher
    null,
  ];
  for (const raw of bad) {
    const out = parseRule(raw);
    assert.equal(out.rule, undefined, `${JSON.stringify(raw)} should be refused`);
    assert.equal(typeof out.reason, 'string');
    assert.ok(out.reason.length > 0);
  }
});

test('host bits set in a CIDR are masked off rather than refused', () => {
  // 10.20.50.7/24 is what somebody types when they mean the /24 they are
  // standing in. Refusing it teaches nothing; masking it is what every
  // router does.
  const { rule } = parseRule({ match: '10.20.50.7/24', colour: '#fff' });
  assert.equal(rule.match.base, parseAddress('10.20.50.0').n);
});

test('gain and bloomScale are bounded, and out-of-range is refused', () => {
  assert.equal(parseRule({ match: 'DE', colour: '#fff', gain: 0.5 }).rule.gain, 0.5);
  assert.ok(parseRule({ match: 'DE', colour: '#fff', gain: 0 }).reason);
  assert.ok(parseRule({ match: 'DE', colour: '#fff', gain: 3 }).reason);
  assert.equal(parseRule({ match: 'DE', colour: '#fff', bloomScale: 0 }).rule.bloomScale, 0);
  assert.ok(parseRule({ match: 'DE', colour: '#fff', bloomScale: 2.5 }).reason);
});

test('a three-digit hex colour is accepted and normalised', () => {
  assert.equal(parseRule({ match: 'DE', colour: '#0f8' }).rule.colour, '#00ff88');
});
