// Event -> visual class name. No three.js import, so it stays testable under
// `node --test`; arcs.js owns the name -> spec mapping.
//
// Wire format is the collector's short keys: k (kind), s/d (addresses).

import { cfg } from './config.js';

/** The configured networks, in slot order. Slots with no prefix are kept in
 *  place: slot 2 must stay slot 2 (and keep its colour) whether or not slot 1
 *  is in use, or turning one network off would silently recolour another. */
// Config is read per call rather than captured at import. It costs a couple of
// property lookups per event -- nothing at this event rate -- and it means the
// collector's /config.json can be merged in after modules have loaded.
export function highlightNetworks() {
  const nets = cfg('highlight.networks', []);
  return Array.isArray(nets) ? nets : [];
}

/**
 * Which highlighted network an address belongs to: a 1-based slot number, or
 * 0 for none.
 *
 * Prefixes are matched with an explicit dot boundary the caller supplies: a
 * bare startsWith('10.0.5') would also claim 10.0.50.x, and dropping the
 * leading anchor would claim 110.0.5.x. Keep the trailing dot.
 *
 * First match wins, so an address inside two overlapping prefixes takes the
 * lower slot rather than depending on iteration order.
 */
export function highlightSlot(addr) {
  if (typeof addr !== 'string') return 0;
  const nets = highlightNetworks();
  for (let i = 0; i < nets.length; i += 1) {
    const prefix = nets[i] && nets[i].prefix;
    if (prefix && addr.startsWith(prefix)) return i + 1;
  }
  return 0;
}

/** Is this address on any highlighted network? */
export function isHighlighted(addr) {
  return highlightSlot(addr) > 0;
}

/** Nameserver ports: 53 plain, 853 DNS-over-TLS, 5353 mDNS. */
function isDnsPort(port) {
  return cfg('traffic.dnsPorts', [53, 853, 5353]).includes(port);
}

/** Is this event DNS chatter rather than data traffic?
 *
 *  Measured on the real feed: nameserver traffic is 33% of all events and 5.7%
 *  of the bytes, and effectively all of it geolocates to MaxMind's US country
 *  centroid (37.751, -97.822, in Kansas) because GeoLite2 has no city record
 *  for anycast resolvers. Drawn, it is a third of the arcs on the wall all
 *  pointing at one fictional place.
 *
 *  Either end counts: resolvers answer FROM 53 and clients query TO 53, and
 *  both directions are on the feed. Absent ports mean unknown, never port 0 --
 *  a source that carries no ports must keep its arcs. */
export function isDns(ev) {
  if (!ev || ev.k === 'block') return false;   // blocks are never suppressed
  if (cfg('traffic.dropDns', true) && (isDnsPort(ev.sp) || isDnsPort(ev.dp))) {
    return true;
  }
  return isResolverAddress(ev);
}

/** Does this address belong to a known public resolver?
 *
 *  An entry ending in `.` or `:` is a prefix and matches anything under it;
 *  anything else must match the whole address. IPv6 is compared lower-case and
 *  as written -- the collector passes the address through from the exporter, so
 *  this will not catch an unusual expansion of the same address. The prefixes
 *  cover the cases that matter.
 */
export function isResolverAddress(ev) {
  if (!cfg('traffic.dropResolvers', true)) return false;
  if (!ev || ev.k === 'block') return false;
  const list = cfg('traffic.resolvers', []).concat(cfg('traffic.extraResolvers', []));
  return matchesAny(ev.s, list) || matchesAny(ev.d, list);
}

function matchesAny(addr, list) {
  if (typeof addr !== 'string' || !addr) return false;
  const a = addr.toLowerCase();
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry) continue;
    const e = entry.toLowerCase();
    if (e.endsWith('.') || e.endsWith(':')) {
      if (a.startsWith(e)) return true;
    } else if (a === e) {
      return true;
    }
  }
  return false;
}

/** A country code the collector could actually place. `--` is what GeoIP
 *  returns for a private or unplaceable address, and the empty string and null
 *  both occur; none of them name a country. */
function realCountry(cc) {
  return typeof cc === 'string' && cc.length === 2 && cc !== '--';
}

/**
 * The far end of an event: `{country, lat, lon}`, or null if neither end is
 * placeable.
 *
 * Do not assume which end is foreign. On a router whose geo policies are
 * outbound, the source is a LAN address (`sc: "--"`, `sll` = home) and the
 * blocked country is the DESTINATION; reading `sc` gives `--` and home's own
 * coordinates, so the country flash never fires and the camera detour flies
 * home instead of to the blocked country. Inbound blocks are the mirror image
 * and the same rule handles both: take the end that is a real country,
 * preferring the destination when both are.
 */
export function foreignEnd(ev) {
  if (!ev) return null;
  if (realCountry(ev.dc) && ev.dll) {
    return { country: ev.dc, lat: ev.dll[0], lon: ev.dll[1] };
  }
  if (realCountry(ev.sc) && ev.sll) {
    return { country: ev.sc, lat: ev.sll[0], lon: ev.sll[1] };
  }
  return null;
}

/** Blocks are never reclassified: the wall exists to show them, and tinting one
 *  by which network it touched would bury the alarm in the ambient layer. */
export function classNameFor(ev) {
  if (!ev) return 'flow';
  if (ev.k === 'block') return 'block';
  // Either end: traffic to a highlighted network is as interesting as traffic
  // from it. The source is checked first so a flow between two highlighted
  // networks is attributed consistently rather than by field order.
  const slot = highlightSlot(ev.s) || highlightSlot(ev.d);
  return slot ? `highlight${slot}` : 'flow';
}
