// The camera's motion is simulated, not eyeballed: "does it still wander" and
// "does it still favour the traffic" are both measurable over ten minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { step, initialState, startVisit, deltaLon, blendLon, DEFAULTS, BEARINGS, walkRateAt,
  angularDistance } from
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

// The ramp is sized by the DISTANCE it must cover, not by a rate somebody
// typed: integrating it over the phase has to come out at spanDegrees, or the
// "never more than 60 degrees from home" promise is decoration.
const integrate = (duration, p, steps = 20000) => {
  let total = 0;
  const dt = duration / steps;
  for (let i = 0; i < steps; i += 1) total += walkRateAt((i + 0.5) * dt, duration, p) * dt;
  return total;
};

test('a full walk covers spanDegrees, whatever the phase length', () => {
  const p = { ...DEFAULTS };
  // 75s is the ordinary case (120s cycle minus a return and a 25s hold); 120s
  // is the no-traffic case, where the cycle skips straight to the walk.
  for (const duration of [75, 120]) {
    const covered = integrate(duration, p);
    assert.ok(Math.abs(covered - p.spanDegrees) < 0.5,
              `${duration}s walk covered ${covered.toFixed(2)}, want ${p.spanDegrees}`);
  }
});

test('the walk starts slow and finishes fast', () => {
  // Integrating the FIRST HALF of a 75s phase -- not a 37.5s phase, which
  // would be a different, faster ramp. The rate at t depends on the phase's
  // own length, so the halves have to be measured inside one phase.
  const p = { ...DEFAULTS };
  const partial = (from, to) => {
    let total = 0;
    const dt = 75 / 20000;
    for (let i = from; i < to; i += 1) total += walkRateAt((i + 0.5) * dt, 75, p) * dt;
    return total;
  };
  const firstHalf = partial(0, 10000);
  const secondHalf = partial(10000, 20000);
  const whole = firstHalf + secondHalf;
  // At rampFloor 0.15 the split is about 31.5/68.5 (linear ramp from floor to
  // peak: integral = T*(a+b)/2 where a=floor*peak and b=peak, so first half
  // integrates to T/8*(3*floor + 1)*peak).
  assert.ok(firstHalf / whole > 0.30 && firstHalf / whole < 0.33,
            `first half covered ${(100 * firstHalf / whole).toFixed(1)}%, want ~31.5%`);
  assert.ok(secondHalf > 2 * firstHalf, 'the second half must cover much more ground');
  assert.ok(walkRateAt(74, 75, p) > 4 * walkRateAt(1, 75, p),
            'the end of the walk must be several times faster than the start');
});

test('rampFloor 1 is a flat rate -- the way back to the old behaviour', () => {
  const p = { ...DEFAULTS, rampFloor: 1 };
  assert.ok(Math.abs(walkRateAt(1, 75, p) - walkRateAt(74, 75, p)) < 1e-9);
  assert.ok(Math.abs(integrate(75, p) - p.spanDegrees) < 0.5);
});

test('the derived peak never exceeds degreesPerSecond', () => {
  // A short walk phase -- a long return, or a detour that reset the cycle --
  // would otherwise derive a peak high enough to whip the globe round.
  const p = { ...DEFAULTS };
  const rates = [];
  for (let t = 0; t <= 10; t += 0.1) rates.push(walkRateAt(t, 10, p));
  assert.ok(Math.max(...rates) <= p.walkRate + 1e-9,
            `peak ${Math.max(...rates)} exceeds the ceiling ${p.walkRate}`);
});

test('a parked walk does not move at all', () => {
  assert.equal(walkRateAt(30, 75, { ...DEFAULTS, walkEnabled: false }), 0);
});

test('a zero or missing duration cannot produce a NaN rate', () => {
  // phaseT can be read on the frame the phase is entered, before any dt has
  // been added. A NaN here becomes a NaN camera position one frame later and
  // the display goes black with a silent console -- the same failure mode the
  // zoom-range guard exists to prevent.
  for (const d of [0, undefined, null]) {
    const r = walkRateAt(0, d, DEFAULTS);
    assert.ok(Number.isFinite(r), `duration ${d} produced ${r}`);
  }
});

