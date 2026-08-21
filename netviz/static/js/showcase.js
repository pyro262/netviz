// "Show me how this looks" -- the renderer half of Test Mode.
//
// A wall display is judged by eye, and the hard case is judging something that
// is NOT CURRENTLY HAPPENING. An aurora on a quiet night, a blocked arc when
// nothing is being blocked, a custom arc whose rule has never fired: all of
// them are invisible exactly when you want to decide whether they look right.
// This forces them on for a while and then puts everything back.
//
// THREE RULES, and each one is the difference between a tool and a nuisance:
//
//   * NOTHING IS INJECTED AS AN EVENT. Sample arcs go straight through the arc
//     pool with an explicit class, so they never reach classify.js or the
//     rail's counters. A showing that moved the numbers would corrupt the very
//     statistics somebody is standing there reading.
//   * EVERYTHING IS PUT BACK. Whatever a showing turns on is restored when it
//     ends, including a layer that was already on before -- restoring to "on"
//     is as much a restore as restoring to "off", and only the recorded value
//     knows which.
//   * IT ENDS BY ITSELF. A showing has a duration and a stop, and closing the
//     panel does NOT end it -- the whole point is to watch the globe without a
//     panel over it.
//
// Everything it drives is injected, so the whole of it runs under `node --test`
// against stubs, including the restore path.

/** Where sample arcs come from. Real places, far apart, so the arcs cross
 *  enough of the globe to be worth looking at -- and deliberately NOT the
 *  deployment's own peers, which are site data. */
export const SAMPLE_ORIGINS = [
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Sao Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Cape Town', lat: -33.92, lon: 18.42 },
  { name: 'Reykjavik', lat: 64.15, lon: -21.94 },
];

/** Where sample lightning lands. Scattered rather than random so a showing
 *  looks the same twice -- somebody comparing two settings needs the only
 *  difference to be the setting. */
export const SAMPLE_STRIKES = [
  { lat: 5, lon: -60 }, { lat: -8, lon: -55 }, { lat: 2, lon: 20 },
  { lat: -14, lon: 28 }, { lat: 10, lon: 105 }, { lat: -6, lon: 115 },
  { lat: 28, lon: -92 }, { lat: 35, lon: 138 }, { lat: -25, lon: 145 },
  { lat: 45, lon: 8 }, { lat: 18, lon: 78 }, { lat: -33, lon: -62 },
];

/** Which settings a showing writes, so the restore knows what to record.
 *  A path that a showing can CHANGE but the restore cannot PUT BACK is a
 *  one-way door -- the same argument settings_panel's allPaths() makes. */
export const TOUCHED_PATHS = [
  'layers.lightning', 'layers.clouds', 'layers.countryFlash',
  'layers.aurora', 'layers.ripples',
];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/**
 * @param deps.arcs        the arc pool: spawn(ev, cls, sups)
 * @param deps.aurora      __setReading({kp, stale}) and debug()
 * @param deps.lightning   showSamples(points) -- optional
 * @param deps.globe       flashCountry(code) -- optional
 * @param deps.settings    the persisting applier, for layer toggles
 * @param deps.read        cfg-like reader: (path, fallback) => value
 * @param deps.home        () => {lat, lon} or null
 * @param deps.watched     () => country codes with a border bake, or []
 * @param deps.now         () => ms, injected so a test need not sleep
 */
