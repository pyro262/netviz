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
  },

  // ------------------------------------------------------------- highlight --
  //
  // Up to three networks drawn in their own colour -- a server VLAN, an IoT
  // segment, a guest network, whatever is worth telling apart at a glance.
  // Each is matched as a string prefix against either end of a flow.
  //
  // **Set the prefixes in .env, not here.** An address prefix describes how
  // your LAN is laid out, and this file is tracked by git. The collector reads
  // NETVIZ_HIGHLIGHT{1,2,3}_{PREFIX,LABEL,COLOR,GAIN} and serves them to the
  // page at /config.json, which overrides whatever is below. What is here is
  // the fallback for a collector too old to serve it, and the place to change
  // the default colours.
  //
  // Keep the trailing dot on a prefix: '10.0.5.' will not match 10.0.50.x, and
  // the match is anchored at the start so it will not match 110.0.5.x either.
  //
  // A slot with an empty prefix is simply off. All three empty -- the default
  // -- means every flow draws in the ordinary flow colour.
  //
  // colour  an explicit hex, deliberately off the plasma ramp so a highlighted
  //         network reads as a separate system rather than as busier traffic
  // gain    multiplies the colour down. Cyan and green are the highest-
  //         luminance hues on a display and clear the bloom threshold sooner
  //         than a violet of the same nominal value, hence the lower numbers.

  highlight: {
    networks: [
      { prefix: '', label: 'network 1', color: '#a855f7', gain: 0.70 },
      { prefix: '', label: 'network 2', color: '#22d3ee', gain: 0.51 },
      { prefix: '', label: 'network 3', color: '#4ade80', gain: 0.55 },
    ],
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

    // Shape shared by all three highlighted networks; each takes its own
    // colour and gain from `highlight.networks` above. Override one slot on
    // its own with an `arcs.highlight1` / `highlight2` / `highlight3` key.
    highlight: { life: 4.0, tube: 0.0032, speed: 0.9, lift: 0.28,
                 maxRise: 0.24, bloomScale: 0.41 },
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
      degreesPerSecond: 1.6,
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
    },
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
  // 26% of the screen from the globe, so it is off unless a display asks for
  // it with `?rail=1` -- one collector, several kiosks, some with and some
  // without. This is only the fallback for a URL that says nothing; set it
  // true if every display at your site should have it.

  rail: {
    enabled: false,
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

  const networks = served && served.highlight && served.highlight.networks;
  if (!Array.isArray(networks)) return CONFIG;
  const local = CONFIG.highlight.networks;
  CONFIG.highlight.networks = local.map((slot, i) => {
    const from = networks[i];
    if (!from || !from.prefix) return slot;
    return {
      prefix: from.prefix,
      label: from.label || slot.label,
      color: from.color || slot.color,
      gain: from.gain === undefined ? slot.gain : from.gain,
    };
  });
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