test('angularDistance is a great circle, not a lat/lon hypotenuse', () => {
  // The naive Math.hypot answer is wrong wherever longitude degrees are short:
  // two points 180 degrees apart in longitude at 60N are 60 degrees apart on
  // the sphere, not 180. A span cap built on the hypotenuse would cut the walk
  // short near the poles and let it run long at the equator.
  assert.ok(Math.abs(angularDistance(0, 0, 0, 90) - 90) < 1e-6);
  assert.ok(Math.abs(angularDistance(0, 0, 0, 0)) < 1e-9);
  assert.ok(Math.abs(angularDistance(60, 0, 60, 180) - 60) < 1e-6);
  assert.ok(Math.abs(angularDistance(-30, 170, -30, -170) - 17.3) < 0.2); // across the dateline
});

test('a walk never gets further than spanDegrees from the traffic', () => {
  // The integral alone cannot prove this. A cardinal walk divides its east
  // component by cos(lat), bounces off the latitude clamp, and the traffic
  // itself drifts -- so path length walked and distance from home are two
  // different numbers.
  const traffic = { lat: 29.76, lon: -95.37 };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = initialState();
    s.curLat = traffic.lat; s.curLon = traffic.lon;
    s.targetLat = traffic.lat; s.targetLon = traffic.lon;
    let worst = 0;
    // Four full cycles, so several different bearings run, at 30fps.
    for (let i = 0; i < 4 * 120 * 30; i += 1) {
      step(s, 1 / 30, traffic, { ...DEFAULTS, rng: () => (seed * 0.137 + i * 1e-6) % 1 });
      worst = Math.max(worst, angularDistance(s.curLat, s.curLon, traffic.lat, traffic.lon));
    }
    assert.ok(worst <= DEFAULTS.spanDegrees + 2,
              `seed ${seed} reached ${worst.toFixed(1)} deg, cap ${DEFAULTS.spanDegrees}`);
  }
});

test('a walk that hits the span reverses instead of stalling', () => {
  // Stalling against a limit reads as a frozen display -- the same reason the
  // latitude clamp bounces rather than pinning.
  //
  // Window and threshold were widened from the plan's original 75s / 9.5deg
  // by measurement: the guard compares the TARGET's distance to spanDegrees,
  // but this test watches curLat/curLon -- the eased, on-screen position,
  // which lags the target by design. With walkDuration=75 the target itself
  // only reaches the 10-degree cap at t=82.5s (not by t=75, since `linger`
  // -- ~15% here, because `off` never grows past ~10 degrees so its cos(off)
  // stays near 1 the whole time -- scales the whole ramp down). The eased
  // position then rounds the target's sharp reversal corner rather than
  // tracking it, and settles into a stable oscillation peaking at 9.32
  // degrees -- verified flat out to 3000 simulated seconds, never higher.
  // 8.5 (spanDegrees * 0.85) is comfortably below that measured ceiling and
  // still close enough to the cap to prove the walk actually got there.
  const traffic = { lat: 0, lon: 0 };
  const s = initialState();
  s.curLat = 0; s.curLon = 0; s.targetLat = 0; s.targetLon = 0;
  s.phase = 'walk'; s.phaseT = 0; s.cycleT = 0; s.walkDuration = 75;
  s.walkOriginLat = 0; s.walkOriginLon = 0;
  s.bearing = 90;                      // due east, so longitude does the moving
  const p = { ...DEFAULTS, spanDegrees: 10 };
  let hit = false;
  let moved = 0;
  let prev = 0;
  for (let i = 0; i < 150 * 30; i += 1) {
    step(s, 1 / 30, traffic, p);
    const d = angularDistance(s.curLat, s.curLon, 0, 0);
    if (d >= p.spanDegrees * 0.85) hit = true;
    if (hit) moved += Math.abs(d - prev);
    prev = d;
  }
  assert.ok(hit, 'the walk never reached the span at all');
  assert.ok(moved > 1, 'the walk stopped dead at the span instead of turning back');
});

