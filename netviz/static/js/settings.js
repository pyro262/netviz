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
import { compileRules } from './rules.js';

// DELIBERATELY NOT DECLARED: `home`.
//
// The collector owns it: it reads NETVIZ_HOME_LAT/LON out of .env and serves
// it through /config.json, which mergeServerConfig() applies over whatever
// config.js says. A display that overrode it would fight that merge on the
// next reload -- the setting would appear to stick and then silently revert.
// It is also not a preference: a home position is site data, which is exactly
// why it lives in .env and not in this tracked tree.
//
// `arcs.rules` IS declared, as its own `rules` type, below. It is a list of
// OBJECTS, which the generic `list` type cannot describe -- `list` carries an
// element type and nothing else, so it could validate neither a matcher nor a
// per-rule color. The `rules` case in `coerce` delegates to rules.js's own
// compileRules() rather than re-deriving any of that validation, and
// arcs.setRules() is the way a compiled list reaches the display -- it
// recompiles, reports every refusal by its index, and pushes color, gain and
// bloomScale into the arcs already in the air. `arcs.highlight.*` is the
// shape every rule shares.

/**
 * type      bool | int | number | enum | color | list
 * min/max   required on int and number; see the tests
 * of        required on list: the typeof every element must equal it. Without
 *           it a list is only checked for being an array, and a wrong element
 *           type fails SILENTLY downstream -- dnsPorts: ["53"] is a perfectly
 *           good array that never matches a numeric port again.
 * strategy  uniform  — write a uniform or a field; the next frame shows it
 *           rebuild  — dispose the affected object and construct it again
 *           relayout — rebuild AND resize, because the drawing area changed
 *
 *           The strategy must describe the MECHANISM, not the importance. It is
 *           not a severity label: `rebuild` costs an extra pass and `relayout`
 *           rebuilds the composer's render targets, so anything that is really
 *           just a field write is `uniform` however dramatic it looks on screen.
 * help      why this value is what it is, lifted from the config.js comments
 */

/**
 * The eight fields an arc class carries, and the bounds each one takes. The
 * three classes differ only in their shipped values -- which live in config.js
 * -- so declaring the shape once is the only way the three cannot drift.
 *
 * THE STRATEGY HERE DESCRIBES WHAT A VIEWER WILL SEE, not how the value is
 * stored. Almost everything about an arc is copied out of the spec at spawn:
 * color into the slot's uniform, lift/maxRise into its TubeGeometry,
 * bloomScale into userData, life into slot.life. Only `speed` is re-read from
 * the live spec every frame. So a naive "it is only a field, call it uniform"
 * gives six controls that do nothing until the next arc happens to spawn --
 * and block arcs live 18s and arrive rarely, so changing block color would
 * read as a dead control. arcs.setSpec pushes the four that can be pushed into
 * the slots already in the air; the three that are baked into geometry cannot
 * be, so they are `rebuild` and clear the pool instead.
 */
