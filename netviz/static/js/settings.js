// Every setting the renderer has, declared once.
//
// This file is DATA plus the pure functions over it: no three, no DOM, no
// fetch, so it runs under `node --test`. It is the single source for the
// panel's controls, for validation on the write API, for validation of an
// imported profile, and for the generated documentation.
//
// It deliberately carries NO default values. `config.js` is where the shipped
// numbers live and where the prose explaining them lives; a second copy here
// would drift, and the panel would then report the drift to every kiosk as a
// setting that disagrees with itself. `defaultOf()` reads config.js instead.
//
// Bounds, on the other hand, live HERE and nowhere else. A hand-edited profile
// must not be able to smuggle a value past the panel's limits, so the same
// clamp has to apply to the UI, the API and the file.
import { cfg } from './config.js';

// DELIBERATELY NOT DECLARED: `home` and `highlight.networks.*`.
//
// The collector owns both. It reads NETVIZ_HOME_LAT/LON and
// NETVIZ_HIGHLIGHT{1,2,3}_* out of .env and serves them to the page through
// /config.json, which mergeServerConfig() applies over whatever config.js says.
// A display that overrode either would fight that merge on the next reload --
// the setting would appear to stick and then silently revert. They are also not
// preferences: a home position and a set of LAN address prefixes are site data,
// which is exactly why they live in .env and not in this tracked tree.

/**
 * type      bool | int | number | enum | color | list
 * strategy  uniform  — write a uniform or a field; the next frame shows it
 *           rebuild  — dispose the affected object and construct it again
 *           relayout — rebuild AND resize, because the drawing area changed
 * help      why this value is what it is, lifted from the config.js comments
 */

/** The eight fields an arc class carries, and the bounds each one takes. The
 *  three classes differ only in their shipped values -- which live in config.js
 *  -- so declaring the shape once is the only way the three cannot drift. */
function arcClass(cls, keys) {
  const FIELDS = {
    life: { type: 'number', min: 0.5, max: 60, strategy: 'uniform',
            help: 'Seconds on screen. Blocks live far longer than flows: a '
                + 'block is what the wall is for, so it stays up long enough '
                + 'to walk over and look at.' },
    tube: { type: 'number', min: 0.001, max: 0.02, strategy: 'rebuild',
            help: 'Radius of the tube, in globe radii. The geometry is built '
                + 'per pool slot on spawn, so changing it clears the live arcs '
                + 'rather than editing them in place.' },
    colorAt: { type: 'number', min: 0, max: 1, strategy: 'uniform',
               help: 'Position on the plasma ramp, 0 (indigo) to 1 (pale '
                   + 'yellow). Ignored when the class carries an explicit hex.' },
    gain: { type: 'number', min: 0, max: 3, strategy: 'uniform',
            help: 'Multiplies the colour down; the wall usually wants less '
                + 'than 1. Use this when the line itself is too bright.' },
    speed: { type: 'number', min: 0.05, max: 5, strategy: 'uniform',
             help: 'How fast the travelling head runs along the arc. The head '
                 + 'reaching 1 is what fires the impact ripple.' },
    lift: { type: 'number', min: 0, max: 2, strategy: 'uniform',
            help: 'Apex height, scaled by how far the arc travels, so short '
                + 'hops stay flat and intercontinental arcs sweep.' },
    maxRise: { type: 'number', min: 0.01, max: 1, strategy: 'uniform',
               help: 'Hard cap on the apex, in globe radii. Chord runs to 2r '
                   + 'for a near-antipodal pair, and uncapped that arc peaks '
                   + '0.9r up and towers over the limb.' },
    bloomScale: { type: 'number', min: 0, max: 3, strategy: 'uniform',
                  help: 'Glow only: 1 leaves the halo alone, 0.5 halves it, '
                      + 'above 1 lifts it. One bloom pass has a single '
                      + 'scene-wide threshold, so this is the only way to give '
                      + 'one class less halo without dimming its line.' },
  };
  const out = {};
  for (const k of keys) out[`arcs.${cls}.${k}`] = FIELDS[k];
  return out;
}