test('the walk still sweeps a real distance -- it is shorter, not parked', () => {
  const traffic = { lat: 0, lon: 0 };
  const s = initialState();
  s.curLat = 0; s.curLon = 0; s.targetLat = 0; s.targetLon = 0;
  let far = 0;
  for (let i = 0; i < 120 * 30; i += 1) {
    step(s, 1 / 30, traffic, DEFAULTS);
    far = Math.max(far, angularDistance(s.curLat, s.curLon, 0, 0));
  }
  assert.ok(far > 25, `the walk only reached ${far.toFixed(1)} degrees from home`);
});

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
  // Threshold lowered 8 -> 5 (2026-08-11): spanDegrees dropped 150 -> 60, so a
  // walk can no longer roam a whole hemisphere from home before turning back.
  // Measured with this file's seeded rng: 6/12 sectors over 2400s, against 8+
  // before the span cap existed. 5 keeps a margin under the measured value
  // rather than asserting the exact number.
  const { lons } = simulate(2400, HOME);
  const covered = new Set(lons.map((l) => Math.floor(((l + 180) % 360) / 30)));
  assert.ok(covered.size >= 5, `only visited ${covered.size}/12 longitude sectors`);
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
  // Threshold lowered 10 -> 2 (2026-08-11): spanDegrees dropped 150 -> 60, so
  // in 600s the no-traffic walk (whose origin resets to wherever the PREVIOUS
  // walk ended, so it can still drift over many cycles -- see the longer-run
  // measurement below) covers far fewer sectors than the old ~150-degree
  // sweep did. Measured with this file's seeded rng: 3/12 over 600s. This is
  // still "not stalled": a genuinely frozen camera would cover 1 sector, and
  // a longer run (2400s) reaches 7/12, confirming the origin keeps advancing
  // rather than the walk settling into one repeating band.
  const { lons } = simulate(600, null);
  const covered = new Set(lons.map((l) => Math.floor(((l + 180) % 360) / 30)));
  assert.ok(covered.size >= 2, `stalled: ${covered.size}/12 sectors`);
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

import {
  beginManual, endManual, isManual, setManualView, markInput, forceHandBack,
} from '../../netviz/static/js/campath.js';

const P2 = { ...DEFAULTS, rng: () => 0.5, resumeSeconds: 30 };

test('manual freezes the camera where the user left it', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 40, -74);
  for (let i = 0; i < 100; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);
  assert.equal(s.curLat, 40);
  assert.equal(s.curLon, -74);
});

test('a held view is not released while the pointer is down', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  for (let i = 0; i < 600; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);   // 60s
  assert.equal(isManual(s), true);
});

test('the camera takes itself back after resumeSeconds of idle', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  endManual(s);
  for (let i = 0; i < 299; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);   // 29.9s
  assert.equal(isManual(s), true);
  step(s, 0.2, { lat: 0, lon: 0 }, P2);                                  // past 30s
  assert.equal(isManual(s), false);
  assert.equal(s.phase, 'return');
});

test('resuming does not jump: the target starts at the held view', () => {
  const s = initialState();
  s.targetLat = -50; s.targetLon = 170;      // stale, from before the drag
  beginManual(s);
  setManualView(s, 10, 10);
  endManual(s);
  for (let i = 0; i < 310; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);
  // One eased frame from (10,10) toward the traffic must be a small move.
  assert.ok(Math.abs(s.curLat - 10) < 2, `curLat jumped to ${s.curLat}`);
  assert.ok(Math.abs(deltaLon(10, s.curLon)) < 2, `curLon jumped to ${s.curLon}`);
});

test('resumeSeconds 0 keeps a panned view forever', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  endManual(s);
  const p = { ...P2, resumeSeconds: 0 };
  for (let i = 0; i < 6000; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);   // 10 min
  assert.equal(isManual(s), true);
  assert.equal(s.curLat, 10);
});

