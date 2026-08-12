// Which visual class an event belongs to. Kept free of three.js so it runs
// under `node --test` -- arcs.js only maps the returned name to a spec.
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classNameFor, isDns, isHighlighted, highlightSlot, foreignEnd,
  isResolverAddress,
} from '../../netviz/static/js/classify.js';
import { CONFIG, mergeServerConfig } from '../../netviz/static/js/config.js';

// The highlight slots ship with empty prefixes -- they mean nothing until
// someone names their own networks, and the prefixes come from the collector's
// /config.json rather than from this tracked file. Set them for the tests that
// are about them.
function withHighlights(prefixes, fn) {
  const saved = CONFIG.highlight.networks.map((n) => ({ ...n }));
  CONFIG.highlight.networks = saved.map((n, i) => ({
    ...n, prefix: prefixes[i] === undefined ? '' : prefixes[i],
  }));
  try { fn(); } finally { CONFIG.highlight.networks = saved; }
}

function withHighlight(prefix, fn) {
  return withHighlights([prefix], fn);
}

test('a plain flow is a flow', () => {
  assert.equal(classNameFor({ k: 'flow', s: '192.168.0.20', d: '8.8.8.8' }), 'flow');
});

test('a flow from the highlighted network is highlighted', () => {
  withHighlight('10.10.10.', () => {
    assert.equal(classNameFor({ k: 'flow', s: '10.10.10.7', d: '8.8.8.8' }), 'highlight1');
  });
});

test('a flow TO the highlighted network is highlighted too', () => {
  withHighlight('10.10.10.', () => {
    assert.equal(classNameFor({ k: 'flow', s: '203.0.113.9', d: '10.10.10.12' }), 'highlight1');
  });
});

test('a block stays a block even on the highlighted network', () => {
  // The wall exists to show blocks. Recolouring one because of which network it
  // touched would hide the alarm inside the ambient layer.
  withHighlight('10.10.10.', () => {
    assert.equal(classNameFor({ k: 'block', s: '10.10.10.7', d: '1.2.3.4' }), 'block');
  });
});

test('with no prefixes configured everything is a flow', () => {
  // Asserts the behaviour, not the shipped default -- this file must pass in a
  // deployment that has legitimately configured its networks.
  withHighlights(['', '', ''], () => {
    assert.equal(classNameFor({ k: 'flow', s: '10.10.10.7', d: '8.8.8.8' }), 'flow');
    assert.equal(isHighlighted('10.10.10.7'), false);
  });
});

test('each network gets its own class name', () => {
  withHighlights(['10.10.10.', '10.10.20.', '10.10.30.'], () => {
    assert.equal(classNameFor({ k: 'flow', s: '10.10.10.7', d: '8.8.8.8' }), 'highlight1');
    assert.equal(classNameFor({ k: 'flow', s: '10.10.20.7', d: '8.8.8.8' }), 'highlight2');
    assert.equal(classNameFor({ k: 'flow', s: '10.10.30.7', d: '8.8.8.8' }), 'highlight3');
  });
});

test('an empty slot does not renumber the ones after it', () => {
  // Slot 2 must stay slot 2, and keep its colour, whether or not slot 1 is in
  // use -- otherwise turning one network off silently recolours another.
  withHighlights(['', '10.10.20.', ''], () => {
    assert.equal(highlightSlot('10.10.20.7'), 2);
    assert.equal(classNameFor({ k: 'flow', s: '10.10.20.7', d: '8.8.8.8' }), 'highlight2');
  });
});

test('overlapping prefixes take the lower slot, not iteration order', () => {
  withHighlights(['10.10.', '10.10.20.'], () => {
    assert.equal(highlightSlot('10.10.20.7'), 1);
  });
});

test('the collector\'s slots migrate into colour rules', () => {
  // The three NETVIZ_HIGHLIGHT* slots are converted for one release. An empty
  // slot contributes nothing rather than a rule matching everything.
  const saved = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [];
  try {
    mergeServerConfig({ highlight: { networks: [
      { prefix: '172.20.5.', label: 'lab', color: '#ff0000' },
      { prefix: '' },
    ] } });
    assert.equal(CONFIG.arcs.rules.length, 1);
    assert.equal(CONFIG.arcs.rules[0].match, '172.20.5.0/24');
    assert.equal(CONFIG.arcs.rules[0].colour, '#ff0000');
    assert.equal(CONFIG.arcs.rules[0].name, 'lab');
  } finally {
    CONFIG.arcs.rules = saved;
  }
});

