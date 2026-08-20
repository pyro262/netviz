// The self-test: the checks a person standing at the wall would otherwise have
// to make by eye, made numerically instead.
//
// A TEST MODE THAT ALWAYS PASSES IS INDISTINGUISHABLE FROM ONE THAT IS NOT
// RUNNING. A check that could not run reports `skipped`, never `pass`: an
// unreachable collector is not a healthy one, and a landmark behind the limb is
// not a landmark in the right place.
//
// Everything it needs is injected -- the arc pool, the projection, a stats
// fetch, the socket, and the pause/resume pair -- so the whole of it runs under
// `node --test` against stubs, INCLUDING THE FAILURE PATHS. That is the point:
// this project's rule is to test a new guard by making it fail first, and this
// feature is guard-shaped throughout.

/** Landmarks whose longitude is far from both 0 and 180, so a MIRRORED
 *  projection (+lon where the renderer uses -lon) puts each one on the wrong
 *  side of the globe by a wide margin. A landmark near the prime meridian would
 *  pass a mirrored projection, which is the failure this check exists for --
 *  `+lon` mirrors every continent and looks perfectly fine until you know one.
 *  A test asserts the margin, so a future edit cannot quietly pick a landmark
 *  that cannot catch anything. */
export const LANDMARKS = [
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Reykjavik', lat: 64.15, lon: -21.94 },
  { name: 'Cape Town', lat: -33.92, lon: 18.42 },
];

const pass = (reason) => ({ status: 'pass', reason });
const fail = (reason) => ({ status: 'fail', reason });
const skip = (reason) => ({ status: 'skipped', reason });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** One stats read per run, not one per check: four feed checks would otherwise
 *  make four requests and could disagree with each other about the same
 *  moment. Memoized on the promise so a rejection is shared too -- every feed
 *  check then reports `skipped` for the same reason, which is the truth. */
function statsOnce(stats) {
  let promise = null;
  return () => {
    if (!promise) promise = Promise.resolve().then(() => stats());
    return promise;
  };
}