test('a block burst never takes a view being held', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  assert.equal(startVisit(s, -30, 25, P2), false);
  assert.equal(s.phase, 'return');           // unchanged, no visit began
  assert.equal(s.curLat, 10);
});

test('a burst during a drag is dropped, not deferred to the release', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  startVisit(s, -30, 25, P2);                 // refused
  endManual(s);
  for (let i = 0; i < 400; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);
  // After the hand-back the camera returns to the traffic, never to (-30, 25).
  assert.equal(isManual(s), false);
  assert.ok(Math.abs(deltaLon(s.curLon, 25)) > 5, 'flew to the dropped burst');
});

test('detourInterruptManual true lets the burst win', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  assert.equal(startVisit(s, -30, 25, { ...P2, detourInterruptManual: true }), true);
  assert.equal(isManual(s), false);
  assert.equal(s.phase, 'visit');
});

test('forceHandBack ends manual immediately, no idle wait', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  endManual(s);        // released, but still manual -- the idle countdown state
  assert.equal(isManual(s), true);
  forceHandBack(s);
  assert.equal(isManual(s), false);
  assert.equal(s.held, false);
});

test('startVisit refused by manual mode succeeds once forceHandBack runs first', () => {
  // This is the bug camera.js's visit() had to work around: every menu
  // opener leaves the camera manual (poke() on open, re-poked every frame
  // the menu stays open), which is exactly the state startVisit refuses to
  // interrupt by default. "Look here" is an explicit request, not an
  // automatic detour, so it hands the camera back first.
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  assert.equal(startVisit(s, -30, 25, P2), false, 'sanity: still refused before the fix');
  forceHandBack(s);
  assert.equal(startVisit(s, -30, 25, P2), true);
  assert.equal(s.phase, 'visit');
  assert.equal(isManual(s), false);
});

test('grabbing the globe interrupts a running detour', () => {
  const s = initialState();
  startVisit(s, -30, 25, P2);
  assert.equal(s.phase, 'visit');
  beginManual(s);
  assert.equal(isManual(s), true);
  assert.equal(s.phase, 'return');           // visit abandoned, not resumed later
});

test('setManualView clamps latitude and wraps longitude', () => {
  const s = initialState();
  beginManual(s);
  setManualView(s, 95, 200);
  assert.equal(s.curLat, DEFAULTS.manualLatClamp);
  assert.equal(s.curLon, -160);              // wrapped into [-180, 180)
});

test('a hand can hold a polar view the walk never adopts', () => {
  // The walk bounces off latitudeClamp so it never looks down a pole on its
  // own. A hand on the globe is not the walk: stopping the drag dead at 62
  // reads as an axis lock, since longitude keeps turning while latitude does
  // not.
  const s = initialState();
  beginManual(s);
  setManualView(s, 85, 0);
  assert.equal(s.curLat, 85);
  setManualView(s, -85, 0);
  assert.equal(s.curLat, -85);
});

test('the hand-back eases down from a polar view instead of snapping', () => {
  // curLat is above the walk clamp when the display takes itself back. Clamping
  // it per frame would teleport the view 23 degrees on the first autonomous
  // frame -- the jump the hand-back exists to avoid.
  const s = initialState();
  beginManual(s);
  setManualView(s, 85, 0);
  endManual(s);
  for (let i = 0; i < 301; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);  // past 30s
  assert.equal(isManual(s), false);
  assert.ok(s.curLat > 80, `snapped to ${s.curLat} on the first frame back`);
  for (let i = 0; i < 600; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);  // 60s more
  assert.ok(s.curLat <= DEFAULTS.latClamp + 1e-9,
    `never came back inside the walk clamp: ${s.curLat}`);
});

