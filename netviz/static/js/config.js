// Everything you are likely to want to change lives here.
//
// This file is plain data with no imports, so it stays readable and every other
// module -- including the ones that run under `node --test` without a browser --
// can import it. Edit, then reload the page; the kiosk also reloads itself
// within ~30s of a changed file (see BUILD_POLL in this file).
//
// Nothing here is required: delete a key and the built-in default is used.

export const CONFIG = {

  // Filled in from the collector's /config.json, which reads NETVIZ_HOME_LAT /
  // NETVIZ_HOME_LON. Null until then, and null is handled: the star day/night
  // ramp is simply not applied without a position to compute sunrise for.
  home: null,

  // ---------------------------------------------------------------- traffic --
  //
  // The renderer never sees your IP addresses' locations -- the collector
  // geolocates first and sends coordinates. Set the home position with
  // NETVIZ_HOME_LAT / NETVIZ_HOME_LON in .env, not here.

  traffic: {
    // The live feed can run tens of events per second. Every arc is a tube
    // blending additively, so drawing all of them sums into a wash that hides
    // the globe. Flows are sampled to this rate; blocks are never dropped.
    // Raise it if your network is quiet, lower it if the globe disappears.
    flowsPerSecond: 14,

    // Drop nameserver chatter from the display. On most networks this is 20-30%
    // of events and almost none of the bytes, and it nearly all geolocates to
    // one country-centroid point, so undropped it draws as a crowd of arcs
    // converging somewhere nothing actually is. The collector still records it.
    dropDns: true,
    dnsPorts: [53, 853, 5353],   // 53 plain, 853 DNS-over-TLS, 5353 mDNS

    // Also drop anything to or from a known public resolver, whatever port it
    // is on. The port rule above already catches plain DNS and DNS-over-TLS,
    // including every query a local recursive resolver such as unbound sends to
    // the root and authoritative servers -- those are port 53 by definition.
    // What it cannot catch is DNS-over-HTTPS, which is port 443 and looks
    // exactly like web traffic, and any exporter that omits ports.
    //
    // This matters most on DB-IP, which answers for every address and places
    // anycast resolvers at a registrant country rather than declining to guess:
    // Cloudflare and Google both land in Canada. GeoLite2 declines instead, so
    // those arcs are dropped for a different reason. Either way they are not
    // where the display implies.
    //
    // An entry ending in `.` or `:` is a prefix; anything else is matched whole.
    dropResolvers: true,
    resolvers: [
      '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', '1.1.1.3', '1.0.0.3',
      '2606:4700:4700:',                                      // Cloudflare
      '8.8.8.8', '8.8.4.4', '2001:4860:4860:',                 // Google
      '9.9.9.9', '9.9.9.10', '9.9.9.11', '149.112.112.',
      '2620:fe:',                                             // Quad9
      '208.67.222.222', '208.67.220.220', '208.67.222.123',
      '208.67.220.123', '2620:119:',                          // OpenDNS
      '94.140.14.14', '94.140.15.15', '94.140.14.15', '94.140.15.16',
      '2a10:50c0:',                                           // AdGuard
      '45.90.28.', '45.90.30.', '2a07:a8c0:', '2a07:a8c1:',    // NextDNS
      '76.76.2.', '76.76.10.', '2606:1a40:',                   // Control D
      '185.228.168.', '185.228.169.', '2a0d:2a00:',            // CleanBrowsing
      '4.2.2.1', '4.2.2.2', '4.2.2.3', '4.2.2.4',              // Level3
      '64.6.64.6', '64.6.65.6',                                // Verisign
      '8.26.56.26', '8.20.247.20',                             // Comodo
      '77.88.8.8', '77.88.8.1',                                // Yandex
      '156.154.70.1', '156.154.71.1',                          // Neustar
      '114.114.114.114', '223.5.5.5', '223.6.6.6',
      '119.29.29.29',                                          // CN resolvers
    ],
    // Your own additions -- an upstream your resolver forwards to, a provider
    // resolver, anything the list above misses. Same matching rules.
    extraResolvers: [],
  },

  // ----------------------------------------------------------------- arcs --
  //
  // life      seconds on screen
  // tube      radius of the tube, in globe radii
  // colorAt   position on the plasma ramp, 0 (indigo) to 1 (pale yellow)
  // color     an explicit hex, used instead of colorAt when present
  // gain      multiplies the colour down; the wall usually wants less than 1
  // speed     how fast the head travels
  // lift      apex height, scaled by how far the arc travels
  // maxRise   hard cap on the apex, in globe radii -- an uncapped long arc
  //           towers over the limb
  // bloomScale  glow only: 1 leaves the halo alone, 0.5 halves it, >1 lifts it.
  //           Use this rather than `gain` when the line looks right but the
  //           halo shouts.

  arcs: {
    bodyOpacity: 0.18,

    flow:  { life: 4.0,  tube: 0.0032, colorAt: 0.30, gain: 1.0,
             speed: 0.9,  lift: 0.28, maxRise: 0.24, bloomScale: 1.25 },

    block: { life: 18.0, tube: 0.0052, colorAt: 0.86, gain: 0.74,
             speed: 0.55, lift: 0.45, maxRise: 0.21, bloomScale: 0.5 },

    // Shape shared by every colour rule. Colour, gain and bloomScale come from
    // the rule; everything here is the geometry they all share.
    //
    // `gain` is here rather than on each rule so a rule that omits it has one
    // place to read from. 0.70 is what highlight slot 1 has always shipped --
    // not a new judgement, just moved up to the shape.
    highlight: { life: 4.0, tube: 0.0032, speed: 0.9, lift: 0.28,
                 maxRise: 0.24, bloomScale: 0.41, gain: 0.70 },

    // Colour rules, in precedence order: the first ENABLED rule that claims an
    // arc colours it. Empty by default -- every flow draws in the ordinary
    // flow colour, exactly as an unconfigured display does today.
    //
    //   match       '10.20.50.0/24' | '2001:db8::/32'   a subnet
    //               '203.0.113.10-203.0.113.40'         an inclusive range
    //               'DE'                                a country code
    //               'tcp/443' | 'udp/51820' | '443'     a port, protocol optional
    //   end         'src' | 'dst' | 'either'            default 'either'
    //   color       any '#rrggbb' or '#rgb'
    //   name        optional; an empty name displays the matcher itself
    //   gain        optional; defaults to arcs.highlight.gain
    //   bloomScale  optional; defaults to arcs.highlight.bloomScale
    //   enabled     optional; default true
    //
    // Blocks are never coloured by a rule -- the alarm layer is one visual
    // language and the wall exists to show it.
    rules: [],
  },

  // --------------------------------------------------------------- camera --
  //
  // The camera returns to the traffic, holds, then walks off on a fresh
  // cardinal bearing -- alternating axis and direction each cycle so it never
  // appears to favour one way round. Set walk.enabled false to park it.

  camera: {
    distance: 4.6,          // in globe radii; below ~3.2 the limb clips at 35 deg FOV
    walk: {
      enabled: true,
      cycleSeconds: 120,
      holdSeconds: 25,      // stillness over the traffic before setting off
      returnMaxSeconds: 45, // cap, so drifting traffic cannot eat a whole cycle
      arriveDegrees: 3,     // close enough to call it home
      // 1.6 / 60 / 0.15 until 0.4.1, when the walk was judged too slow to set
      // off and too tight a sweep on the wall. The three move together: the
      // peak rate is DERIVED from spanDegrees and the phase length, so raising
      // the span alone buys distance at the same pace, and raising the floor
      // alone starts quicker but flattens the ramp. The cap has to clear the
      // derived peak or it silently becomes the rate.
      degreesPerSecond: 2.2,
      spanDegrees: 75,      // how far from the traffic a walk may get
      rampFloor: 0.35,      // the walk sets off at this fraction of its peak rate
      latitudeClamp: 62,    // the walk bounces off this rather than stalling
    },
    // A burst of blocks from one country is the most interesting thing the
    // wall can show, so the camera goes and looks at it.
    detour: {
      enabled: true,
      blocks: 5,            // this many blocks from one country...
      withinSeconds: 10,    // ...inside this window triggers a visit
      quietSeconds: 120,    // then that country cannot trigger again for this long
      visitSeconds: 15,     // stillness over the blocked country
      visitMaxSeconds: 25,  // cap on the flight out
      // A block burst does not take a view somebody is holding, and a burst
      // arriving during a drag is dropped rather than queued -- letting go
      // must not launch a flight to somewhere nobody asked for, seconds after
      // the event that caused it.
      interruptManual: false,
    },
  },

  // ---------------------------------------------------------------- input --
  //
  // Direct manipulation. The display is autonomous and a person borrows it:
  // drag to turn, wheel or pinch to move closer, and after resumeSeconds of
  // stillness the camera eases home and resumes its own cycle.
  //
  // Set resumeSeconds to 0 and a panned view stays put forever. That is the
  // right answer for a desk and the wrong one for a wall nobody is standing
  // at, which is why it is not the default.

  input: {
    enabled: true,
    drag: true,
    zoom: true,
    keyboard: true,
    // Closest and furthest, in globe radii. The floor is not taste: below
    // ~3.2 the globe's angular radius exceeds the 17.5 deg half-FOV of the
    // 35 deg camera and the limb clips on a 16:9 wall.
    zoomRange: [3.3, 9.0],
    zoomFactor: 1.12,      // per wheel notch, multiplicative
    // A hand rotates the globe freely -- over the poles, upside down, as far as
    // it likes -- so there is no latitude limit to configure here. The walk
    // still bounces off camera.walk.latitudeClamp; see arcball.js for why the
    // two cannot share one number. How fast the roll a drag leaves behind
    // unwinds once the display has taken itself back, as a fraction of the
    // remaining angle per second: the view is already easing home over the
    // return leg, and the horizon should be level by the time it arrives.
    rollReturnEase: 0.6,
    // Fraction of a fling's speed remaining after one second. 0 stops dead,
    // which reads as broken; 1 never settles.
    inertia: 0.85,
    invert: false,
    // Idle seconds before the camera takes itself back. 0 never resumes.
    //
    // Measured in RENDERED time, not wall-clock: the countdown is summed from
    // the render loop's per-frame dt, so a hidden tab -- where the browser
    // throttles requestAnimationFrame to nothing -- stops it entirely, and a
    // display running below real time counts slow. Accepted: a wall kiosk is
    // never a hidden tab, and the alternative costs campath.js its purity.
    // 30 until 0.4.1. A drag is somebody deliberately looking at a place, so
    // the display waits before taking it back -- but half a minute of a still
    // globe reads as a frozen wall to anyone who did not do the dragging.
    resumeSeconds: 15,
    // The same countdown for a claim made by opening the menu (or the colour
    // rules panel), which is not somebody looking at a place -- it is a
    // moment's business with the display, so the walk starts again shortly
    // after the menu closes. The camera is still frozen for the whole time it
    // is open; this is only the delay that begins when it goes away.
    //
    // Gated by resumeSeconds: at 0 the display never takes itself back at all,
    // whatever this says.
    menuResumeSeconds: 2,
    // How fast the distance eases back to camera.distance once the display has
    // taken itself back, as a fraction of the remaining gap per second -- the
    // same easing the camera walk uses, so it reads as the same motion.
    // Orientation is not the only thing a passer-by borrows: without this, a
    // globe pulled in to 3.3 radii stays wrongly framed after the view has
    // already come home. Never runs during a pinch.
    zoomReturnEase: 0.35,
    // An arrow parked on a dark wall for a week is the most visible thing in
    // the room. 0 keeps it visible.
    hideCursorSeconds: 3,
    // Looking is always allowed; configuring is not. With this on, the menu
    // (opened by right-click, `s`, or a double tap) refuses to open at all --
    // for a display in a public space, where the globe is the point and the
    // controls are not.
    lock: false,
  },

  // --------------------------------------------------------------- layers --
  //
  // Turn off anything you do not want drawn. Each is independent.

  layers: {
    // The bright city sprites that bloom. The dimmer night-lights glow baked
    // into the surface texture is part of the globe itself and stays either way.
    cityLights: true,
    coastline: true,
    bordersWatched: true,  // outlines for the countries in borders.bin
    bordersWorld: true,    // every international land border
    admin1: true,          // US state / Canadian province lines
    stars: true,           // real catalogue stars, turned by sidereal time
    aurora: true,          // sized by the live NOAA planetary K-index
    atmosphere: true,
    ripples: true,         // expanding ring where an arc lands
    countryFlash: true,    // the blocked country's outline lights up
  },

  ripples: {
    // One ring per target per this many seconds. Nearly every arc lands on the
    // same point -- home -- so without a cooldown this is a permanent pulse
    // rather than an event.
    cooldownSeconds: 120,
  },

  // ------------------------------------------------------------ appearance --

  appearance: {
    background: '#0b0916',
    // UnrealBloomPass(strength, radius, threshold), then a Reinhard knee on the
    // bloom term. Raising strength cannot rescue a base pass that is already
    // blown out -- lower flowsPerSecond instead.
    bloom: { strength: 0.7, radius: 0.5, threshold: 0.08, knee: 0.6 },
    // Multiplies every star's colour. Stars blend additively, so this is a
    // straight scale on how much light each one contributes -- 1.5 is 50%
    // brighter sky. Deliberately NOT applied to the per-magnitude alpha: that
    // curve saturates at 1, so scaling it there would flatten every star
    // brighter than mag 3 to the same value and lose Sirius against Polaris.
    starBrightness: 1.5,
    // Daylight makes a kiosk screen hard to read, so the stars are driven
    // harder while the sun is up at the collector's home position and fall
    // back to starBrightness at night. Ramped rather than switched, over
    // starRampMinutes from sunrise and again from sunset, so the change lands
    // while the sky on the globe is already moving. 1.0 disables it.
    starDayGain: 2.0,
    starRampMinutes: 30,
  },

  // ----------------------------------------------------------------- rail --
  //
  // The right rail: block counts, netflow rate, feed health, clock. It takes
  // 26% of the screen from the globe, so it is off unless a display turns it
  // on from the on-screen menu -- one collector, several kiosks, some with
  // and some without. This is only the shipped default; the menu's own
  // choice is remembered in localStorage and wins on every later boot. Set
  // this true if every display at your site should default to having it.

  rail: {
    enabled: false,
    // How many colour-rule rows the rail lists. Ranked by the last hour, not
    // by list order, so a rule that never fires cannot hold a slot in front of
    // one that does.
    maxRules: 5,
  },

  // --------------------------------------------------------------- polling --

  polling: {
    healthSeconds: 10,   // /health.json -- this one is the degraded-mode alarm
    railSeconds: 10,     // /stats.json -- only polled when the rail is on
    buildSeconds: 30,    // /build.json -- reload the kiosk when assets change
    sunSeconds: 1,
    starResyncSeconds: 5,
  },
};

