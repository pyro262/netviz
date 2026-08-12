// Event -> which color rule claims it. Imports NOTHING: no three, no DOM, no
// config. The list is passed in, so precedence and address arithmetic are
// decided under `node --test` rather than by watching a wall and squinting at
// a color. Same discipline as campath.js and orbit.js.
//
// Replaces the three fixed highlight slots, which matched with
// `addr.startsWith(prefix)` -- a matcher that needs a trailing dot kept so
// '10.20.5.' does not claim 10.20.50.x, and an anchor so it does not claim
// 110.20.5.x. Both are arithmetic problems being solved with string surgery.

const PROTOS = { tcp: 6, udp: 17, icmp: 1 };

/** An address as a BigInt plus its family, or null.
 *
 *  v4 is kept in its OWN 32-bit space rather than normalised to a v4-mapped
 *  v6 address: a rule for 0.0.0.0/0 must not claim every IPv6 flow on the
 *  feed. `family` is what keeps those two apart. */
export function parseAddress(str) {
  if (typeof str !== 'string' || !str) return null;
  return str.includes(':') ? parseV6(str) : parseV4(str);
}

function parseV4(str) {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return { family: 4, n };
}

function parseV6(str) {
  let head = str;
  let tailBits = [];
  // An embedded v4 tail (::ffff:1.2.3.4) is written by real exporters, so the
  // two halves are parsed separately and joined as the low 32 bits.
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    head = str.slice(0, lastColon);
    tailBits = [Number(v4.n >> 16n), Number(v4.n & 0xffffn)];
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (s) => (s === '' ? [] : s.split(':').map((h) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return NaN;
    return parseInt(h, 16);
  }));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length - tailBits.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(Math.max(0, fill)).fill(0), ...right, ...Array(tailBits.length).fill(0)];
  } else {
    groups = left;
    // If there's an embedded v4 tail without compression, add placeholders for it
    if (tailBits.length) groups = [...groups, ...Array(tailBits.length).fill(0)];
  }
  if (tailBits.length) groups = [...groups.slice(0, groups.length - 2), ...tailBits];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return { family: 6, n };
}

function normaliseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return null;
}

function parseMatch(raw) {
  const s = String(raw).trim();

  if (s.includes('/') && !s.startsWith('tcp') && !s.startsWith('udp')
      && !s.startsWith('icmp')) {
    const [addr, bitsStr] = s.split('/');
    const a = parseAddress(addr);
    if (!a) return { reason: `not an address: ${addr}` };
    if (!/^\d{1,3}$/.test(bitsStr)) return { reason: `not a prefix length: /${bitsStr}` };
    const bits = Number(bitsStr);
    const width = a.family === 4 ? 32 : 128;
    if (bits > width) return { reason: `/${bits} is too long for IPv${a.family}` };
    // Host bits set are masked off, not refused: 10.20.50.7/24 is what somebody
    // types when they mean the /24 they are standing in.
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
    return { match: { kind: 'cidr', family: a.family, bits, base: a.n & mask, mask } };
  }

  if (s.includes('-')) {
    const [loStr, hiStr] = s.split('-');
    const lo = parseAddress(loStr.trim());
    const hi = parseAddress(hiStr.trim());
    if (!lo || !hi) return { reason: `not an address range: ${s}` };
    if (lo.family !== hi.family) return { reason: `range mixes IPv4 and IPv6: ${s}` };
    // Refused rather than sorted. Guessing which end was meant is how a
    // control starts lying.
    if (lo.n > hi.n) return { reason: `range runs backwards: ${s}` };
    return { match: { kind: 'range', family: lo.family, lo: lo.n, hi: hi.n } };
  }

  const port = /^(?:(tcp|udp|icmp)\/)?(\d{1,5})$/i.exec(s);
  if (port) {
    const n = Number(port[2]);
    if (n > 65535) return { reason: `not a port: ${port[2]}` };
    return { match: { kind: 'port', proto: port[1] ? PROTOS[port[1].toLowerCase()] : null,
                      port: n } };
  }

  if (/^[a-z-]{2}$/i.test(s)) return { match: { kind: 'country', code: s.toUpperCase() } };

  return { reason: `unrecognised matcher: ${s}` };
}

function bounded(v, lo, hi, name) {
  if (v === undefined || v === null) return { value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    return { reason: `${name} ${v} is outside ${lo}..${hi}` };
  }
  return { value: v };
}