function arcClass(cls, keys) {
  const FIELDS = {
    life: { type: 'number', min: 0.5, max: 60, strategy: 'uniform',
            help: 'Seconds on screen. Blocks live far longer than flows: a '
                + 'block is what the wall is for, so it stays up long enough '
                + 'to walk over and look at. Pushed into the arcs already in '
                + 'the air, so a shortened life retires them now.' },
    tube: { type: 'number', min: 0.001, max: 0.02, strategy: 'rebuild',
            help: 'Radius of the tube, in globe radii. The geometry is built '
                + 'per pool slot on spawn, so changing it clears the live arcs '
                + 'rather than editing them in place.' },
    colorAt: { type: 'number', min: 0, max: 1, strategy: 'uniform',
               help: 'Position on the plasma ramp, 0 (indigo) to 1 (pale '
                   + 'yellow). Ignored when the class carries an explicit hex. '
                   + 'Recolored into the arcs already on screen, or a block '
                   + 'recolor would wait up to 18s to show.' },
    gain: { type: 'number', min: 0.05, max: 3, strategy: 'uniform',
            help: 'Multiplies the color down; the wall usually wants less '
                + 'than 1. Use this when the line itself is too bright. Same '
                + 'live recolor as colorAt. Floored at 0.05, the same floor '
                + 'rules.js puts on a rule gain -- below it the class is '
                + 'black and the traffic simply stops being drawn.' },
    speed: { type: 'number', min: 0.05, max: 5, strategy: 'uniform',
             help: 'How fast the traveling head runs along the arc. The head '
                 + 'reaching 1 is what fires the impact ripple. The one field '
                 + 're-read from the spec every frame, so it was already live.' },
    lift: { type: 'number', min: 0, max: 2, strategy: 'rebuild',
            help: 'Apex height, scaled by how far the arc travels, so short '
                + 'hops stay flat and intercontinental arcs sweep. Baked into '
                + "the slot's TubeGeometry at spawn, so changing it clears the "
                + 'live arcs rather than bending them.' },
    maxRise: { type: 'number', min: 0.01, max: 1, strategy: 'rebuild',
               help: 'Hard cap on the apex, in globe radii. Chord runs to 2r '
                   + 'for a near-antipodal pair, and uncapped that arc peaks '
                   + '0.9r up and towers over the limb. Baked into geometry '
                   + 'like lift, so it clears the pool too.' },
    bloomScale: { type: 'number', min: 0, max: 3, strategy: 'uniform',
                  help: 'Glow only: 1 leaves the halo alone, 0.5 halves it, '
                      + 'above 1 lifts it. One bloom pass has a single '
                      + 'scene-wide threshold, so this is the only way to give '
                      + 'one class less halo without dimming its line. Pushed '
                      + 'into the live slots, which is where the bloom pass '
                      + 'reads it from.' },
  };
  const out = {};
  for (const k of keys) out[`arcs.${cls}.${k}`] = FIELDS[k];
  return out;
}

const ARC_KEYS = ['life', 'tube', 'colorAt', 'gain', 'speed', 'lift',
                  'maxRise', 'bloomScale'];
// `arcs.highlight` is the shape EVERY color rule shares. A rule carries its
// own color, and may carry its own gain and bloomScale; what is here is the
// geometry they all share, plus the gain and bloomScale a rule that omits them
// falls back to. `colorAt` is absent because a rule's color is an explicit hex
// and a ramp position would never be read.
const HIGHLIGHT_KEYS = ['life', 'tube', 'gain', 'speed', 'lift', 'maxRise', 'bloomScale'];

/** The ten `layers` booleans. Each is `mesh.visible` on one object -- or the
 *  object's own setVisible where it has one -- and each is independent of the
 *  others. `uniform`, not `rebuild`: nothing is torn down and rebuilt, and a
 *  strategy that overstates what it does costs a needless pass on every toggle.
 *  A layer switched OFF at boot was never loaded and cannot be switched on;
 *  globe.setLayer throws and the executor reports that, rather than a control
 *  appearing to work. */