test('a detour to a polar country still stops at the walk clamp', () => {
  // The curLat guard is the manual limit now, so nothing downstream catches an
  // out-of-range visit target. A block CAN geolocate above 62 -- Svalbard,
  // northern Greenland -- and the autonomous display must not look down the
  // pole to show it.
  const s = initialState();
  startVisit(s, 78, 15, P2);
  let peak = -90;
  for (let i = 0; i < 400; i++) {
    step(s, 0.1, HOME, P2);
    peak = Math.max(peak, s.curLat);
  }
  assert.ok(peak <= DEFAULTS.latClamp + 1e-9, `detoured to ${peak}`);
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

// ---- markInput: "somebody is still here", without claiming a pointer ------

test('markInput takes the camera off its cycle without claiming a grab', () => {
  const s = initialState();
  markInput(s);
  assert.equal(isManual(s), true, 'wheel and keys must borrow the display too');
  assert.equal(s.held, false, 'markInput must never claim a pointer is down');
});

test('markInput restarts the idle countdown, so zooming is not an empty room', () => {
  // The bug: wheel and +/- never touched the state machine at all. Drag,
  // release, then spend forty seconds zooming in on one arc, and the camera
  // decides nobody is there and flies home mid-inspection.
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  endManual(s);
  for (let i = 0; i < 250; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);   // 25s idle
  assert.equal(isManual(s), true);
  markInput(s);                                                        // a wheel notch
  assert.equal(s.idleT, 0, 'the countdown did not restart');
  for (let i = 0; i < 250; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);   // 25s more
  assert.equal(isManual(s), true, 'handed back while the user was still zooming');
});

test('markInput during a drag does not release the pointer', () => {
  // A wheel notch mid-drag must not hand the globe back. This is exactly what
  // grab()/release() on those inputs would have done.
  const s = initialState();
  beginManual(s);
  markInput(s);
  assert.equal(s.held, true, 'a live drag was released by a wheel notch');
  for (let i = 0; i < 600; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);   // 60s
  assert.equal(isManual(s), true);
});

// ---- maxHeldSeconds: the safety net ---------------------------------------

test('a pointer that never lifts cannot freeze the display forever', () => {
  // pointerup is not guaranteed: a mouse unplugged mid-press, a compositor
  // grabbing the pointer, an OS-level capture. Without this cap, step()'s
  // held branch is the only early return in the file with no bound, and the
  // wall sits frozen on a healthy feed with no degraded banner.
  const p = { ...P2, maxHeldSeconds: 300 };
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  for (let i = 0; i < 2999; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);   // 299.9s
  assert.equal(s.held, true, 'released early -- a real hold must not be cut');
  step(s, 0.2, { lat: 0, lon: 0 }, p);                                  // past 300s
  assert.equal(s.held, false, 'still held after maxHeldSeconds');
  // It falls into the ordinary idle countdown rather than snapping home.
  assert.equal(isManual(s), true);
  for (let i = 0; i < 301; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);    // +30.1s
  assert.equal(isManual(s), false, 'never handed back after the forced release');
  assert.equal(s.phase, 'return');
});

test('an ordinary drag is well inside the cap', () => {
  // The cap must be a backstop, not a time limit somebody notices. Nobody
  // holds a wall display for five minutes; two is a long drag.
  const s = initialState();
  beginManual(s);
  setManualView(s, 10, 10);
  for (let i = 0; i < 1200; i++) step(s, 0.1, { lat: 0, lon: 0 }, P2);  // 120s
  assert.equal(s.held, true);
  assert.equal(s.curLat, 10, 'the held view moved under the user');
});

test('maxHeldSeconds 0 disables the cap', () => {
  const p = { ...P2, maxHeldSeconds: 0 };
  const s = initialState();
  beginManual(s);
  for (let i = 0; i < 10000; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);  // 1000s
  assert.equal(s.held, true);
});

test('releasing and re-grabbing resets the held clock', () => {
  const p = { ...P2, maxHeldSeconds: 300 };
  const s = initialState();
  beginManual(s);
  for (let i = 0; i < 2500; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);   // 250s held
  endManual(s);
  beginManual(s);
  assert.equal(s.heldT, 0);
  for (let i = 0; i < 1000; i++) step(s, 0.1, { lat: 0, lon: 0 }, p);   // 100s more
  assert.equal(s.held, true, 'the new grab inherited the old one\'s clock');
});