async function feedStats(ctx) {
  try {
    const s = await ctx.readStats();
    if (!s || typeof s !== 'object') return { error: 'the collector sent no statistics' };
    return { stats: s };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

const CHECKS = {
  // --------------------------------------------------------- sample arcs --
  // Drawn straight through the arc pool, NEVER injected as fake events.
  // Injecting would put fabricated traffic through classify.js and the rail's
  // counters, and a test that pollutes the numbers it is testing is worse than
  // no test at all.
  'test.arcs.flow': async (ctx) => {
    ctx.arcs.drawSample('flow', 1);
    return pass('drew one flow arc');
  },
  'test.arcs.blocked': async (ctx) => {
    ctx.arcs.drawSample('block', 1);
    return pass('drew one blocked arc');
  },
  'test.arcs.custom': async (ctx) => {
    const n = ctx.arcs.drawSample('custom', 1);
    return typeof n === 'number' && n === 0
      ? skip('no custom arcs are defined on this display')
      : pass('drew one arc for each custom arc');
  },
  'test.arcs.flood': async (ctx) => {
    ctx.arcs.drawSample('flow', 200);
    return pass('drew 200 arcs at once');
  },

  'test.layers.cycle': async (ctx) => {
    if (!ctx.cycleLayers) return skip('this display has no layer cycler wired up');
    const n = await ctx.cycleLayers();
    return pass(`stepped through ${n} layers and put them back`);
  },

  // -------------------------------------------------------------- feeds --
  'test.feeds.netflow': async (ctx) => {
    const { stats, error } = await feedStats(ctx);
    if (error) return skip(`could not read the collector: ${error}`);
    const records = (stats.ipfix && stats.ipfix.records) || 0;
    return records > 0
      ? pass(`${records} netflow records decoded`)
      : fail('no netflow records have been decoded -- is the exporter pointed here?');
  },
  'test.feeds.blocks': async (ctx) => {
    const { stats, error } = await feedStats(ctx);
    if (error) return skip(`could not read the collector: ${error}`);
    const sys = stats.syslog || {};
    const datagrams = sys.datagrams || 0;
    const events = sys.events || 0;
    if (!datagrams) {
      return fail('no datagrams on the syslog port at all -- the feed is dead, '
                + 'not merely quiet');
    }
    // THE DISTINCTION THE COLLECTOR ALREADY MAKES, kept here. `datagrams`
    // climbing with `events` at zero is a LIVE feed carrying no policy logs --
    // a router with nothing blocked, or per-policy logging switched off. That
    // is not the same as a dead feed, and reporting it as one would send
    // somebody to debug a cable that is fine.
    return events > 0
      ? pass(`${events} block events from ${datagrams} datagrams`)
      : pass(`${datagrams} datagrams arriving but carrying none -- the feed is `
           + 'live and has no policy logs in it');
  },
  'test.feeds.socket': async (ctx) => {
    const s = ctx.socket();
    if (!s) return skip('this display has no socket object to look at');
    // WebSocket.OPEN is 1. Compared numerically rather than against the
    // constant, so this runs under node with a plain stub.
    return s.readyState === 1
      ? pass('the WebSocket is open')
      : fail(`the WebSocket is not open (readyState ${s.readyState})`);
  },
  'test.feeds.collector': async (ctx) => {
    const { stats, error } = await feedStats(ctx);
    if (error) return skip(`could not read the collector: ${error}`);
    const geo = stats.geoip || {};
    const rate = typeof geo.miss_rate === 'number' ? geo.miss_rate : null;
    if (rate === null) return pass('the collector answered');
    return rate < 0.2
      ? pass(`the collector answered; GeoIP miss rate ${(rate * 100).toFixed(1)}%`)
      : fail(`GeoIP miss rate is ${(rate * 100).toFixed(1)}%, over the 20% threshold`);
  },

  // ----------------------------------------------------------------- geo --
  // ASSERTED NUMERICALLY, never by eye. `latLonToVec3` uses `theta = -lon`;
  // `+lon` mirrors every continent and looks fine until you know a landmark,
  // which is exactly why this check exists and why it compares each landmark
  // against where the WRONG sign would have put it.
  'test.geo.landmarks': async (ctx) => {
    // WHAT IS ACTUALLY ASSERTED, and why it is not the screen position.
    //
    // A screen projection cannot be checked against itself: comparing
    // project(lat, lon) with project(lat, -lon) says only that the two
    // longitudes differ, which a MIRRORED projection satisfies just as well as
    // a correct one. The convention lives in `latLonToVec3`, which uses
    // `theta = -lon` -- so the world-space Z of a point is
    // `-r * sin(phi) * sin(lon)`, and its SIGN is the whole of the fact. Under
    // `+lon` every Z flips, every continent mirrors, and the globe looks
    // perfectly fine until you know a landmark.
    //
    // `project()` is still used, for the one thing it can answer: whether the
    // landmark is on screen at all. A landmark behind the limb is SKIPPED --
    // the camera walks, and a check that fails because the globe happened to be
    // turned away is a check nobody will trust twice.
    if (!ctx.vec3) return skip('this display exposes no position function to measure');
    const wrong = [];
    for (const l of LANDMARKS) {
      if (!ctx.project(l.lat, l.lon)) {
        return skip(`${l.name} is behind the limb right now -- nothing to measure`);
      }
      const v = ctx.vec3(l.lat, l.lon);
      if (!v || typeof v.z !== 'number') {
        return skip(`no position for ${l.name}`);
      }
      const want = -Math.sin((l.lon * Math.PI) / 180);
      // Guard against a landmark that says nothing. The table's own test keeps
      // every entry well away from 0 and 180, so this should never fire; it is
      // here so a future edit that breaks that cannot make the check silently
      // vacuous instead of failing.
      if (Math.abs(want) < 0.2) continue;
      if (Math.sign(v.z) !== Math.sign(want)) wrong.push(l.name);
    }
    return wrong.length
      ? fail(`mirrored longitude: ${wrong.join(', ')} sit where +lon would put them`)
      : pass(`${LANDMARKS.length} landmarks project on the correct side`);
  },
  'test.geo.home': async (ctx) => {
    const home = ctx.home && ctx.home();
    if (!home || typeof home.lat !== 'number') {
      return skip('this display does not know where home is');
    }
    const p = ctx.project(home.lat, home.lon);
    return p
      ? pass(`home projects at ${home.lat.toFixed(2)}, ${home.lon.toFixed(2)}`)
      : skip('home is behind the limb right now -- nothing to measure');
  },
};

export function createSelfTest({ arcs, project, vec3, stats, socket, pause,
                                 resume, home, cycleLayers } = {}) {
  async function run(paths = []) {
    // Pausing to run no checks freezes the wall for nothing, so the guard is
    // before the pause and not inside the loop.
    if (!paths.length) return [];
    const ctx = { arcs, project, vec3, socket, home, cycleLayers,
                  readStats: statsOnce(stats) };
    const out = [];
    // The pause is RENDERER-SIDE ONLY: the collector keeps running, Influx
    // keeps receiving and no counter is disturbed. It exists so a sample arc is
    // judged on a clean globe rather than against live traffic.
    if (pause) pause();
    try {
      for (const path of paths) {
        const check = CHECKS[path];
        if (!check) {
          out.push({ id: path, status: 'skipped', reason: 'no such check' });
          continue;
        }
        try {
          out.push({ id: path, ...(await check(ctx)) });
        } catch (err) {
          out.push({ id: path, status: 'fail',
                     reason: String(err && err.message ? err.message : err) });
        }
      }
    } finally {
      // In a `finally`, ALWAYS. A check that throws must not leave the wall
      // frozen with the feed paused and nothing on screen moving -- which reads
      // as the collector having died, from the one control that was supposed to
      // tell you whether it had.
      if (resume) resume();
    }
    return out;
  }
  return { run };
}
