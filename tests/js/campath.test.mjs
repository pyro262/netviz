// The camera's motion is simulated, not eyeballed: "does it still wander" and
// "does it still favour the traffic" are both measurable over ten minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { step, initialState, startVisit, deltaLon, blendLon, DEFAULTS, BEARINGS } from
  '../../netviz/static/js/campath.js';

/** Deterministic rng, so a heading sequence can be asserted rather than hoped for. */
function seeded(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const P = { ...DEFAULTS, rng: seeded(7) };

const HOME = { lat: 30.3, lon: -97.7 };      // the home site: where every arc roots

/** Run the rig for `seconds` at 20fps, returning the longitudes visited. */
function simulate(seconds, traffic, params = P) {
  const s = initialState();
  const dt = 0.05;
  const lons = [];
  const lats = [];
  const samples = [];
  for (let t = 0; t < seconds; t += dt) {
    step(s, dt, traffic, params);
    lons.push(s.curLon);
    lats.push(s.curLat);
    samples.push({ t, lon: s.curLon, lat: s.curLat, cycle: s.cycles,
                   bearing: s.bearing });
  }
  return { lons, lats, samples, state: s };
}

/** Share of samples within `deg` of a longitude, the short way round. */
function nearFraction(lons, lon, deg) {
  return lons.filter((l) => Math.abs(deltaLon(l, lon)) <= deg).length / lons.length;
}

test('deltaLon takes the short way round the seam', () => {
  // 170 -> -170 crosses the antimeridian going EAST: +20, not -20.
  assert.equal(deltaLon(170, -170), 20);
  assert.equal(deltaLon(-170, 170), -20);
  assert.equal(deltaLon(0, 90), 90);
  assert.equal(deltaLon(0, 270), -90);
});

test('blendLon moves partway, not all the way', () => {
  assert.ok(Math.abs(blendLon(0, 100, 0.35) - 35) < 1e-9);
  assert.ok(Math.abs(blendLon(170, -170, 0.5) - 180) < 1e-9);   // across the seam
});

test('each cycle walks a real distance away from home', () => {
  // Not all the way round any more -- it returns home every cycle by design --
  // but a walk that never leaves the home hemisphere is just a wobble.
  const { samples } = simulate(1200, HOME);
  const far = new Map();
  for (const s of samples) {
    const d = Math.abs(deltaLon(s.lon, HOME.lon));
    far.set(s.cycle, Math.max(far.get(s.cycle) ?? 0, d));
  }
  const reached = [...far.entries()].filter(([c]) => c > 1).map(([, d]) => d);
  for (const d of reached) {
    assert.ok(d > 45, `a cycle barely left home: ${d.toFixed(1)} degrees`);
  }
});

test('over many cycles it still sees the whole globe', () => {
  const { lons } = simulate(2400, HOME);
  const covered = new Set(lons.map((l) => Math.floor(((l + 180) % 360) / 30)));
  assert.ok(covered.size >= 8, `only visited ${covered.size}/12 longitude sectors`);
});

test('it comes back over the traffic once per cycle', () => {
  const { samples } = simulate(600, HOME);
  const byCycle = new Map();
  for (const s of samples) {
    const d = Math.abs(deltaLon(s.lon, HOME.lon));
    byCycle.set(s.cycle, Math.min(byCycle.get(s.cycle) ?? 999, d));
  }
  // Every completed cycle must pass close to home at some point in it.
  const closest = [...byCycle.entries()].filter(([c]) => c > 1).map(([, d]) => d);
  assert.ok(closest.length >= 3, 'not enough cycles simulated');
  for (const d of closest) {
    assert.ok(d < 25, `a cycle never came home: closest was ${d.toFixed(1)} degrees`);
  }
});

test('every cycle sets off on a different compass bearing', () => {
  const { samples } = simulate(3600, HOME);
  const byCycle = new Map();
  for (const s of samples) byCycle.set(s.cycle, s.bearing);
  const seq = [...byCycle.values()];
  for (let i = 1; i < seq.length; i += 1) {
    assert.notEqual(seq[i], seq[i - 1], `cycle ${i} repeated bearing ${seq[i]}`);
  }
});

test('all four cardinal points get used over a long run', () => {
  const { samples } = simulate(7200, HOME);
  const used = new Set(samples.map((s) => s.bearing));
  assert.equal(used.size, 4, `used ${used.size} bearings: ${[...used]}`);
});

test('walks are cardinal only -- no diagonals', () => {
  // Six of the old eight bearings carried an east or west component, so NE, E
  // and SE all read as "going east" and three eastward-looking walks in a row
  // were ordinary. The selection was never statistically biased -- measured
  // uniform over 200 cycles -- but it looked biased, which is what matters on
  // a wall.
  const { samples } = simulate(7200, HOME);
  for (const b of new Set(samples.map((s) => s.bearing))) {
    assert.ok(BEARINGS.includes(b), `${b} is not a cardinal point`);
    assert.equal(b % 90, 0, `${b} is a diagonal`);
  }
});

test('consecutive walks never share an east/west sense', () => {
  // With four cardinals and the previous one excluded, a repeat of the same
  // apparent direction can only happen via N or S in between, never directly.
  const { samples } = simulate(7200, HOME);
  const byCycle = new Map();
  for (const s of samples) byCycle.set(s.cycle, s.bearing);
  const seq = [...byCycle.values()];
  for (let i = 1; i < seq.length; i += 1) {
    assert.notEqual(seq[i], seq[i - 1]);
  }
});

/** The bearing each cycle set off on, in order. */
function bearingSequence(seconds, params = P) {
  const { samples } = simulate(seconds, HOME, params);
  const byCycle = new Map();
  for (const s of samples) byCycle.set(s.cycle, s.bearing);
  return [...byCycle.values()].filter((b) => b !== null);
}

test('each axis alternates direction, so the globe never spins the same way twice', () => {
  // The bug the wall showed 2026-08-09: the camera made several full sweeps in
  // the SAME direction before coming home. Alternating the axis was not enough
  // -- `choices = axis.filter(b => b !== state.bearing)` never actually filters
  // anything, because after alternation the previous bearing is on the OTHER
  // axis. So east/west was a free coin flip each time it came round, and runs
  // of up to NINE same-direction walks were measured over 400 cycles.
  const seq = bearingSequence(120 * 120);
  for (const axis of [[90, 270], [0, 180]]) {
    const walks = seq.filter((b) => axis.includes(b));
    assert.ok(walks.length >= 20, `only ${walks.length} walks on axis ${axis}`);
    for (let i = 1; i < walks.length; i += 1) {
      assert.notEqual(walks[i], walks[i - 1],
        `two walks in a row went ${walks[i]} on axis ${axis}`);
    }
  }
});

test('east and west get equal time, so there is no net drift', () => {
  const seq = bearingSequence(120 * 120);
  const count = (b) => seq.filter((x) => x === b).length;
  assert.ok(Math.abs(count(90) - count(270)) <= 1,
    `east ${count(90)} vs west ${count(270)}`);
  assert.ok(Math.abs(count(0) - count(180)) <= 1,
    `north ${count(0)} vs south ${count(180)}`);
});

test('north and south walks actually change latitude', () => {
  // A due-north cycle used to hit the clamp in about 20 seconds and sit there.
  //
  // The bearing is seeded to an east/west one because headings now alternate
  // axis: the first step of a cycle re-picks, and from east the alternation
  // guarantees the walk under test is the north/south one.
  const P0 = { ...DEFAULTS, rng: () => 0 };
  const s = initialState();
  s.bearing = 90;                      // east, so alternation yields north/south
  const lats = [];
  for (let t = 0; t < 115; t += 0.05) { step(s, 0.05, HOME, P0); lats.push(s.curLat); }
  const spread = Math.max(...lats) - Math.min(...lats);
  assert.ok(spread > 30, `a due-south walk moved only ${spread.toFixed(1)} degrees`);
});

test('a walk bounces off the latitude clamp rather than stalling against it', () => {
  const s = initialState();
  const P0 = { ...DEFAULTS, rng: () => 0 };
  const lats = [];
  for (let t = 0; t < 600; t += 0.05) { step(s, 0.05, { lat: 55, lon: 0 }, P0); lats.push(s.curLat); }
  assert.ok(Math.max(...lats) <= DEFAULTS.latClamp + 1e-9, 'clamp breached');
  // If it stalled, the last 30 seconds would be a flat line.
  const tail = lats.slice(-600);
  assert.ok(Math.max(...tail) - Math.min(...tail) > 1, 'camera stalled at the clamp');
});

test('it still favours the traffic overall', () => {
  const { lons } = simulate(1800, HOME);
  const near = nearFraction(lons, HOME.lon, 90);
  assert.ok(near > 0.5, `no measurable bias toward traffic: ${near}`);
});

test('a cycle is about two minutes', () => {
  const { samples } = simulate(600, HOME);
  const starts = [];
  let last = null;
  for (const s of samples) {
    if (s.cycle !== last) { starts.push(s.t); last = s.cycle; }
  }
  const gaps = starts.slice(2).map((t, i) => t - starts[i + 1]);
  for (const g of gaps) {
    assert.ok(Math.abs(g - DEFAULTS.cycleSeconds) < 0.2, `cycle was ${g}s`);
  }
});

test('with no traffic at all it keeps drifting rather than stalling', () => {
  const { lons } = simulate(600, null);
  const covered = new Set(lons.map((l) => Math.floor(((l + 180) % 360) / 30)));
  assert.ok(covered.size >= 10, `stalled: ${covered.size}/12 sectors`);
});

test('latitude varies between cycles instead of retracing one band', () => {
  const { lats } = simulate(900, HOME);
  const spread = Math.max(...lats) - Math.min(...lats);
  assert.ok(spread > 20, `latitude barely moved: ${spread} degrees`);
});

test('it never looks down the pole', () => {
  const { lats } = simulate(1800, { lat: 89, lon: 0 });
  assert.ok(Math.max(...lats) <= DEFAULTS.latClamp + 1e-9);
  assert.ok(Math.min(...lats) >= -DEFAULTS.latClamp - 1e-9);
});

test('longitude stays wrapped, so it never runs off to 10000 degrees', () => {
  const { state } = simulate(3600, HOME);
  assert.ok(state.curLon >= -180 && state.curLon < 180, `curLon = ${state.curLon}`);
});

/** Angular distance from a sample to home, in degrees. */
function distToHome(lat, lon) {
  return Math.hypot(lat - HOME.lat, deltaLon(lon, HOME.lon));
}

test('the camera actually arrives over the traffic, not just near it', () => {
  // Before the hold was added the return leg was a pure exponential ease that
  // ran out of budget mid-approach: closest approach was always at the exact
  // instant the walk restarted, 5-10 degrees short, so the display never
  // settled on home at all.
  const { samples } = simulate(600, HOME);
  const perCycle = new Map();
  for (const s of samples) {
    const d = distToHome(s.lat, s.lon);
    if (!perCycle.has(s.cycle) || d < perCycle.get(s.cycle)) perCycle.set(s.cycle, d);
  }
  const closest = [...perCycle.entries()].filter(([c]) => c > 1).map(([, d]) => d);
  for (const d of closest) {
    assert.ok(d <= P.arriveDegrees, `closest approach ${d.toFixed(1)} deg, never arrived`);
  }
});

test('having arrived, it holds over home for the requested time', () => {
  // The point of the whole change: a wall watcher should get a beat of stillness
  // on the traffic before the camera sets off again.
  const { samples } = simulate(600, HOME);
  const holds = new Map();
  for (const s of samples) {
    if (distToHome(s.lat, s.lon) <= P.arriveDegrees) {
      holds.set(s.cycle, (holds.get(s.cycle) || 0) + 0.05);
    }
  }
  const spans = [...holds.entries()].filter(([c]) => c > 1).map(([, v]) => v);
  assert.ok(spans.length >= 3, `only ${spans.length} cycles reached home`);
  for (const v of spans) {
    assert.ok(v >= P.holdSeconds * 0.9,
      `held only ${v.toFixed(1)}s, wanted ~${P.holdSeconds}s`);
  }
});

test('the hold ends and the camera leaves again', () => {
  // A hold that never releases is just the old pinned-to-one-hemisphere bug.
  const { samples } = simulate(600, HOME);
  const byCycle = new Map();
  for (const s of samples) {
    if (!byCycle.has(s.cycle)) byCycle.set(s.cycle, []);
    byCycle.get(s.cycle).push(distToHome(s.lat, s.lon));
  }
  for (const [cycle, ds] of byCycle) {
    if (cycle < 2) continue;
    assert.ok(Math.max(...ds) > 40, `cycle ${cycle} never left home`);
  }
});

test('a return leg cannot eat the whole cycle', () => {
  // Traffic that keeps moving must not leave the camera permanently chasing it
  // with no walk ever happening.
  let n = 0;
  const drifting = () => ({ lat: 10 * Math.sin(n / 40), lon: ((n++ * 3) % 360) - 180 });
  const s = initialState();
  let walkFrames = 0;
  for (let t = 0; t < 600; t += 0.05) {
    step(s, 0.05, drifting(), P);
    if (s.phase === 'walk') walkFrames += 1;
  }
  assert.ok(walkFrames > 0, 'never reached the walk phase');
});

// --- the block-burst detour ------------------------------------------------
//
// A burst of blocks from one country is what the wall is for, so the camera
// goes and looks at it, then comes home on the ordinary return leg.

const CHINA = { lat: 35, lon: 105 };

/** Run for `seconds`, calling `at(t, state)` each step so a visit can be
 *  triggered mid-run. Returns the samples. */
function simulateWith(seconds, traffic, at, params = P) {
  const s = initialState();
  const dt = 0.05;
  const samples = [];
  for (let t = 0; t < seconds; t += dt) {
    at(t, s);
    step(s, dt, traffic, params);
    samples.push({ t, lat: s.curLat, lon: s.curLon, phase: s.phase, cycle: s.cycles });
  }
  return samples;
}

test('a burst sends the camera to the country', () => {
  const samples = simulateWith(200, HOME, (t, s) => {
    if (Math.abs(t - 60) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
  });
  const after = samples.filter((x) => x.t >= 60);
  const closest = Math.min(...after.map(
    (x) => Math.hypot(x.lat - CHINA.lat, deltaLon(x.lon, CHINA.lon))));
  assert.ok(closest <= P.arriveDegrees,
    `never arrived over the country: closest ${closest.toFixed(1)} deg`);
});

test('it holds over the country for the requested time', () => {
  const samples = simulateWith(200, HOME, (t, s) => {
    if (Math.abs(t - 60) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
  });
  const held = samples.filter((x) => x.phase === 'visitHold').length * 0.05;
  assert.ok(Math.abs(held - P.visitSeconds) < 0.5,
    `held ${held.toFixed(1)}s over the country, wanted ${P.visitSeconds}s`);
});

test('the detour cannot run for ever when the camera cannot arrive', () => {
  const samples = simulateWith(300, HOME, (t, s) => {
    if (Math.abs(t - 60) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
  }, { ...P, ease: 0.0005 });     // far too slow to ever get there
  const visiting = samples.filter((x) => x.phase === 'visit').length * 0.05;
  assert.ok(visiting <= P.visitMaxSeconds + 0.5,
    `the visit leg ran ${visiting.toFixed(1)}s, past its cap`);
});

test('a second burst during a visit is ignored', () => {
  // The display must finish looking at one thing before being pulled to the
  // next, or a busy feed turns the camera into a metronome.
  const OTHER = { lat: -30, lon: 25 };
  const samples = simulateWith(200, HOME, (t, s) => {
    if (Math.abs(t - 60) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
    if (Math.abs(t - 65) < 0.001) startVisit(s, OTHER.lat, OTHER.lon);
  });
  const during = samples.filter((x) => x.t >= 60 && x.t < 105);
  const nearOther = during.filter(
    (x) => Math.hypot(x.lat - OTHER.lat, deltaLon(x.lon, OTHER.lon)) < 30);
  assert.equal(nearOther.length, 0, 'the second burst hijacked the visit');
});

test('after the visit the camera comes home and the ordinary cycle resumes', () => {
  const samples = simulateWith(400, HOME, (t, s) => {
    if (Math.abs(t - 60) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
  });
  const endOfVisit = Math.max(...samples.filter((x) => x.phase === 'visitHold')
    .map((x) => x.t));
  const after = samples.filter((x) => x.t > endOfVisit);
  const closestHome = Math.min(...after.map((x) => distToHome(x.lat, x.lon)));
  assert.ok(closestHome <= P.arriveDegrees,
    `never came home after the visit: ${closestHome.toFixed(1)} deg`);
  // and it sets off again afterwards rather than parking on home
  assert.ok(Math.max(...after.map((x) => distToHome(x.lat, x.lon))) > 40,
    'never left home again after the visit');
});

test('the cycle clock is frozen during a detour, not eaten by it', () => {
  // If the visit ran on the cycle's own clock, a detour late in a cycle would
  // be cut short by the rollover and the camera would snap away mid-look.
  const samples = simulateWith(400, HOME, (t, s) => {
    if (Math.abs(t - 110) < 0.001) startVisit(s, CHINA.lat, CHINA.lon);
  });
  const visit = samples.filter((x) => x.phase === 'visit' || x.phase === 'visitHold');
  const cycles = new Set(visit.map((x) => x.cycle));
  assert.equal(cycles.size, 1, 'the cycle rolled over mid-visit');
  const span = visit.length * 0.05;
  assert.ok(span > P.visitSeconds, `the detour lasted only ${span.toFixed(1)}s`);
});
