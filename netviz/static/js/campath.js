// Where the camera should be looking, as pure maths. camera.js only turns the
// result into a position; everything that decides the motion lives here so it
// can be simulated under `node --test` rather than judged by watching a wall.
//
// The change of 2026-08-09: traffic used to SET the target every 30s. With
// essentially every arc rooted at home, that pinned the view to one hemisphere
// and the display stopped feeling alive. Now ambient drift is the primary
// motion and traffic is a bias applied to it -- the camera keeps walking, and
// it still spends more of its time where the connections are.
import { cfg } from './config.js';

export const DEFAULTS = {
  // A cycle is: come back over the traffic, then set off again on a fresh
  // heading. Requested 2026-08-09 -- an endless one-way drift reads as a
  // screensaver, while coming home and leaving again reads as a display that
  // is looking at something.
  cycleSeconds: 120,
  // Return, hold, walk -- three phases, not a fixed "home time".
  //
  // This used to be a single homeSeconds: 22 covering both the flight back and
  // the hold. It gave no hold at all: `ease` is an exponential with an ~8s time
  // constant, so from 150 degrees out the camera was still 5-10 degrees short
  // when the budget ran out, and closest approach landed on the exact instant
  // the walk restarted. The display never settled on the traffic. Now the
  // return runs until it has actually arrived, and the hold is measured from
  // that moment.
  arriveDegrees: 3,       // close enough to call it home
  // 25, not 10 (2026-08-09, user request): 10s of a 120s cycle was a beat, not
  // a dwell -- the wall spent 8% of its time on the traffic it exists to show.
  // The walk still gets ~75s, which at ~2 deg/s is a 150-degree sweep, so the
  // far side of the globe is still reached every other cycle.
  holdSeconds: 25,        // stillness over the traffic before setting off again
  returnMaxSeconds: 45,   // cap, so drifting traffic cannot eat the whole cycle
  // The block-burst detour (2026-08-09, user request). A burst of blocks from
  // one country is the most interesting thing the wall can show, so the camera
  // goes and looks at it and then comes home on the ordinary return leg.
  visitSeconds: 15,       // stillness over the blocked country
  visitMaxSeconds: 25,    // cap on the flight out, same idea as returnMaxSeconds
  // 1.6 deg/s, not 1.15: at the slower rate a 98-second walk only ever reached
  // ~95 degrees from home, so the far side of the globe was never seen at all
  // (6 of 12 longitude sectors over 40 minutes). This reaches ~140.
  walkRate: 1.6,
  // Nearly off. The old design used speed modulation as the whole home bias;
  // now the return leg does that job, and leaving linger high just throttled
  // the walk -- measured, a 98-second walk reached only 96 degrees instead of
  // the ~150 the rate implies. A little is kept so the camera eases as it
  // passes over the traffic rather than sailing through at full speed.
  linger: 0.15,
  latPull: 0.6,           // how hard the return leg pulls latitude to the traffic
  // 0.2, not 0.12: the return must converge inside returnMaxSeconds from the
  // far side of the globe. At 0.12 a 180-degree return needs 34s to close to
  // 3 degrees; at 0.2 it needs 20s, which leaves the walk its share of the
  // cycle. The easing character is unchanged, only its rate.
  ease: 0.2,              // fraction of the remaining gap per second
  latClamp: 62,           // never look down the pole
  rng: Math.random,
};

// config.js overrides, applied over the tuned defaults above. Only the keys a
// user is likely to want are exposed; the rest stay where they were measured.
Object.assign(DEFAULTS, {
  cycleSeconds: cfg('camera.walk.cycleSeconds', DEFAULTS.cycleSeconds),
  holdSeconds: cfg('camera.walk.holdSeconds', DEFAULTS.holdSeconds),
  returnMaxSeconds: cfg('camera.walk.returnMaxSeconds', DEFAULTS.returnMaxSeconds),
  arriveDegrees: cfg('camera.walk.arriveDegrees', DEFAULTS.arriveDegrees),
  walkRate: cfg('camera.walk.degreesPerSecond', DEFAULTS.walkRate),
  latClamp: cfg('camera.walk.latitudeClamp', DEFAULTS.latClamp),
  visitSeconds: cfg('camera.detour.visitSeconds', DEFAULTS.visitSeconds),
  visitMaxSeconds: cfg('camera.detour.visitMaxSeconds', DEFAULTS.visitMaxSeconds),
});

/** The four cardinal points, in degrees clockwise from north. A walk follows
 *  one of these, and never the one it followed last cycle.
 *
 *  Cardinals only as of 2026-08-09, at the user's request -- the display read
 *  as favouring one direction. The eight-point set it replaced was NOT
 *  statistically biased (measured uniform over 200 cycles, 93 east / 101 west
 *  net drift), but six of its eight bearings carried an east or west component,
 *  so NE, E and SE all looked like "going east" and three eastward-looking
 *  walks in a row were an ordinary draw. Four cardinals with the previous one
 *  excluded makes every walk visibly different from the one before it. */
export const BEARINGS = [0, 90, 180, 270];