/**
 * One rule, normalised -- or a reason it was refused.
 *
 * Returns `{rule}` or `{reason}`, never throws: one mistyped CIDR in a
 * forty-rule list must not blank the other thirty-nine. Same call apply.js's
 * executor makes.
 *
 * `gain` and `bloomScale` are left undefined when omitted rather than being
 * given a value here. The shipped highlight numbers live in config.js and
 * arcs.js reads them, so this file invents no defaults.
 */
export function parseRule(raw) {
  if (!raw || typeof raw !== 'object') return { reason: 'not a rule object' };
  if (raw.match === undefined || raw.match === null || raw.match === '') {
    return { reason: 'rule has no matcher' };
  }
  const m = parseMatch(raw.match);
  if (m.reason) return { reason: m.reason };

  const color = normaliseColor(raw.color);
  if (!color) return { reason: `not a hex color: ${raw.color}` };

  const end = raw.end === undefined ? 'either' : raw.end;
  if (!['src', 'dst', 'either'].includes(end)) return { reason: `not an end: ${raw.end}` };

  const gain = bounded(raw.gain, 0.05, 2.0, 'gain');
  if (gain.reason) return { reason: gain.reason };
  const bloomScale = bounded(raw.bloomScale, 0, 2.0, 'bloomScale');
  if (bloomScale.reason) return { reason: bloomScale.reason };

  return {
    rule: {
      match: m.match,
      end,
      color,
      // An empty name is the normal case, not a missing value: whatever
      // displays a rule renders the matcher itself, which is already
      // self-describing. Forcing a label produces "network 1".
      name: typeof raw.name === 'string' ? raw.name : '',
      gain: gain.value,
      bloomScale: bloomScale.value,
      enabled: raw.enabled !== false,
    },
  };
}

/** Both addresses parsed ONCE for this event, to be handed to every rule.
 *  Parsing inside matchRule would re-parse the same two strings once per rule
 *  per event -- the reason compilation and matching are separate at all. */
export function addrContext(ev) {
  return { s: parseAddress(ev && ev.s), d: parseAddress(ev && ev.d) };
}

function matchesAddr(m, a) {
  if (!a || a.family !== m.family) return false;
  if (m.kind === 'cidr') return (a.n & m.mask) === m.base;
  return a.n >= m.lo && a.n <= m.hi;
}

function matchesCountry(m, cc) {
  return typeof cc === 'string' && cc.toUpperCase() === m.code;
}

function matchesPort(m, port, proto) {
  // Absent means unknown, never 0: the collector omits the field entirely
  // when it does not know, because 0 is a real port.
  if (port === undefined || port === null) return false;
  if (m.proto !== null && proto !== m.proto) return false;
  return port === m.port;
}

/** Does this rule claim this event? `ctx` comes from addrContext(ev). */
export function matchRule(rule, ev, ctx) {
  const m = rule.match;
  const wantSrc = rule.end === 'src' || rule.end === 'either';
  const wantDst = rule.end === 'dst' || rule.end === 'either';
  if (m.kind === 'cidr' || m.kind === 'range') {
    return (wantSrc && matchesAddr(m, ctx.s)) || (wantDst && matchesAddr(m, ctx.d));
  }
  if (m.kind === 'country') {
    return (wantSrc && matchesCountry(m, ev.sc)) || (wantDst && matchesCountry(m, ev.dc));
  }
  return (wantSrc && matchesPort(m, ev.sp, ev.pr))
      || (wantDst && matchesPort(m, ev.dp, ev.pr));
}

/**
 * Parse a whole list once. Call this when the list changes -- never per event.
 *
 * Refused rules are reported by their index in the ORIGINAL list, so a message
 * about "rule 7" names the row somebody actually wrote. Accepted rules keep
 * their positions too, disabled ones included: position is precedence, so
 * turning a rule off must not renumber the rules after it.
 */
export function compileRules(list) {
  const rules = [];
  const refused = [];
  const raw = Array.isArray(list) ? list : [];
  raw.forEach((entry, index) => {
    const { rule, reason } = parseRule(entry);
    if (rule) rules.push(rule);
    else refused.push({ index, reason });
  });
  return { rules, refused };
}

/** Index of the first ENABLED rule claiming this event, or -1. */
export function firstMatch(compiled, ev) {
  if (!compiled || !compiled.rules.length || !ev) return -1;
  const ctx = addrContext(ev);
  for (let i = 0; i < compiled.rules.length; i += 1) {
    const rule = compiled.rules[i];
    if (rule.enabled && matchRule(rule, ev, ctx)) return i;
  }
  return -1;
}