export function createShowcase(deps = {}) {
  const { arcs, aurora, lightning, globe, settings, read, home, watched,
          now = () => Date.now() } = deps;

  let running = null;      // { until, restore, items }

  const cfgv = (path, fallback) => (read ? read(path, fallback) : fallback);

  function apply(patch) {
    if (settings && Object.keys(patch).length) settings.apply(patch);
  }

  /** One sample arc, drawn with an EXPLICIT class so classify.js never runs. */
  function drawArc(cls, i) {
    if (!arcs || !arcs.spawn) return 0;
    const o = SAMPLE_ORIGINS[i % SAMPLE_ORIGINS.length];
    const h = (home && home()) || { lat: 0, lon: 0 };
    arcs.spawn({ k: cls === 'block' ? 'block' : 'flow',
                 sll: [o.lat, o.lon], dll: [h.lat, h.lon], b: 1 }, cls, []);
    return 1;
  }

  /** Which items a showing would run, given what is ticked and what this
   *  display can actually do. Reported rather than silently reduced: an item
   *  that cannot run should say so, not look like it ran. */
  function plan() {
    const want = {
      aurora: cfgv('test.show.aurora', false),
      blocked: cfgv('test.show.blocked', false),
      flow: cfgv('test.show.flow', false),
      customArcs: cfgv('test.show.customArcs', false),
      lightning: cfgv('test.show.lightning', false),
      clouds: cfgv('test.show.clouds', false),
      countryFlash: cfgv('test.show.countryFlash', false),
      ripples: cfgv('test.show.ripples', false),
    };
    const items = [];
    const skipped = [];
    const add = (id, ok, why) => {
      if (!want[id]) return;
      if (ok) items.push(id);
      else skipped.push({ id, why });
    };
    add('aurora', !!(aurora && aurora.__setReading),
        'this build has no aurora layer');
    add('blocked', !!(arcs && arcs.spawn), 'the arc pool is not available');
    add('flow', !!(arcs && arcs.spawn), 'the arc pool is not available');
    add('customArcs', !!(arcs && arcs.spawn)
        && (cfgv('arcs.custom', []) || []).length > 0,
        'no custom arcs are defined on this display');
    add('lightning', !!(lightning && lightning.showSamples),
        'this build has no lightning layer');
    add('clouds', true, null);
    add('countryFlash', !!(globe && globe.flashCountry)
        && ((watched && watched()) || []).length > 0,
        'no watched-country outlines are baked into this build');
    add('ripples', !!(arcs && arcs.spawn), 'the arc pool is not available');
    return { items, skipped };
  }

  function start() {
    if (running) stop();
    const { items, skipped } = plan();
    if (!items.length) return { started: false, items, skipped };

    // RECORDED BEFORE ANYTHING IS TOUCHED, and recorded as VALUES rather than
    // as "was it on": restoring a layer that was already on is as much a
    // restore as restoring one that was off, and only the value knows which.
    const restore = {};
    for (const path of TOUCHED_PATHS) restore[path] = cfgv(path, null);
    const auroraBefore = aurora && aurora.debug ? aurora.debug() : null;

    const on = {};
    if (items.includes('aurora')) on['layers.aurora'] = true;
    if (items.includes('lightning')) on['layers.lightning'] = true;
    if (items.includes('clouds')) on['layers.clouds'] = true;
    if (items.includes('countryFlash')) on['layers.countryFlash'] = true;
    if (items.includes('ripples')) on['layers.ripples'] = true;
    apply(on);

    if (items.includes('aurora')) {
      aurora.__setReading({ kp: cfgv('test.show.auroraKp', 7), stale: false });
    }
    if (items.includes('lightning')) lightning.showSamples(SAMPLE_STRIKES);
    if (items.includes('countryFlash')) {
      const codes = watched() || [];
      globe.flashCountry(codes[0]);
    }
    let arcsDrawn = 0;
    if (items.includes('flow') || items.includes('ripples')) {
      for (let i = 0; i < 3; i += 1) arcsDrawn += drawArc('flow', i);
    }
    if (items.includes('blocked')) {
      for (let i = 0; i < 3; i += 1) arcsDrawn += drawArc('block', i + 1);
    }
    if (items.includes('customArcs')) {
      const list = cfgv('arcs.custom', []) || [];
      for (let i = 0; i < list.length; i += 1) arcsDrawn += drawArc(`rule${i + 1}`, i);
    }

    running = {
      until: now() + cfgv('test.show.seconds', 30) * 1000,
      restore,
      auroraBefore,
      items,
    };
    return { started: true, items, skipped, arcsDrawn };
  }

  function stop() {
    if (!running) return false;
    const { restore, auroraBefore } = running;
    running = null;
    const patch = {};
    for (const [path, v] of Object.entries(restore)) {
      if (v !== null && v !== undefined) patch[path] = v;
    }
    apply(patch);
    // The aurora's reading is not a setting and is not in the patch: it goes
    // back through the same hook that forced it, so the display returns to
    // whatever NOAA last said rather than to a default.
    if (auroraBefore && aurora && aurora.__setReading && has(auroraBefore, 'kp')) {
      aurora.__setReading({ kp: auroraBefore.kp, stale: auroraBefore.stale });
    }
    return true;
  }

  /** Driven from the render loop. A showing ends on its own clock so closing
   *  the panel can leave it running -- watching the globe without a panel over
   *  it is the entire point. */
  function tick() {
    if (running && now() >= running.until) stop();
  }

  return { plan, start, stop, tick, isRunning: () => running !== null };
}
