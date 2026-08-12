import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, parseRule, compileRules, matchRule, firstMatch, addrContext }
  from '../../netviz/static/js/rules.js';

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

test('parseAddress reads uncompressed IPv6 with embedded v4 tail', () => {
  // A fully-expanded address with a v4 tail and no compression is legal:
  // 1:2:3:4:5:6 (6 hex groups) + 1.2.3.4 (v4 tail = 2 groups) = 8 groups total.
  const uncompressed = parseAddress('1:2:3:4:5:6:1.2.3.4');
  const explicit = parseAddress('1:2:3:4:5:6:0102:0304');
  assert.equal(uncompressed.n, explicit.n);
  assert.equal(uncompressed.family, 6);
});

test('parseAddress refuses too many groups with embedded v4 tail', () => {
  // 7 hex groups + v4 tail = 9 groups, which exceeds 8
  const result = parseAddress('1:2:3:4:5:6:7:1.2.3.4');
  assert.equal(result, null);
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

const flow = (s, d, extra = {}) => ({ k: 'flow', s, d, ...extra });
const one = (raw) => parseRule(raw).rule;
const hit = (raw, ev) => matchRule(one(raw), ev, addrContext(ev));

test('a CIDR matches inside its range and nothing outside it', () => {
  const r = { match: '10.20.50.0/24', colour: '#fff' };
  assert.equal(hit(r, flow('10.20.50.1', '8.8.8.8')), true);
  assert.equal(hit(r, flow('8.8.8.8', '10.20.50.255')), true);
  assert.equal(hit(r, flow('10.20.51.0', '8.8.8.8')), false);
  assert.equal(hit(r, flow('10.20.49.255', '8.8.8.8')), false);
});

test('the /24 that the string matcher got wrong', () => {
  // '10.0.5.' as a prefix claims nothing outside 10.0.5.x only because of a
  // trailing dot somebody has to remember. The arithmetic does not need it.
  const r = { match: '10.0.5.0/24', colour: '#fff' };
  assert.equal(hit(r, flow('10.0.50.1', '8.8.8.8')), false);
  assert.equal(hit(r, flow('110.0.5.1', '8.8.8.8')), false);
  assert.equal(hit(r, flow('10.0.5.1', '8.8.8.8')), true);
});

test('/32 and /0, and a v4 rule never claims v6', () => {
  assert.equal(hit({ match: '1.2.3.4/32', colour: '#fff' }, flow('1.2.3.4', '8.8.8.8')), true);
  assert.equal(hit({ match: '1.2.3.4/32', colour: '#fff' }, flow('1.2.3.5', '8.8.8.8')), false);
  assert.equal(hit({ match: '0.0.0.0/0', colour: '#fff' }, flow('203.0.113.1', '8.8.8.8')), true);
  assert.equal(hit({ match: '0.0.0.0/0', colour: '#fff' }, flow('2001:db8::1', '::1')), false);
});

test('IPv6 prefixes match on the compressed and the full form alike', () => {
  const r = { match: '2001:db8::/32', colour: '#fff' };
  assert.equal(hit(r, flow('2001:db8:1234::9', '::1')), true);
  assert.equal(hit(r, flow('2001:0db8:0000:0000:0000:0000:0000:0001', '::1')), true);
  assert.equal(hit(r, flow('2001:db9::1', '::1')), false);
});

test('a range is inclusive at both ends', () => {
  const r = { match: '203.0.113.10-203.0.113.40', colour: '#fff' };
  assert.equal(hit(r, flow('203.0.113.10', '8.8.8.8')), true);
  assert.equal(hit(r, flow('203.0.113.40', '8.8.8.8')), true);
  assert.equal(hit(r, flow('203.0.113.9', '8.8.8.8')), false);
  assert.equal(hit(r, flow('203.0.113.41', '8.8.8.8')), false);
});

test('end: src and dst test one end only', () => {
  const src = { match: '10.20.50.0/24', colour: '#fff', end: 'src' };
  const dst = { match: '10.20.50.0/24', colour: '#fff', end: 'dst' };
  assert.equal(hit(src, flow('10.20.50.1', '8.8.8.8')), true);
  assert.equal(hit(src, flow('8.8.8.8', '10.20.50.1')), false);
  assert.equal(hit(dst, flow('8.8.8.8', '10.20.50.1')), true);
  assert.equal(hit(dst, flow('10.20.50.1', '8.8.8.8')), false);
});

test('a country rule reads sc/dc and honours the end selector', () => {
  const r = { match: 'DE', colour: '#fff' };
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sc: 'DE', dc: 'US' })), true);
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sc: 'US', dc: 'DE' })), true);
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sc: 'US', dc: 'FR' })), false);
  const dst = { match: 'DE', colour: '#fff', end: 'dst' };
  assert.equal(hit(dst, flow('1.1.1.1', '2.2.2.2', { sc: 'DE', dc: 'US' })), false);
});