// The colours the three highlight slots have always shipped with. A migrated
// slot with no colour of its own keeps the one it was drawing in.
const SHIPPED_RULE_COLOURS = ['#a855f7', '#22d3ee', '#4ade80'];

/**
 * The three NETVIZ_HIGHLIGHT* slots, as colour rules.
 *
 * Supported for ONE release and then dropped -- the URL parameter `?rail=1`
 * got the same treatment (removed 2026-08-11 once the rail became a stored
 * setting; see CLAUDE.md's "The right rail"). A prefix is a string with a
 * trailing dot standing in for a mask, so
 * '10.20.50.' is a /24; anything not on an octet boundary cannot be converted
 * and is REFUSED WITH A REASON rather than dropped, because a network that
 * silently stops being highlighted looks exactly like a network with no
 * traffic.
 */
export function rulesFromNetworks(networks) {
  const rules = [];
  const refused = [];
  (Array.isArray(networks) ? networks : []).forEach((net, i) => {
    const prefix = net && typeof net.prefix === 'string' ? net.prefix.trim() : '';
    if (!prefix) return;                       // an empty slot is simply off
    if (!prefix.endsWith('.') || !/^(\d{1,3}\.){1,3}$/.test(prefix)) {
      refused.push({ index: i, reason: `prefix "${prefix}" is not on an octet boundary` });
      return;
    }
    const octets = prefix.split('.').filter((p) => p !== '');
    const bits = octets.length * 8;
    const base = [...octets, ...Array(4 - octets.length).fill('0')].join('.');
    rules.push({
      match: `${base}/${bits}`,
      color: net.color || SHIPPED_RULE_COLOURS[i % SHIPPED_RULE_COLOURS.length],
      name: typeof net.label === 'string' ? net.label : '',
      gain: net.gain,
      end: 'either',
      enabled: true,
    });
  });
  return { rules, refused };
}