test('a display with its own rules is not overwritten by the environment', () => {
  // A configured list is the display's own decision: the migration fills an
  // empty list and never appends to a populated one.
  const saved = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [{ match: '10.0.0.0/8', colour: '#123456' }];
  try {
    mergeServerConfig({ highlight: { networks: [{ prefix: '172.20.5.' }] } });
    assert.equal(CONFIG.arcs.rules.length, 1);
    assert.equal(CONFIG.arcs.rules[0].match, '10.0.0.0/8');
  } finally {
    CONFIG.arcs.rules = saved;
  }
});

test('a malformed server config leaves the local one alone', () => {
  const saved = CONFIG.arcs.rules;
  CONFIG.arcs.rules = [];
  try {
    mergeServerConfig(null);
    mergeServerConfig({});
    mergeServerConfig({ highlight: { networks: 'nope' } });
    assert.equal(CONFIG.arcs.rules.length, 0);
  } finally {
    CONFIG.arcs.rules = saved;
  }
});

test('an unknown kind falls back to flow', () => {
  assert.equal(classNameFor({ k: 'wat', s: '1.2.3.4', d: '5.6.7.8' }), 'flow');
});

test('missing addresses do not throw', () => {
  assert.equal(classNameFor({ k: 'flow' }), 'flow');
  assert.equal(classNameFor({}), 'flow');
});

test('the prefix match is anchored -- 110.10.10.x is not a match', () => {
  withHighlight('10.10.10.', () => {
    assert.equal(isHighlighted('110.10.10.4'), false);
    assert.equal(isHighlighted('10.10.10.4'), true);
    assert.equal(isHighlighted('10.10.100.4'), false);
  });
});

test('other private ranges are not highlighted', () => {
  withHighlight('10.10.10.', () => {
    assert.equal(isHighlighted('192.168.0.50'), false);
    assert.equal(isHighlighted('10.10.11.4'), false);
  });
});

test('an empty prefix matches nothing', () => {
  withHighlight('', () => {
    assert.equal(isHighlighted('10.10.10.4'), false);
    assert.equal(isHighlighted('anything'), false);
  });
});

test('DNS is identified from either end of the flow', () => {
  // Resolvers answer FROM 53, clients query TO 53. Both directions appear on
  // the feed, so matching one end only would miss half of it.
  assert.equal(isDns({ k: 'flow', sp: 41234, dp: 53 }), true);
  assert.equal(isDns({ k: 'flow', sp: 53, dp: 41234 }), true);
  assert.equal(isDns({ k: 'flow', sp: 44321, dp: 853 }), true);   // DNS-over-TLS
  assert.equal(isDns({ k: 'flow', sp: 5353, dp: 5353 }), true);   // mDNS
});

test('ordinary traffic is not DNS', () => {
  assert.equal(isDns({ k: 'flow', sp: 44321, dp: 443 }), false);
  assert.equal(isDns({ k: 'flow', sp: 22, dp: 51234 }), false);
});

test('an event without ports is not claimed as DNS', () => {
  // Absent ports mean unknown, not port zero. Guessing here would silently
  // drop real arcs from any source that does not carry ports.
  assert.equal(isDns({ k: 'flow' }), false);
  assert.equal(isDns(null), false);
});

test('a block is never suppressed as DNS', () => {
  // Same rule as the highlight reclassification: the wall exists to show blocks,
  // and a blocked DNS query is exactly the kind of thing worth seeing.
  assert.equal(isDns({ k: 'block', sp: 41234, dp: 53 }), false);
});

// --- which end of a block is the country? ----------------------------------
//
// Sampled from the live feed 2026-08-09: every block on this router is
// outbound, so `sc` is "--" and `sll` is home. Reading the source gives
// the home site, which is why the country flash never fired and why the camera
// detour would have flown home instead of to the blocked country.

test('an outbound block names its destination country', () => {
  const ev = { k: 'block', sc: '--', dc: 'IN',
               sll: [30.3, -97.7], dll: [18.5211, 73.8502] };
  const end = foreignEnd(ev);
  assert.equal(end.country, 'IN');
  assert.equal(end.lat, 18.5211);
  assert.equal(end.lon, 73.8502);
});