function layers(entries) {
  const out = {};
  for (const [name, help] of entries) {
    out[`layers.${name}`] = { type: 'bool', strategy: 'uniform', help };
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
    type: 'list', of: 'number', strategy: 'uniform',
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
    type: 'list', of: 'string', strategy: 'uniform',
    help: 'The known public resolvers. An entry ending in `.` or `:` is a '
        + 'prefix; anything else is matched whole, so 1.1.1.10 does not match '
        + '1.1.1.1.',
  },
  'traffic.extraResolvers': {
    // NOT PERSISTED. config.js concatenates the collector's
    // NETVIZ_EXTRA_RESOLVERS onto this list at boot and the stored patch is
    // applied over it, so a saved value would be the MERGED list frozen at the
    // moment it was written -- and that display would then ignore every later
    // change to the collector's list, with nothing on screen saying why. It
    // applies live like any other setting; it simply starts from the
    // collector's current answer on every load.
    type: 'list', of: 'string', persist: false, strategy: 'uniform',
    help: 'Your own additions -- an upstream your resolver forwards to, a '
        + 'provider resolver, anything the built-in list misses. Additive, and '
        + 'the collector can add to it from NETVIZ_EXTRA_RESOLVERS. Applies '
        + 'live but is not remembered, because the collector owns the list.',
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
  'arcs.rules': {
    type: 'rules', strategy: 'uniform',
    help: 'Color rules, in precedence order: the first ENABLED rule that '
        + 'claims an arc colors it. A rule matches a subnet (10.20.50.0/24), '
        + 'an inclusive address range, a country code, or a port (tcp/443), '
        + 'against the source, the destination or either end. Blocks are never '
        + 'colored by a rule. Pushed into the arcs already in the air, so a '
        + 'recolor shows within a frame rather than on the next spawn.',
  },

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
    help: 'The fastest the walk may ever move. The rate itself is derived from '
        + 'spanDegrees and the length of the walk phase; this is the ceiling on '
        + 'that, so a short phase cannot whip the globe round.',
  },
  'camera.walk.spanDegrees': {
    type: 'number', min: 5, max: 180, strategy: 'uniform',
    help: 'How far from the traffic the walk may get, and the distance its '
        + 'ramp is sized to cover. Low keeps the arcs on screen; high sweeps '
        + 'more of the planet and puts home behind the limb.',
  },
  'camera.walk.rampFloor': {
    type: 'number', min: 0, max: 1, strategy: 'uniform',
    help: 'The fraction of its peak rate the walk sets off at. Low means it '
        + 'starts almost still and finishes fast; 1 is a flat rate, the way '
        + 'the walk behaved before the ramp.',
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
        + 'the center.',
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
  // Two bounded numbers, NOT the `list` that config.js stores. A list type
  // carries no length, no element type and no ordering, so [1.0, 9.0] would
  // pass validation and walk straight past the limb-clip floor -- and [3.3]
  // would leave the upper bound undefined, which makes clampDistance return
  // NaN and blanks the display. Indexing the array keeps `cfg('input.zoomRange.0')`,
  // which is how camera.js already reads it, working unchanged. Ordering is the
  // one thing an independent bound per index cannot express; orbit.validateZoomRange
  // is the guard for that.
  'input.zoomRange.0': {
    type: 'number', min: 3.3, max: 9.0, strategy: 'uniform',
    help: 'Closest the view may come, in globe radii. The floor is not taste: '
        + "below ~3.2 the globe's angular radius exceeds the 17.5 deg half-FOV "
        + 'of the 35 deg camera and the limb clips on a 16:9 wall.',
  },
  'input.zoomRange.1': {
    type: 'number', min: 3.3, max: 40, strategy: 'uniform',
    help: 'Furthest the view may pull back, in globe radii. Must be above '
        + 'input.zoomRange.0; a reversed pair is rejected rather than sorted, '
        + 'because guessing which end was meant is how a control starts lying.',
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
  'input.menuResumeSeconds': {
    type: 'number', min: 0, max: 3600, strategy: 'uniform',
    help: 'The same countdown, for a camera claimed by opening the menu or the '
        + 'color rules panel rather than by a drag -- a moment\'s business '
        + 'with the display, so the walk resumes shortly after it closes. The '
        + 'camera is still frozen for as long as the menu is open. Gated by '
        + 'resumeSeconds: at 0 nothing resumes at all.',
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
  'input.lock': {
    type: 'bool', strategy: 'uniform',
    help: 'Looking is always allowed; configuring is not. With this on, the '
        + 'menu refuses to open at all -- for a display in a public space, '
        + 'where the globe is the point and the controls are not.',
  },

  // ------------------------------------------------------------------ menu --
  'menu.testMode': {
    type: 'bool', strategy: 'uniform',
    help: 'Hover a layer toggle in the menu and it applies live, so you can '
        + 'see it before you click. Move away and it reverts. Only the '
        + 'twelve layer toggles preview -- not the stats rail, which resizes '
        + 'the renderer, and not the actions.',
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
      + 'language and a block lands in a shape you recognize.'],
    ['bordersWorld', 'Every international land border, at half the watched '
      + 'layer’s brightness: flatten the two together and the blocked set '
      + 'the alarm layer is about dissolves into the map.'],
    ['admin1', 'US state and Canadian province lines. Dimmest of the three line '
      + 'layers -- it helps place an arc root near home and must not out-shout '
      + 'the international borders around it.'],
    ['stars', 'Real HYG catalog stars to magnitude 6.5, placed by RA/Dec and '
      + 'turned by Greenwich sidereal time, so the constellations are real and '
      + 'correctly oriented for the moment.'],
    ['aurora', 'The auroral oval, sized by the live NOAA planetary K-index and '
      + 'centered on the geomagnetic pole -- which is why Canada sees aurora '
      + 'where Siberia does not.'],
    ['atmosphere', 'The limb glow: a shell just outside the surface that gives '
      + 'the globe an edge instead of a cut-out silhouette.'],
    ['ripples', 'Expanding ring where an arc lands. Arcs otherwise simply stop, '
      + 'which reads as "the line ended" rather than "something arrived".'],
    ['countryFlash', "The blocked country's outline lights up for 2s when a "
      + 'block lands in it.'],
    ['clouds', 'Real cloud cover, from NOAA\u2019s hourly global mosaic of every '
      + 'geostationary weather satellite. Off, or with no field fetched, the '
      + 'globe shows its baked surface alone \u2014 there is no invented weather. '
      + 'Off by default, like lightning: the fetch is gated on this setting, so '
      + 'a fresh kiosk that has never touched the menu asks NOAA for nothing.'],
    ['lightning', 'Real lightning strokes from Blitzortung\u2019s volunteer '
      + 'network, replayed at normal speed about 40 minutes behind now -- the '
      + 'archive is published on that delay and no amount of polling closes '
      + 'it. Off by default: it is the one layer a viewer is likely to read as '
      + 'happening right now, so the rail says how far behind it is.'],
  ]),

  'ripples.cooldownSeconds': {
    type: 'number', min: 0, max: 3600, strategy: 'uniform',
    help: 'One ring per target per this many seconds. Nearly every arc lands '
        + 'on the same point -- home -- so without a cooldown this is a '
        + 'permanent pulse rather than an event.',
  },

  // ---------------------------------------------------------- appearance --
  'appearance.background': {
    // 0.0088 is derived, not chosen. The dimmest thing the display draws is a
    // flow arc: colorAt 0.30 on the plasma ramp is #3b0f70, relative luminance
    // 0.0244, drawn at arcs.bodyOpacity 0.18 -- an additive contribution of
    // about 0.0044. Requiring that arc to still lift its pixel by 1.5x gives
    // 0.0044 / (1.5 - 1) = 0.0088. The shipped ground is 0.0032, so it keeps a
    // 2.4x lift and this cap leaves two-thirds of that headroom.
    //
    // RE-DERIVE THIS if the plasma ramp, bodyOpacity or the flow class moves.
    // A palette change that darkens the arcs without moving the cap makes the
    // guard too generous, which is why the shipped default is tested against
    // it rather than trusted.
    type: 'color', maxLuminance: 0.0088, strategy: 'uniform',
    help: 'The sky. #0b0916 once the bloom pass stopped adding the background '
        + 'to itself; the wall wanted darker than the original. Capped at '
        + 'luminance 0.0088 -- arcs blend additively, so a bright ground '
        + 'swallows them whatever its hue.',
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
        + 'threshold keeps the traveling heads glowing while the tube bodies '
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
    help: "Multiplies every star's color. Stars blend additively, so this is "
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

  // -------------------------------------------------------------- clouds --
  'clouds.opacity': {
    type: 'number', min: 0, max: 1, strategy: 'uniform',
    help: 'How strongly the cloud field is drawn. This is the row that decides '
        + 'whether the layer is weather behind the arcs or a fog in front of '
        + 'them; the arcs are the point, so it is deliberately low by default.',
  },
  'clouds.threshold': {
    type: 'number', min: 0, max: 1, strategy: 'uniform',
    help: 'Infrared brightness below which there is no cloud drawn at all. The '
        + 'field has a noise floor over open ocean, and drawing it linearly '
        + 'puts a grey haze over the whole planet that reads as a dirty lens.',
  },
  'clouds.nightDim': {
    type: 'number', min: 0, max: 1, strategy: 'uniform',
    help: 'How much of the daylight brightness survives on the night side. At '
        + '0 the clouds vanish at the terminator, which is truthful and looks '
        + 'like half the layer failed to load.',
  },
  'clouds.tint': {
    type: 'color', strategy: 'uniform',
    help: 'The cloud color. Near-white with a violet cast, so the layer belongs '
        + 'to the plasma scheme instead of looking like a photograph pasted on.',
  },

  // ----------------------------------------------------------- lightning --
  'lightning.flashLife': {
    type: 'number', min: 0.05, max: 2, strategy: 'uniform',
    help: 'How long a strike’s bright flash lasts, in seconds. Short is '
        + 'the point: a strike that lingers stops reading as a strike and '
        + 'starts reading as a lamp somebody left on.',
  },
  'lightning.glowLife': {
    type: 'number', min: 0.2, max: 20, strategy: 'uniform',
    help: 'How long the dim afterglow lasts. This is the row that decides '
        + 'whether a storm has a shape: at 11.5 strokes a second over a whole '
        + 'planet, flashes alone average about two lit pixels and read as '
        + 'sensor noise rather than as weather.',
  },
  'lightning.size': {
    type: 'number', min: 0.5, max: 12, strategy: 'uniform',
    help: 'Strike size in pixels, scaled to the drawing buffer like the city '
        + 'lights — so it stays the same apparent size at 1080p and 4K.',
  },
  'lightning.brightness': {
    type: 'number', min: 0, max: 3, strategy: 'uniform',
    help: 'Overall gain on the layer. It is additive and it feeds the bloom, '
        + 'so past about 1.5 a busy squall line blooms into one white smear.',
  },
  'lightning.color': {
    type: 'color', strategy: 'uniform',
    help: 'Strike color. Cold white-blue on purpose: amber is the block arcs '
        + 'and violet is the flows, and lightning is the one thing on the '
        + 'globe that is not network traffic. It must not join that vocabulary.',
  },

  // ---------------------------------------------------------------- rail --
  'rail.enabled': {
    type: 'bool', strategy: 'relayout',
    help: 'The right rail: block counts, netflow rate, feed health, clock. It '
        + 'takes 26% of the screen from the globe, so toggling it resizes the '
        + 'renderer and corrects the camera aspect.',
  },
  'rail.maxRules': {
    type: 'int', min: 1, max: 20, strategy: 'uniform',
    help: 'How many color rules the rail lists, ranked by their last hour so '
        + 'the busiest are the ones on screen. The overflow is named (+N more) '
        + 'rather than dropped: a truncated list that does not say it '
        + 'truncated is a lie about the traffic.',
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
  // These two are `uniform`, unlike the three above: they are counters compared
  // against a variable in the render loop, so writing the variable IS the whole
  // change. `rebuild` is kept for the three that genuinely clearInterval and
  // start a new timer.
  'polling.sunSeconds': {
    type: 'number', min: 0.1, max: 3600, strategy: 'uniform',
    help: 'The subsolar point moves 0.004 deg/sec, so per-frame updates are '
        + 'pure waste.',
  },
  'polling.starResyncSeconds': {
    type: 'number', min: 0.1, max: 3600, strategy: 'uniform',
    help: 'The sky turns 15 arcseconds a second, so re-syncing sidereal time '
        + 'this often is far finer than a pixel and costs one trig call.',
  },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * sRGB relative luminance, 0 (black) to 1 (white).
 *
 * Used to keep the ground dark enough for the arcs drawn on it. Arcs blend
 * ADDITIVELY, so a pixel under one is `ground + arc` -- what decides whether
 * the arc reads is how much light it adds relative to what is already there,
 * which makes the ground's absolute luminance the thing to bound, whatever
 * its hue. A contrast RATIO is the wrong tool for the same reason: it is
 * defined for opaque text over an opaque ground.
 *
 * The three-digit form is expanded rather than rejected, because HEX accepts
 * it and a cap that only understood #rrggbb would pass #fff straight through.
 */
export function relativeLuminance(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3
    ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    : h;
  const chan = (i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

export function paths() { return Object.keys(SCHEMA); }

export function entry(path) {
  return Object.prototype.hasOwnProperty.call(SCHEMA, path) ? SCHEMA[path] : null;
}

/** The shipped value, from config.js. Never a copy kept here. */
export function defaultOf(path) { return cfg(path, undefined); }

/** Names for the handful of paths whose plain-English name is not derivable
 *  from the path itself. Everything else is turned into words below, so this list only
 *  has to carry the exceptions rather than all 89 settings -- a second full
 *  copy of the catalog would drift, same reason the schema keeps no
 *  defaults. */
const LABELS = {
  'rail.enabled': 'the stats rail',
  'arcs.rules': 'your color rules',
  'input.enabled': 'touch and mouse control',
  'input.lock': 'the display lock',
  'appearance.background': 'the background color',
  'traffic.flowsPerSecond': 'how many flows are drawn per second',
};

/**
 * A path in words, for a message somebody reads before deciding something.
 *
 * `layers.cityLights` -> "the city lights layer", `camera.walk.holdSeconds` ->
 * "camera walk hold seconds". Not pretty for every one of the 89, and it does
 * not need to be: it appears in a list of what a reset would forget, where the
 * job is recognizing the setting you changed, not admiring the prose.
 */
export function settingLabel(path) {
  if (Object.prototype.hasOwnProperty.call(LABELS, path)) return LABELS[path];
  const parts = String(path).split('.');
  const words = parts
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase())
    .join(' ');
  if (parts[0] === 'layers') return `the ${words.replace(/^layers /, '')} layer`;
  return words;
}

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
    case 'color': {
      // Shape first. relativeLuminance('nope') returns a number out of NaN
      // arithmetic rather than throwing, so checking brightness first would
      // report a typo as a brightness problem.
      if (typeof value !== 'string' || !HEX.test(value)) {
        return { ok: false, why: 'not a #rgb or #rrggbb color' };
      }
      if (typeof e.maxLuminance === 'number') {
        const L = relativeLuminance(value);
        if (L > e.maxLuminance) {
          // Refused, not darkened: a color somebody picked is an intent, and
          // silently scaling it down is how a control starts lying. The
          // reason carries both numbers so it can be acted on.
          return { ok: false,
                   why: `too bright to draw on: luminance ${L.toFixed(4)}, `
                      + `cap ${e.maxLuminance}` };
        }
      }
      return { ok: true, value };
    }
    case 'list': {
      if (!Array.isArray(value)) return { ok: false, why: 'not a list' };
      // Element type, not just "is it an array". `traffic.dnsPorts: ["53"]`
      // coerced fine and then never matched anything, because isDnsPort tests
      // with .includes(port) against a NUMBER -- so DNS quietly stopped being
      // filtered and every resolver arc came back, with nothing reporting a
      // problem. A list whose elements are the wrong type is the same class of
      // silent failure as a number outside its bounds.
      if (e.of) {
        const bad = value.findIndex((el) => typeof el !== e.of); // eslint-disable-line valid-typeof
        if (bad !== -1) {
          return { ok: false,
                   why: `element ${bad} is ${typeof value[bad]}, not ${e.of}` };
        }
      }
      return { ok: true, value };
    }
    case 'rules': {
      if (!Array.isArray(value)) return { ok: false, why: 'not a list of rules' };
      // Delegated, never re-derived: rules.js owns every bound (a hex color,
      // gain 0.05-2.0, bloomScale 0-2.0, a prefix length inside its family's
      // width). A second copy here would drift, and the panel, an imported
      // file and any future write API must obey one set.
      const { refused } = compileRules(value);
      if (refused.length) {
        // ALL-or-nothing, unlike a live edit. A patch arriving here is one
        // deliberate act -- an import, an API call, a restored profile -- and
        // half of one is confusing. The panel filters its own half-typed rows
        // before it ever calls apply().
        const first = refused[0];
        return { ok: false, why: `rule ${first.index + 1}: ${first.reason}` };
      }
      return { ok: true, value };
    }
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