/**
 * Merge the collector's /config.json into CONFIG, in place.
 *
 * Only what the collector actually owns: the highlighted networks, whose
 * address prefixes are site-specific and so live in .env rather than in this
 * tracked file. A slot the collector leaves empty does NOT overwrite one set
 * here, so editing config.js still works for anyone who would rather not use
 * environment variables.
 *
 * Exported separately from the fetch so it can be tested without a network.
 */
export function mergeServerConfig(served) {
  // Home comes from the collector because the page has no other way to know
  // it: the camera infers home from where arcs converge, which is no use to
  // the star ramp before any traffic has arrived. Merged before the early
  // return below, or a collector that sends home but no networks would be
  // ignored.
  const home = served && served.home;
  if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
    CONFIG.home = { lat: home.lat, lon: home.lon };
  }

  // Extra resolvers to hide, so a container deployment can name its provider's
  // without rebuilding the image. Additive: the built-in list stays.
  const extra = served && served.resolvers && served.resolvers.extra;
  if (Array.isArray(extra) && extra.length) {
    CONFIG.traffic.extraResolvers = CONFIG.traffic.extraResolvers.concat(
      extra.filter((e) => typeof e === 'string' && e));
  }

  // The collector still serves the three NETVIZ_HIGHLIGHT* slots. They are
  // converted to rules ONLY when this display has no rules of its own -- a
  // configured list is the display's own decision and must not be appended to
  // or overwritten by the environment.
  const networks = served && served.highlight && served.highlight.networks;
  if (Array.isArray(networks) && !CONFIG.arcs.rules.length) {
    const { rules, refused } = rulesFromNetworks(networks);
    if (rules.length) CONFIG.arcs.rules = rules;
    for (const r of refused) {
      console.warn(`netviz: highlight slot ${r.index + 1} not migrated -- ${r.reason}`);
    }
  }
  return CONFIG;
}

/**
 * Fetch and apply the collector's display config.
 *
 * Must be awaited before anything reads a class colour -- arcs.js builds its
 * class specs when createArcs() is called, and a merge after that point would
 * leave the arcs on the old palette until a reload. Failure is not fatal: an
 * older collector 404s here, and the built-in defaults are a working display.
 */
export async function loadServerConfig() {
  try {
    const r = await fetch('/config.json', { cache: 'no-store' });
    if (r.ok) mergeServerConfig(await r.json());
  } catch {
    // Collector restarting, or a build without the endpoint. Defaults stand.
  }
  return CONFIG;
}

/** Read a dotted path out of CONFIG, falling back to `fallback` when the key
 *  is absent. Lets every module keep its own default so a partial config file
 *  -- or a deleted key -- can never leave a module with undefined. */
export function cfg(path, fallback) {
  let node = CONFIG;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) return fallback;
    node = node[key];
  }
  return node === undefined ? fallback : node;
}