/** Signed shortest way from a to b, in degrees, in [-180, 180). */
export function deltaLon(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/** Move `pull` of the way from cur to target the short way round. */
export function blendLon(cur, target, pull) {
  return cur + deltaLon(cur, target) * pull;
}

export function initialState() {
  return {
    curLat: 20,
    curLon: 0,
    targetLat: 20,
    targetLon: 0,
    elapsed: 0,
    cycleT: Infinity,      // force a fresh heading on the first frame
    // 'return' -> 'hold' -> 'walk', once per cycle. A block burst interrupts
    // with 'visit' -> 'visitHold', after which the cycle restarts at 'return'.
    phase: 'return',
    phaseT: 0,             // seconds spent in the current phase
    visitLat: 0,           // where the detour is headed, while one is running
    visitLon: 0,
    bearing: null,         // compass direction of this cycle's walk
    lastEW: null,          // last east/west bearing, so the next one reverses it
    lastNS: null,          // likewise for north/south
    latDir: 1,             // flips when a walk reaches the latitude clamp
    cycles: 0,
  };
}

/** Pick the compass bearing for a new cycle.
 *
 *  Drawn from the eight points, excluding the previous one, so consecutive
 *  cycles genuinely set off a different way -- picking at random without that
 *  exclusion repeats about one cycle in eight, which on a two-minute cycle is
 *  a repeat every quarter hour and reads as the camera having got stuck. */
export function newHeading(state, p) {
  const rng = p.rng || Math.random;
  // Alternate the AXIS, not just the bearing.
  //
  // Cardinals alone are not enough: a due-north or due-south walk changes no
  // longitude whatsoever, so with four bearings and a free draw, half of all
  // cycles show the same meridian and the far side of the globe stops being
  // reached. Measured with a free draw over four cardinals: the no-traffic
  // case covered 1 of 12 longitude sectors, against 10 of 12 before.
  // Alternating means every other walk is an east/west one, which keeps the
  // longitude coverage while still giving a different cardinal every cycle.
  const eastWest = state.bearing === 90 || state.bearing === 270;
  const axis = state.bearing === null
    ? BEARINGS
    : (eastWest ? [0, 180] : [90, 270]);
  // Alternate the DIRECTION within the axis too, and remember it per axis.
  //
  // The old `axis.filter((b) => b !== state.bearing)` never filtered anything:
  // after the axis flip, the previous bearing is on the other axis, so east or
  // west was a free coin flip every time the east/west axis came round.
  // Measured over 400 cycles: runs of up to NINE same-direction walks, which
  // on the wall is the globe spinning several times over before it comes home
  // (reported 2026-08-09). Alternating per axis makes the sequence E N W S E N
  // W S: every walk reverses the previous one on its own axis, and east and
  // west get equal time, so there is no net drift either.
  const key = axis[0] === 90 ? 'lastEW' : 'lastNS';
  const previous = state[key] ?? null;
  const choices = axis.filter((b) => b !== previous);
  state.bearing = choices[Math.min(choices.length - 1,
                                   Math.floor(rng() * choices.length))];
  state[key] = state.bearing;
  state.latDir = 1;          // reset the pole bounce
  state.cycles += 1;
}

/** True while a block-burst detour is running. */
export function isVisiting(s) {
  return s.phase === 'visit' || s.phase === 'visitHold';
}

/**
 * Send the camera to look at a blocked country.
 *
 * Ignored while a detour is already running: the display must finish looking
 * at one thing before it is pulled to the next, or a busy feed turns the
 * camera into a metronome. Everything else -- return, hold, walk -- is
 * interruptible, because a burst outranks all of them.
 */
export function startVisit(s, lat, lon) {
  if (isVisiting(s)) return false;
  s.visitLat = lat;
  s.visitLon = lon;
  s.phase = 'visit';
  s.phaseT = 0;
  return true;
}

/**
 * One step of the rig.
 *
 * @param s        state from initialState(), mutated and returned
 * @param dt       seconds
 * @param traffic  {lat, lon} centroid of arc origins, or null when there is none
 * @param p        parameters, see DEFAULTS
 */
export function step(s, dt, traffic, p = DEFAULTS) {
  s.elapsed += dt;
  s.phaseT += dt;

  // A detour runs off the cycle clock entirely. If the cycle kept ticking, a
  // burst arriving late in one would be cut short by the rollover and the
  // camera would snap away mid-look.
  if (isVisiting(s)) {
    if (s.phase === 'visit') {
      const arrived = Math.hypot(
        s.curLat - s.visitLat, deltaLon(s.curLon, s.visitLon)) <= p.arriveDegrees;
      if (arrived || s.phaseT >= p.visitMaxSeconds) {
        s.phase = 'visitHold';
        s.phaseT = 0;
      }
    } else if (s.phaseT >= p.visitSeconds) {
      // Done looking. Restart the ordinary cycle from here, which is what
      // "resume the return home timer" means: the camera comes home from the
      // country on a full return leg rather than inheriting whatever was left
      // of the cycle the burst interrupted.
      s.cycleT = 0;
      s.phase = 'return';
      s.phaseT = 0;
      newHeading(s, p);
      return s;
    }
  }

  if (isVisiting(s)) {
    s.targetLat = s.visitLat;
    s.targetLon = s.visitLon;
    const kv = Math.min(1, p.ease * dt);
    s.curLon += deltaLon(s.curLon, s.targetLon) * kv;
    s.curLon = ((s.curLon + 180) % 360 + 360) % 360 - 180;
    s.curLat += (s.targetLat - s.curLat) * kv;
    s.curLat = Math.max(-p.latClamp, Math.min(p.latClamp, s.curLat));
    return s;
  }

  s.cycleT += dt;

  if (s.cycleT >= p.cycleSeconds) {
    s.cycleT = 0;
    s.phase = 'return';
    s.phaseT = 0;
    newHeading(s, p);
  }

  // Phase transitions. The return ends on ARRIVAL, not on a clock, so the hold
  // is a real beat of stillness over the traffic rather than whatever happened
  // to be left of a fixed budget. With no traffic there is nothing to arrive
  // at, so the cap is the only thing that advances it.
  if (s.phase === 'return' || s.phase === 'hold') {
    if (!traffic) {
      // Nothing to come home to. Skip to the walk rather than burning the
      // return cap and the hold on an empty feed -- sitting still for 55s of
      // every 120s is the stalled display this cycle exists to avoid.
      s.phase = 'walk';
      s.phaseT = 0;
    }
  }
  if (s.phase === 'return') {
    const arrived = Math.hypot(
      s.curLat - traffic.lat, deltaLon(s.curLon, traffic.lon)) <= p.arriveDegrees;
    if (arrived || s.phaseT >= p.returnMaxSeconds) {
      s.phase = 'hold';
      s.phaseT = 0;
    }
  } else if (s.phase === 'hold' && s.phaseT >= p.holdSeconds) {
    s.phase = 'walk';
    s.phaseT = 0;
  }

  if (s.phase === 'return' || s.phase === 'hold') {
    // Return leg: aim straight at the traffic. With no traffic there is
    // nowhere to return to, so the target is left alone and the display holds
    // its heading rather than snapping to an arbitrary point.
    if (traffic) {
      s.targetLon = blendLon(s.targetLon, traffic.lon, Math.min(1, 1.6 * dt));
      s.targetLat += (traffic.lat - s.targetLat) * Math.min(1, p.latPull * dt);
    }
    const k0 = Math.min(1, p.ease * dt);
    s.curLon += deltaLon(s.curLon, s.targetLon) * k0;
    s.curLon = ((s.curLon + 180) % 360 + 360) % 360 - 180;
    s.curLat += (s.targetLat - s.curLat) * k0;
    s.curLat = Math.max(-p.latClamp, Math.min(p.latClamp, s.curLat));
    return s;
  }

  // Walk leg. Longitude bias is a SPEED, not a destination.
  //
  // The obvious construction -- nudge the target some fraction of the way
  // toward the traffic every N seconds -- does the opposite of what it looks
  // like. Drift adds rate*N degrees between nudges and the nudge removes only
  // `pull` of the total, so the offset settles at rate*N*(1-pull)/pull: with
  // 0.9 deg/s, 75 s and pull 0.35 that is ~125 degrees, and the camera ends up
  // orbiting the FAR side of the traffic. Measured at 0.148 of samples within
  // 90 degrees of home, against 0.5 for no bias at all.
  //
  // Slowing the drift near the traffic instead makes dwell time fall out of
  // the speed: the camera still goes all the way round, it just takes longer
  // over the busy side. No limit cycle, no destination to overshoot.
  let rate = p.walkRate;
  if (traffic && p.linger > 0) {
    const off = (deltaLon(s.curLon, traffic.lon) * Math.PI) / 180;
    rate *= 1 - p.linger * Math.cos(off);
  }

  const b = ((s.bearing ?? 90) * Math.PI) / 180;
  // Longitude degrees are shorter near the poles, so the east component is
  // divided by cos(lat) to keep the apparent speed even. Floored, or a walk
  // near the clamp would whip round the globe.
  const cosLat = Math.max(0.45, Math.cos((s.curLat * Math.PI) / 180));
  s.targetLon += (rate * Math.sin(b) / cosLat) * dt;
  s.targetLat += rate * Math.cos(b) * s.latDir * dt;

  // Bounce off the latitude limit rather than stalling against it: a due-north
  // walk would otherwise reach the clamp in ~20s and sit there for the rest of
  // the cycle, which looks like the display has frozen.
  if (s.targetLat > p.latClamp) { s.targetLat = p.latClamp; s.latDir = -s.latDir; }
  if (s.targetLat < -p.latClamp) { s.targetLat = -p.latClamp; s.latDir = -s.latDir; }

  const k = Math.min(1, p.ease * dt);
  s.curLon += deltaLon(s.curLon, s.targetLon) * k;
  s.curLon = ((s.curLon + 180) % 360 + 360) % 360 - 180;
  const wantLat = s.targetLat;
  s.curLat += (wantLat - s.curLat) * k;
  s.curLat = Math.max(-p.latClamp, Math.min(p.latClamp, s.curLat));

  return s;
}