test('an inbound block names its source country', () => {
  const ev = { k: 'block', sc: 'CN', dc: '--',
               sll: [35, 105], dll: [30.3, -97.7] };
  const end = foreignEnd(ev);
  assert.equal(end.country, 'CN');
  assert.equal(end.lat, 35);
});

test('with both ends placed, the destination wins', () => {
  const ev = { sc: 'DE', dc: 'CN', sll: [51, 9], dll: [35, 105] };
  assert.equal(foreignEnd(ev).country, 'CN');
});

test('an unplaceable event has no foreign end at all', () => {
  assert.equal(foreignEnd({ sc: '--', dc: '--', sll: [0, 0], dll: [1, 1] }), null);
  assert.equal(foreignEnd({ sc: '', dc: null, sll: [0, 0], dll: [1, 1] }), null);
  assert.equal(foreignEnd(null), null);
});

test('a country code with no coordinates is not usable', () => {
  assert.equal(foreignEnd({ dc: 'CN' }), null);
});

// --- public resolvers -------------------------------------------------------
//
// The port rule already covers plain DNS and DNS-over-TLS, which is every query
// a local recursive resolver sends to the root and authoritative servers. This
// is for what it cannot see: DNS-over-HTTPS on 443, and exporters that omit
// ports entirely.

describe('isResolverAddress', () => {
  it('catches DNS-over-HTTPS to a public resolver on port 443', () => {
    const ev = { k: 'flow', s: '10.0.0.5', d: '1.1.1.1', sp: 51234, dp: 443 };
    // 443 is deliberately not in traffic.dnsPorts -- that is the whole gap.
    assert.equal(CONFIG.traffic.dnsPorts.includes(443), false);
    assert.equal(isResolverAddress(ev), true);
    assert.equal(isDns(ev), true, 'the display gate must drop it too');
  });

  it('catches the resolver as the source as well as the destination', () => {
    assert.equal(isResolverAddress(
      { k: 'flow', s: '8.8.4.4', d: '10.0.0.5', sp: 443, dp: 51234 }), true);
  });

  it('matches an IPv6 resolver by prefix', () => {
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '2606:4700:4700::1111' }), true);
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '2001:4860:4860::8888' }), true);
  });

  it('is case insensitive for IPv6', () => {
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '2606:4700:4700::1111'.toUpperCase() }), true);
  });

  it('anchors a prefix at the start', () => {
    // 145.90.28.1 must not match the NextDNS prefix 45.90.28.
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '145.90.28.1' }), false);
  });

  it('does not match an address that merely starts the same', () => {
    // 1.1.1.10 is not 1.1.1.1: a whole-address entry must match whole.
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '1.1.1.10' }), false);
  });

  it('leaves ordinary web traffic alone', () => {
    assert.equal(isResolverAddress(
      { k: 'flow', s: '10.0.0.5', d: '93.184.216.34', dp: 443 }), false);
  });

  it('never claims a block, whichever resolver it touched', () => {
    // Same rule as DNS: the wall exists to show blocks.
    assert.equal(isResolverAddress(
      { k: 'block', s: '10.0.0.5', d: '1.1.1.1' }), false);
    assert.equal(isDns({ k: 'block', s: '10.0.0.5', d: '1.1.1.1' }), false);
  });

  it('can be turned off', () => {
    CONFIG.traffic.dropResolvers = false;
    try {
      assert.equal(isResolverAddress(
        { k: 'flow', s: '10.0.0.5', d: '1.1.1.1', dp: 443 }), false);
    } finally {
      CONFIG.traffic.dropResolvers = true;
    }
  });

  it('honours a user-supplied addition', () => {
    CONFIG.traffic.extraResolvers = ['203.0.113.53'];
    try {
      assert.equal(isResolverAddress(
        { k: 'flow', s: '10.0.0.5', d: '203.0.113.53', dp: 443 }), true);
    } finally {
      CONFIG.traffic.extraResolvers = [];
    }
  });

  it('tolerates a missing address', () => {
    assert.equal(isResolverAddress({ k: 'flow', d: '1.1.1.1' }), true);
    assert.equal(isResolverAddress({ k: 'flow' }), false);
    assert.equal(isResolverAddress(null), false);
  });
});