const ARC_KEYS = ['life', 'tube', 'colorAt', 'gain', 'speed', 'lift',
                  'maxRise', 'bloomScale'];
// The highlight classes take their colour and gain from `highlight.networks`,
// which the collector owns -- so the shared shape carries neither.
const HIGHLIGHT_KEYS = ['life', 'tube', 'speed', 'lift', 'maxRise', 'bloomScale'];

/** The ten `layers` booleans. Each is `mesh.visible` on one object, and each is
 *  independent of the others. */
function layers(entries) {
  const out = {};
  for (const [name, help] of entries) {
    out[`layers.${name}`] = { type: 'bool', strategy: 'rebuild', help };
  }
  return out;
}

export const SCHEMA = {
  // ------------------------------------------------------------- traffic --
  'traffic.flowsPerSecond': {
    type: 'int', min: 1, max: 60, strategy: 'uniform',
    help: 'Flows drawn per second. The live feed can run tens of events per '
        + 'second and every arc blends additively, so drawing all of them sums '
        + 'into a wash that hides the globe. Blocks are never sampled.',
  },
  'traffic.dropDns': {
    type: 'bool', strategy: 'uniform',
    help: 'Drop nameserver chatter from the display. On most networks it is '
        + '20-30% of events and almost none of the bytes, and it nearly all '
        + 'geolocates to one country-centroid point, so undropped it draws as '
        + 'a crowd of arcs converging somewhere nothing actually is. The '
        + 'collector still records every one of them.',
  },
  'traffic.dnsPorts': {
    type: 'list', strategy: 'uniform',
    help: 'Ports that mean DNS, matched on either end: 53 plain, 853 '
        + 'DNS-over-TLS, 5353 mDNS. Resolvers answer FROM 53 and clients query '
        + 'TO 53, and both directions are on the feed.',
  },
  'traffic.dropResolvers': {
    type: 'bool', strategy: 'uniform',
    help: 'Also drop anything to or from a known public resolver, whatever '
        + 'port it is on. The port rule already catches plain DNS and '
        + 'DNS-over-TLS; what it cannot catch is DNS-over-HTTPS, which is port '
        + '443 and looks exactly like web traffic. Blocks are never suppressed.',
  },
  'traffic.resolvers': {
    type: 'list', strategy: 'uniform',
    help: 'The known public resolvers. An entry ending in `.` or `:` is a '
        + 'prefix; anything else is matched whole, so 1.1.1.10 does not match '
        + '1.1.1.1.',
  },
  'traffic.extraResolvers': {
    type: 'list', strategy: 'uniform',
    help: 'Your own additions -- an upstream your resolver forwards to, a '
        + 'provider resolver, anything the built-in list misses. Additive, and '
        + 'the collector can add to it from NETVIZ_EXTRA_RESOLVERS.',
  },

  // ---------------------------------------------------------------- arcs --
  'arcs.bodyOpacity': {
    type: 'number', min: 0.04, max: 1.0, strategy: 'uniform',
    help: 'Opacity of an arc body. Below about 0.04 traffic is invisible. '
        + 'Deliberately low: arcs blend additively and overlap heavily along '
        + 'the busiest corridor.',
  },
  ...arcClass('flow', ARC_KEYS),
  ...arcClass('block', ARC_KEYS),
  ...arcClass('highlight', HIGHLIGHT_KEYS),

  // -------------------------------------------------------------- camera --
  'camera.distance': {
    type: 'number', min: 3.3, max: 9.0, strategy: 'uniform',
    help: 'Camera distance in globe radii, and the framing the display returns '
        + 'to after somebody has zoomed. The floor is not taste: below ~3.2 the '
        + "globe's angular radius exceeds the 17.5 deg half-FOV of the 35 deg "
        + 'camera and the limb clips on a 16:9 wall.',
  },
  'camera.walk.enabled': {
    type: 'bool', strategy: 'uniform',
    help: 'The camera returns to the traffic, holds, then walks off on a fresh '
        + 'cardinal bearing. Off parks it over the traffic instead.',
  },
  'camera.walk.cycleSeconds': {
    type: 'number', min: 10, max: 3600, strategy: 'uniform',
    help: 'One full return-hold-walk cycle. An endless one-way drift reads as '
        + 'a screensaver; coming home and leaving again reads as a display that '
        + 'is looking at something.',
  },
  'camera.walk.holdSeconds': {
    type: 'number', min: 0, max: 600, strategy: 'uniform',
    help: 'Stillness over the traffic before setting off. 10s of a 120s cycle '
        + 'was a beat rather than a dwell -- the wall spent 8% of its time on '
        + 'the traffic it exists to show.',
  },
  'camera.walk.returnMaxSeconds': {
    type: 'number', min: 1, max: 600, strategy: 'uniform',
    help: 'Cap on the flight home, so drifting traffic cannot eat a whole '
        + 'cycle. The return normally ends on arrival, not on this clock.',
  },
  'camera.walk.arriveDegrees': {
    type: 'number', min: 0.1, max: 30, strategy: 'uniform',
    help: 'Close enough to call it home. The easing is exponential and never '
        + 'actually lands, so the return needs a radius to end at.',
  },
  'camera.walk.degreesPerSecond': {
    type: 'number', min: 0, max: 20, strategy: 'uniform',
    help: 'Walk rate. At 1.15 a 98-second walk only ever reached ~95 degrees '
        + 'from home and the far side of the globe was never seen; 1.6 reaches '
        + '~140.',
  },
  'camera.walk.latitudeClamp': {
    type: 'number', min: 0, max: 89, strategy: 'uniform',
    help: 'The walk never looks down a pole, and bounces off this rather than '
        + 'stalling against it -- a due-north walk otherwise hits the limit in '
        + '~20s and sits there for the rest of the cycle. A hand is not clamped '
        + 'here; see input.',
  },
  'camera.detour.enabled': {
    type: 'bool', strategy: 'uniform',
    help: 'A burst of blocks from one country is the most interesting thing '
        + 'the wall can show, so the camera goes and looks at it.',
  },
  'camera.detour.blocks': {
    type: 'int', min: 1, max: 100, strategy: 'uniform',
    help: 'This many blocks from one country trigger a detour. A single block '
        + 'must not move the camera: they arrive at all hours from scanners, '
        + 'and a wall that jumps at each one is a wall nobody can read.',
  },
  'camera.detour.withinSeconds': {
    type: 'number', min: 1, max: 600, strategy: 'uniform',
    help: 'The window the blocks must land inside to count as a burst.',
  },
  'camera.detour.quietSeconds': {
    type: 'number', min: 0, max: 3600, strategy: 'uniform',
    help: 'After a detour that country cannot trigger again for this long, or '
        + 'a sustained burst re-fires on the first event after every cooldown '
        + '-- a timer firing, not a burst being detected.',
  },
  'camera.detour.visitSeconds': {
    type: 'number', min: 0, max: 300, strategy: 'uniform',
    help: 'Stillness over the blocked country once the camera arrives.',
  },
  'camera.detour.visitMaxSeconds': {
    type: 'number', min: 1, max: 300, strategy: 'uniform',
    help: 'Cap on the flight out, same idea as camera.walk.returnMaxSeconds.',
  },
  'camera.detour.interruptManual': {
    type: 'bool', strategy: 'uniform',
    help: 'A block burst does not take a view somebody is holding, and a burst '
        + 'arriving during a drag is dropped rather than queued -- letting go '
        + 'must not launch a flight to somewhere nobody asked for, seconds '
        + 'after the event that caused it. On reverses that.',
  },

  // --------------------------------------------------------------- input --
  'input.enabled': {
    type: 'bool', strategy: 'uniform',
    help: 'Direct manipulation as a whole. The display is autonomous and a '
        + 'person borrows it; off makes the wall untouchable again.',
  },
  'input.drag': {
    type: 'bool', strategy: 'uniform',
    help: 'Drag to turn the globe. Solved rather than mapped from pixels, so '
        + 'the grabbed point stays under the pointer at the limb as well as at '
        + 'the centre.',
  },
  'input.zoom': {
    type: 'bool', strategy: 'uniform',
    help: 'Wheel or pinch to move closer. Two live pointers is a pinch and '
        + 'only a pinch: the midpoint drifts, and turning the globe by that '
        + 'drift reads as a wobble.',
  },
  'input.keyboard': {
    type: 'bool', strategy: 'uniform',
    help: 'Arrows to turn, +/- to zoom, f for fullscreen -- the things a '
        + 'pointer is clumsy at.',
  },
  'input.zoomRange': {
    type: 'list', strategy: 'uniform',
    help: 'Closest and furthest, in globe radii. The floor is not taste: below '
        + "~3.2 the globe's angular radius exceeds the 17.5 deg half-FOV of the "
        + '35 deg camera and the limb clips on a 16:9 wall.',
  },
  'input.zoomFactor': {
    type: 'number', min: 1.01, max: 2.0, strategy: 'uniform',
    help: 'Per wheel notch, multiplicative.',
  },
  'input.rollReturnEase': {
    type: 'number', min: 0, max: 10, strategy: 'uniform',
    help: 'How fast the roll a drag leaves behind unwinds once the display has '
        + 'taken itself back, as a fraction of the remaining angle per second. '
        + 'The view is already easing home over the return leg, and the horizon '
        + 'should be level by the time it arrives.',
  },
  'input.inertia': {
    type: 'number', min: 0, max: 0.99, strategy: 'uniform',
    help: "Fraction of a fling's speed remaining after one second. 0 stops "
        + 'dead, which reads as broken; 1 never settles. Decayed with '
        + 'pow(damping, dt), so fling distance does not depend on frame rate.',
  },
  'input.invert': {
    type: 'bool', strategy: 'uniform',
    help: 'Reverse the direction a drag turns the globe.',
  },
  'input.resumeSeconds': {
    type: 'number', min: 0, max: 3600, strategy: 'uniform',
    help: 'Idle seconds before the camera takes itself back. 0 never resumes, '
        + 'which makes a panned view permanent -- right for a desk and wrong '
        + 'for a wall nobody is standing at. Measured in RENDERED time, so a '
        + 'hidden tab stops the countdown entirely.',
  },
  'input.zoomReturnEase': {
    type: 'number', min: 0, max: 10, strategy: 'uniform',
    help: 'How fast the distance eases back to camera.distance once the '
        + 'display has taken itself back. Orientation is not the only thing a '
        + 'passer-by borrows: without this a globe pulled in to 3.3 radii stays '
        + 'wrongly framed after the view has already come home.',
  },
  'input.hideCursorSeconds': {
    type: 'number', min: 0, max: 600, strategy: 'uniform',
    help: 'An arrow parked on a dark wall for a week is the most visible thing '
        + 'in the room. 0 keeps it visible.',
  },

  // -------------------------------------------------------------- layers --
  ...layers([
    ['cityLights', 'The bright city sprites that bloom. The dimmer night-lights '
      + 'glow baked into the surface texture is part of the globe itself and '
      + 'stays either way.'],
    ['coastline', 'Coastlines as line geometry, which stays 1px crisp at the '
      + 'limb where texture filtering turns to mush.'],
    ['bordersWatched', 'Outlines for the geo-blocked countries, in the block '
      + 'amber -- so outline, arc, ripple and arrival flash are one visual '
      + 'language and a block lands in a shape you recognise.'],
    ['bordersWorld', 'Every international land border, at half the watched '
      + 'layer’s brightness: flatten the two together and the blocked set '
      + 'the alarm layer is about dissolves into the map.'],
    ['admin1', 'US state and Canadian province lines. Dimmest of the three line '
      + 'layers -- it helps place an arc root near home and must not out-shout '
      + 'the international borders around it.'],
    ['stars', 'Real HYG catalogue stars to magnitude 6.5, placed by RA/Dec and '
      + 'turned by Greenwich sidereal time, so the constellations are real and '
      + 'correctly oriented for the moment.'],
    ['aurora', 'The auroral oval, sized by the live NOAA planetary K-index and '
      + 'centred on the geomagnetic pole -- which is why Canada sees aurora '
      + 'where Siberia does not.'],
    ['atmosphere', 'The limb glow: a shell just outside the surface that gives '
      + 'the globe an edge instead of a cut-out silhouette.'],
    ['ripples', 'Expanding ring where an arc lands. Arcs otherwise simply stop, '
      + 'which reads as "the line ended" rather than "something arrived".'],
    ['countryFlash', "The blocked country's outline lights up for 2s when a "
      + 'block lands in it.'],
  ]),

  'ripples.cooldownSeconds': {
    type: 'number', min: 0, max: 3600, strategy: 'uniform',
    help: 'One ring per target per this many seconds. Nearly every arc lands '
        + 'on the same point -- home -- so without a cooldown this is a '
        + 'permanent pulse rather than an event.',
  },

  // ---------------------------------------------------------- appearance --
  'appearance.background': {
    type: 'color', strategy: 'uniform',
    help: 'The sky. #0b0916 once the bloom pass stopped adding the background '
        + 'to itself; the wall wanted darker than the original.',
  },
  'appearance.bloom.strength': {
    type: 'number', min: 0, max: 2.0, strategy: 'uniform',
    help: 'UnrealBloomPass strength. Raising it cannot rescue a base pass that '
        + 'is already blown out -- lower traffic.flowsPerSecond instead. Judge '
        + 'it against the fixed selective-bloom pass, not against old '
        + 'screenshots taken while the atmosphere was occluding the glow.',
  },
  'appearance.bloom.radius': {
    type: 'number', min: 0, max: 2, strategy: 'uniform',
    help: 'How far the halo spreads from what casts it.',
  },
  'appearance.bloom.threshold': {
    type: 'number', min: 0, max: 1, strategy: 'uniform',
    help: 'Luminance a pixel must clear to glow at all. 0.9/0.05 blew the arc '
        + 'bodies out into a haze on a bright wall panel; a slightly higher '
        + 'threshold keeps the travelling heads glowing while the tube bodies '
        + 'stay linear.',
  },
  'appearance.bloom.knee': {
    type: 'number', min: 0, max: 4, strategy: 'uniform',
    help: 'Reinhard knee on the bloom term: bloom / (1 + bloom * knee). Barely '
        + 'touches a lone arc (0.2 -> 0.18) while 3.0 comes back as 1.07, so a '
        + 'pile-up reads as "many arcs" rather than "one flare".',
  },
  'appearance.starBrightness': {
    type: 'number', min: 0, max: 4.0, strategy: 'uniform',
    help: "Multiplies every star's colour. Stars blend additively, so this is "
        + 'a straight scale on the light each one contributes. Deliberately '
        + 'NOT applied to the per-magnitude alpha: that curve saturates at 1, '
        + 'so scaling it there would flatten every star brighter than mag 3 to '
        + 'the same value and lose Sirius against Polaris.',
  },
  'appearance.starDayGain': {
    type: 'number', min: 1, max: 8, strategy: 'uniform',
    help: 'Daylight makes a kiosk screen hard to read, so the stars are driven '
        + "harder while the sun is up at the collector's home position and fall "
        + 'back to starBrightness at night. 1.0 disables it.',
  },
  'appearance.starRampMinutes': {
    type: 'number', min: 1, max: 240, strategy: 'uniform',
    help: 'The day ramp is ramped rather than switched, over this many minutes '
        + 'from sunrise and again from sunset, so the change lands while the '
        + 'sky on the globe is already moving.',
  },

  // ---------------------------------------------------------------- rail --
  'rail.enabled': {
    type: 'bool', strategy: 'relayout',
    help: 'The right rail: block counts, netflow rate, feed health, clock. It '
        + 'takes 26% of the screen from the globe, so toggling it resizes the '
        + 'renderer and corrects the camera aspect.',
  },

  // ------------------------------------------------------------- polling --
  'polling.healthSeconds': {
    type: 'number', min: 1, max: 3600, strategy: 'rebuild',
    help: '/health.json -- this one is the degraded-mode alarm, so it polls '
        + 'faster than the build check.',
  },
  'polling.railSeconds': {
    type: 'number', min: 1, max: 3600, strategy: 'rebuild',
    help: '/stats.json, and only polled while the rail is on.',
  },
  'polling.buildSeconds': {
    type: 'number', min: 5, max: 3600, strategy: 'rebuild',
    help: '/build.json -- reload the kiosk when the deployed assets change. '
        + 'Deploys are aperiodic, so this is the slowest of the three.',
  },
  'polling.sunSeconds': {
    type: 'number', min: 0.1, max: 3600, strategy: 'rebuild',
    help: 'The subsolar point moves 0.004 deg/sec, so per-frame updates are '
        + 'pure waste.',
  },
  'polling.starResyncSeconds': {
    type: 'number', min: 0.1, max: 3600, strategy: 'rebuild',
    help: 'The sky turns 15 arcseconds a second, so re-syncing sidereal time '
        + 'this often is far finer than a pixel and costs one trig call.',
  },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function paths() { return Object.keys(SCHEMA); }

export function entry(path) {
  return Object.prototype.hasOwnProperty.call(SCHEMA, path) ? SCHEMA[path] : null;
}

/** The shipped value, from config.js. Never a copy kept here. */
export function defaultOf(path) { return cfg(path, undefined); }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Bring a value to the declared type and bounds.
 *
 * A number outside its range is CLAMPED rather than refused: a slider dragged
 * to the end and a hand-edited file are the same input here, and refusing
 * leaves the old value on screen with no feedback, which reads as a broken
 * control. A value of the wrong shape is refused, because there is no honest
 * way to guess what was meant.
 */
export function coerce(path, value) {
  const e = entry(path);
  if (!e) return { ok: false, why: 'no such setting' };
  switch (e.type) {
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, why: 'not a boolean' };
      return { ok: true, value };
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, why: 'not a finite number' };
      }
      const c = clamp(value, e.min, e.max);
      return { ok: true, value: e.type === 'int' ? Math.round(c) : c };
    }
    case 'enum':
      if (!e.values.includes(value)) {
        return { ok: false, why: `not one of ${e.values.join(', ')}` };
      }
      return { ok: true, value };
    case 'color':
      if (typeof value !== 'string' || !HEX.test(value)) {
        return { ok: false, why: 'not a #rgb or #rrggbb colour' };
      }
      return { ok: true, value };
    case 'list':
      if (!Array.isArray(value)) return { ok: false, why: 'not a list' };
      return { ok: true, value };
    default:
      return { ok: false, why: `unhandled type ${e.type}` };
  }
}

/** Split a patch into what can be applied and what cannot. Never throws: a bad
 *  key in an imported profile must not cost the display the other 79. */
export function validate(patch) {
  const accepted = {};
  const rejected = [];
  for (const [path, value] of Object.entries(patch || {})) {
    const c = coerce(path, value);
    if (c.ok) accepted[path] = c.value;
    else rejected.push({ path, value, why: c.why });
  }
  return { accepted, rejected };
}

/**
 * Group a patch by apply strategy.
 *
 * Order matters and is fixed by the caller, not here: uniform first because it
 * is free, then rebuild, then at most ONE relayout however many keys asked for
 * it -- a resize rebuilds the composer's render targets, so toggling three
 * things that each need one must still cost one.
 */
export function planApply(patch) {
  const plan = { uniform: [], rebuild: [], relayout: false };
  for (const path of Object.keys(patch || {})) {
    const e = entry(path);
    if (!e) continue;
    if (e.strategy === 'relayout') plan.relayout = true;
    else plan[e.strategy].push(path);
  }
  return plan;
}