test('a port rule matches nothing when the event carries no ports', () => {
  // The collector OMITS sp/dp when unknown, because 0 is a real port. A rule
  // that matched an absent port would claim every flow from an exporter that
  // does not export ports.
  const r = { match: 'tcp/443', colour: '#fff' };
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sp: 51000, dp: 443, pr: 6 })), true);
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sp: 443, dp: 51000, pr: 6 })), true);
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2', { sp: 51000, dp: 443, pr: 17 })), false);
  assert.equal(hit(r, flow('1.1.1.1', '2.2.2.2')), false);
  const any = { match: '443', colour: '#fff' };
  assert.equal(hit(any, flow('1.1.1.1', '2.2.2.2', { sp: 51000, dp: 443, pr: 17 })), true);
});

test('compileRules keeps the good rules and reports the bad by index', () => {
  const c = compileRules([
    { match: '10.20.50.0/24', colour: '#22d3ee' },
    { match: 'nonsense', colour: '#fff' },
    { match: 'DE', colour: '#4ade80' },
  ]);
  assert.equal(c.rules.length, 2);
  assert.equal(c.refused.length, 1);
  assert.equal(c.refused[0].index, 1);
  assert.match(c.refused[0].reason, /unrecognised/);
});

test('first enabled match wins, in list order', () => {
  const c = compileRules([
    { match: '10.0.0.0/8', colour: '#111111' },
    { match: '10.20.50.0/24', colour: '#222222' },
  ]);
  const ev = flow('10.20.50.1', '8.8.8.8');
  assert.equal(firstMatch(c, ev), 0);              // the broader rule is first, so it wins
  assert.equal(c.rules[firstMatch(c, ev)].colour, '#111111');
});

test('a disabled rule is skipped without shifting the rules after it', () => {
  // Position is precedence, so a disabled rule must keep its slot: turning a
  // rule off may not silently renumber -- and therefore recolour -- the rest.
  const c = compileRules([
    { match: '10.0.0.0/8', colour: '#111111', enabled: false },
    { match: '10.20.50.0/24', colour: '#222222' },
  ]);
  assert.equal(c.rules.length, 2);
  assert.equal(firstMatch(c, flow('10.20.50.1', '8.8.8.8')), 1);
  assert.equal(firstMatch(c, flow('10.1.1.1', '8.8.8.8')), -1);
});

test('no match at all is -1, and an empty list matches nothing', () => {
  assert.equal(firstMatch(compileRules([]), flow('1.1.1.1', '2.2.2.2')), -1);
  const c = compileRules([{ match: 'DE', colour: '#fff' }]);
  assert.equal(firstMatch(c, flow('1.1.1.1', '2.2.2.2', { sc: 'US', dc: 'US' })), -1);
});

test('addrContext parses each address once, not once per rule', () => {
  // The whole reason compile and match are separate. If this ever regresses
  // to parsing inside matchRule, a 200-rule list parses 400 addresses per
  // event at ~57 events/sec.
  const ev = flow('10.20.50.1', '8.8.8.8');
  const ctx = addrContext(ev);
  assert.equal(ctx.s.n, parseAddress('10.20.50.1').n);
  assert.equal(ctx.d.family, 4);
  assert.equal(addrContext({ k: 'flow' }).s, null);
});
