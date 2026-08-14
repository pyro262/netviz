// The optional right rail: the numbers behind the arcs.
//
// OFF by default. The globe was tuned full-width against a wall, and shrinking
// it to 74% changes the apparent size of every arc, sprite and bloom halo, so
// the rail cannot be something a build turns on for everybody. It is opted into
// per display, through the menu -- and remembered, so a kiosk keeps it across
// a reload.
//
// There is deliberately no URL parameter. `?rail=1` and `rail.enabled` were two
// ways to say one thing and they disagreed: with the parameter set and the
// config false, the menu drew the toggle UNCHECKED while the rail was visibly
// on screen, and the first click did nothing.
//
// Everything above start() is pure -- no DOM, no fetch -- so the formatting and
// the layout decisions are tested under `node --test` rather than judged by
// squinting at a photograph of a wall.

import { cfg } from './config.js';
import { ruleKey } from './classcount.js';

// Read at mount, not at import: polling.railSeconds is a live setting, and a
// rail mounted after that setting moved must use the current value.
const pollMs = () => cfg('polling.railSeconds', 10) * 1000;

/**
 * The GEO BLOCKS rows are two-letter codes, and a code is not a country to
 * everyone who walks up to the wall. `Intl.DisplayNames` is what names them.
 *
 * NO TABLE SHIPS, and none can drift. The rail can show ANY country that gets
 * blocked, not only the watched ones, so a hand-kept list of the watched set
 * would be wrong for exactly the case a name is most wanted -- a code nobody
 * in the room recognizes.
 *
 * THE GUARD IS LOAD-BEARING; it is not defensive clutter. `.of()` THROWS a
 * RangeError on anything that is not a well-formed region code, and `--` is a
 * code this pipeline genuinely produces: it is what `foreign_country()` yields
 * when neither end places, and it is documented as "not a country". Unguarded,
 * that throw does not spoil a tooltip -- it lands inside `paint()` and takes
 * the WHOLE RAIL down, replacing every live number with nothing.
 *
 * Measured on this Node: `.of('--')`, `.of('')` and `.of('ABC')` all throw;
 * `.of('ZZ')` returns "Unknown Region" without throwing. So the shape is:
 * only attempt a plausible two-letter code, wrap it anyway, and return null
 * rather than a guess. "Unknown Region" is treated as no name at all -- it is
 * noise over a code that already says the same thing, and the caller shows no
 * tooltip rather than an empty or useless one.
 *
 * The formatter is built once, and its own construction is wrapped too: an
 * engine without `Intl.DisplayNames` must cost the rail its names, not its
 * numbers.
 */
const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** The country's name for a two-letter code, or null when it cannot be named.
 *  Never throws.
 *
 *  `names` is injectable for one reason: the contract is double-held -- the
 *  shape test refuses `--` and the `try` would catch the throw anyway -- so
 *  deleting the shape test changes NOTHING observable about the return value,
 *  which is this project's own definition of a guard nobody can trust. What
 *  the shape test actually promises is that `.of()` is **never called** with a
 *  code that cannot be one, and the only way to assert that is to hand in a
 *  formatter that counts its calls. Same seam, and the same reason, as
 *  `randomizeValue(row, rand)`. */
export function countryName(cc, names = REGION_NAMES) {
  if (!names) return null;
  if (typeof cc !== 'string' || !/^[A-Za-z]{2}$/.test(cc)) return null;
  const code = cc.toUpperCase();
  let name;
  try {
    name = names.of(code);
  } catch {
    return null;
  }
  // `of()` hands back the code itself for some unassigned regions and the
  // literal "Unknown Region" for others. Neither is a name; both would put a
  // tooltip on a row that says nothing the label did not.
  if (!name || name === code || /unknown region/i.test(name)) return null;
  return name;
}

/** Thousands separators up to 9999, then k/M. A wall display is read at three
 *  metres: "1.6M" lands, "1614382" does not. */
export function formatCount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Math.round(n);
  if (v < 10000) return String(v);
  if (v < 1000000) return `${(v / 1000).toFixed(v < 100000 ? 1 : 0)}k`;
  return `${(v / 1000000).toFixed(v < 10000000 ? 1 : 0)}M`;
}

/** Ingest lag. Sub-second matters here -- it is the difference between "live"
 *  and "the router is batching" -- so this is not degraded.js's formatAge. */
export function formatLag(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function formatPercent(fraction) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Age of a feed's last-good timestamp, for the health panel. */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Two lines: local time, then UTC. Both, because the wall is read by someone
 *  in the room and the logs it is about are stamped in UTC. */
export function formatClock(date) {
  const two = (n) => String(n).padStart(2, '0');
  const local = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  const utc = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return { local, utc };
}

/**
 * Turn a /stats.json body into the panels the rail paints.
 *
 * `snapshot` is null when the poll failed or the endpoint 404s (a collector
 * built without it). Every row still renders, with an em dash -- a rail that
 * empties out on a failed poll looks like a quiet network, which is the exact
 * confusion degraded mode exists to prevent.
 */
/**
 * Normalise a sparkline series to points in [0,1], oldest first.
 *
 * Returns null for anything that cannot be drawn honestly: a missing series
 * (an older collector that serves no `spark`), a too-short one, or an hour
 * with no blocks at all. Null renders as nothing, where a flat line at zero
 * would be a claim -- and a flat line is also what a *broken* series looks
 * like, which is the one reading the rail must never invent.
 *
 * Scaled to the row's own peak. Every row shares the same time axis, so the
 * lines compare shapes, not magnitudes; the count beside them carries the
 * magnitude already.
 */
export function sparkPoints(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const values = series.map((n) => (Number.isFinite(n) && n > 0 ? n : 0));
  const peak = values.reduce((m, n) => Math.max(m, n), 0);
  if (peak <= 0) return null;
  return values.map((n) => n / peak);
}


/**
 * The collector's build, for the bottom of the rail.
 *
 * Empty whenever the answer is not known: an older collector serves no version
 * at all, and the renderer's own idea of it would be a claim about the far end
 * of a connection this page cannot see. Same rule as the update watermark --
 * false in every uncertain case, because an indicator that guesses is one
 * everybody learns to ignore.
 */
export function versionLabel(snapshot) {
  const v = snapshot && snapshot.version;
  if (typeof v !== 'string' || v === '') return '';
  return v.startsWith('v') ? v : `v${v}`;
}

/**
 * The COLOR RULES panel, or null when there is nothing to say.
 *
 * Ranked by the last hour rather than by list order, so the busiest rules hold
 * the visible slots and a rule that never fires cannot sit in front of one
 * that does. The overflow is NAMED (+N more) rather than dropped: a truncated
 * list that does not say it truncated is a lie about the traffic.
 *
 * Each row scales its own sparkline to its own peak -- sparkPoints already
 * does that -- because the number beside it carries the magnitude and scaling
 * every row to the busiest flattens the rest.
 */
export function rulePanel(rules, counter, nowMs, maxRules) {
  const live = (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled !== false);
  if (!live.length) return null;
  const cap = Math.max(1, maxRules || 5);
  const scored = live.map((r) => {
    // ruleKey, imported from classcount.js -- NOT rebuilt inline. Two copies
    // of an identity function drift, and the drift here is invisible: the rail
    // would simply show 0.0/min for a rule that is firing.
    const key = ruleKey(r);
    const spark = counter.spark(key, nowMs);
    return {
      label: r.name || r.match || '?',
      swatch: r.color,
      value: `${counter.ratePerMin(key, nowMs).toFixed(1)}/min`,
      spark: spark ? sparkPoints(spark) : null,
      hour: spark ? spark.reduce((a, b) => a + b, 0) : 0,
    };
  });
  // DESCENDING BY HOUR, and `fitRuleCap` silently depends on the direction.
  // A rule that has fired carries a sparkline and is nearly twice the height of
  // one that has not, so ranking the busy rules FIRST means lowering the cap
  // only ever drops SHORT rows -- which is what keeps `ruleBoxMetrics`'s `max`
  // invariant across a re-measure and the fit non-oscillating. Reverse this
  // sort and the fitter alternates between two caps on every poll: dropping a
  // tall row lowers the max, which frees room, which puts it back.
  // `rail.test.mjs` asserts the property this relies on -- the rows kept at a
  // lower cap are a prefix of the rows kept at a higher one -- rather than the
  // sort call itself, so a re-ranking that preserves it stays legal.
  scored.sort((a, b) => b.hour - a.hour);
  const rows = scored.slice(0, cap).map(({ hour, ...row }) => row);
  if (scored.length > cap) {
    rows.push({ label: `+${scored.length - cap} more`, value: '', muted: true });
  }
  // `id` reaches the DOM as a second class on the section, which is how the
  // fitter finds this panel to measure it. A class rather than a `dataset`
  // write: the unit suite's DOM fake and a real HTMLElement disagree about
  // `dataset`, and menu.js has already been bitten by exactly that.
  return { id: 'rules', title: 'COLOR RULES', note: 'SINCE LOAD', rows };
}

/**
 * The rule panel's chrome and its WORST row height, from the rows as rendered.
 *
 * RULE ROWS ARE NOT ALL THE SAME HEIGHT, and assuming they were made the first
 * cut of the fitter wrong in the ordinary case rather than in a corner. A rule
 * that has fired in the last hour carries a sparkline; `rulePanel` gives it a
 * `spark` and no `bar`, so `paint` does not add the `bars` class and the svg
 * lands as a third child of a two-column grid -- an implicit second grid row.
 * Measured live at 2560x1440: **a fired row is 77px against an idle row's
 * 41.4px**, and the "+N more" row is shorter again.
 *
 * Taking `rows[0]` as the height and `boxHeight - n * rows[0]` as the chrome
 * therefore did two wrong things at once, and they compounded rather than
 * cancelling: rows are ranked by traffic, so `rows[0]` is the TALLEST row, and
 * multiplying it by every row made the chrome NEGATIVE (585 - 12 x 77 = -339),
 * which the fitter then subtracted -- handing itself 339px of room that does
 * not exist. Measured with one firing rule among 20: the rail still overflowed
 * by **271px** with the fitter running. And because every draw re-derives the
 * same answer from the same measurements, the residue never converges away; it
 * lands permanently on the scrollbar, which is what this whole change exists to
 * avoid.
 *
 * So: sum the REAL rects for the chrome, and take the MAX for the row height.
 * Max rather than mean, because the fitter's error has a right direction --
 * assuming every row is as tall as the tallest leaves the rail short of a row
 * sometimes, where assuming the average puts it over the bottom of the screen.
 *
 * TWO INVARIANTS THIS DEPENDS ON, neither of them local to this function, and
 * both breakable by an edit that looks unrelated:
 *
 *   1. `rulePanel` ranks rows by traffic DESCENDING, so lowering the cap drops
 *      only short rows and `max` does not move across the re-measure. Reverse
 *      that sort and the fit oscillates -- see the note on the sort itself.
 *   2. `.rail-panel` stacks its rows with NO `gap`; each row's padding is
 *      inside its own rect. That is the only reason `boxHeight - sum(rows)` is
 *      independent of the row count. Add a `gap` and the chrome shrinks as rows
 *      are dropped, which is the feedback loop the direct arithmetic exists to
 *      avoid. `tests/test_static_css.py` asserts the rule declares no gap.
 *
 * Returns null when there is nothing measurable, and the caller then leaves the
 * cap alone.
 */
export function ruleBoxMetrics(boxHeight, rowHeights) {
  const rows = (Array.isArray(rowHeights) ? rowHeights : []).filter((h) => h > 0);
  if (!rows.length || !(boxHeight > 0)) return null;
  const used = rows.reduce((a, b) => a + b, 0);
  return {
    rowHeight: Math.max(...rows),
    // Floored at 0: a sub-pixel rounding of the rects against the box must not
    // hand the fitter negative chrome, which is the failure above in miniature.
    chrome: Math.max(0, boxHeight - used),
  };
}

/**
 * The rail's CONTENT height: its children, its gaps and its own padding.
 *
 * WHY NOT `scrollHeight`, WHICH THIS REPLACED. #rail is a flex column and
 * `.rail-foot` carries `margin-top: auto`, so every spare pixel is absorbed as
 * flex slack and there is nothing to scroll until the content genuinely
 * overflows. Until then `scrollHeight === clientHeight` exactly, which made
 * `available - other` collapse to `boxHeight`: the fitter handed the rule panel
 * precisely the room it already occupied, so free space could never reach it
 * and the only question left was whether the panel's own rows divided evenly.
 * They do not -- a fired row is 77px against an idle row's 41.4px and
 * `ruleBoxMetrics` takes the max -- so the fit lost a row on every draw at every
 * viewport. Measured live at 2560x1440: three rules with `maxRules: 2` drew one
 * row and a "+2 more" with ~315px of rail standing empty. It is the same class
 * of error as the negative chrome above, in the opposite direction: there the
 * fitter invented room, here it hid room that was really there.
 *
 * The flex slack is deliberately excluded rather than counted: that slack IS
 * the space being competed for, so folding it into `other` would be the bug
 * again by another route.
 *
 * Pure for the same reason `fitRuleCap` is -- the caller reads the rects and
 * the computed style, this does the arithmetic, and the decision is proved
 * under `node --test`.
 *
 * @param childHeights each direct child's rendered height, in px.
 * @param gap          the column's `row-gap`; applied between children only.
 * @param padding      the rail's own top plus bottom padding, which
 *                     `clientHeight` includes and so must be counted here too.
 */
export function railContentHeight({ childHeights, gap, padding }) {
  const kids = (Array.isArray(childHeights) ? childHeights : []).filter((h) => h > 0);
  if (!kids.length) return 0;
  const g = gap > 0 ? gap : 0;
  const pad = padding > 0 ? padding : 0;
  return kids.reduce((a, b) => a + b, 0) + g * (kids.length - 1) + pad;
}

/**
 * How many rule rows actually FIT, given what the rail measured about itself.
 *
 * THE PROBLEM, MEASURED BEFORE IT WAS BUILT. `rail.maxRules` is bounded 1..20
 * and ships at 5, and the rail had no overflow handling at all -- `#rail` is
 * `position: fixed; inset 0` with no `overflow`, so anything past the bottom of
 * the viewport simply spilled off the screen. Sweeping the rule count with
 * `maxRules` at its 20 ceiling: content first exceeds the viewport at **9 rules
 * at 2560x1440 and 8 at 1920x1080**, and at 20 rules it overflows by 502px and
 * 378px respectively. That is a third of the rail's height gone, and the FOOT
 * goes with it -- `.rail-foot` is `margin-top: auto`, so the build label is the
 * first thing off the bottom. Well under the ceiling, so this is a real
 * overflow rather than a hypothetical one.
 *
 * WHY NOT JUST A SCROLLBAR. Nobody is standing at a wall display to scroll it,
 * so content below the fold is invisible for ever -- the same "a control past
 * the fold is a control that does not exist" the tuning panel's buttons were
 * moved for. The rail therefore has to FIT, and scrolling is the safety net for
 * what fitting cannot reach (a short viewport, a browser zoomed in).
 *
 * WHY NOT SHRINK THE TEXT. The rail is sized in `vw` to be read from across a
 * room; scaling it to fit 20 rules would silently trade the one thing it exists
 * for. Dropping rows is the better trade because `rulePanel` already NAMES what
 * it dropped ("+N more") -- the reader loses the detail and keeps the fact,
 * where shrinking loses nothing visibly and everything practically.
 *
 * THE ARITHMETIC IS DIRECT, NOT A FEEDBACK LOOP, and that is deliberate. Both
 * inputs it divides -- the chrome around the rows and the height of one row --
 * are independent of how many rows are currently drawn, so this converges in a
 * single repaint and then holds. A "shrink until it fits, grow while there is
 * slack" loop over the same measurements oscillates, because removing a row
 * creates exactly the slack that argues for putting it back.
 *
 * Pure, so the decision is proved under `node --test` rather than by opening a
 * browser at four viewport sizes; the caller measures and hands the numbers in,
 * the same seam `campath.js` and `orbit.js` use.
 *
 * @param available  the rail's own client height, in px.
 * @param other      every other panel, the head, the foot and the flex gaps.
 * @param chrome     the rule panel minus its rows: title, padding, border.
 * @param rowHeight  one rendered `.rail-row`.
 * @param total      enabled rules -- what `rulePanel` would rank.
 * @param maxRules   `rail.maxRules`, never exceeded. A fit is a REDUCTION of
 *                   the operator's setting, never a licence to go past it.
 */
export function fitRuleCap({ available, other, chrome, rowHeight, total, maxRules }) {
  const cap = Math.max(1, Math.floor(maxRules) || 5);
  // Nothing measurable yet -- first paint, rail unmounted, a row of zero
  // height. Trust the setting rather than inventing a number from a
  // measurement that is not there: the un-fitted rail is what shipped, so
  // falling back to it is the honest failure mode.
  if (!(available > 0) || !(rowHeight > 0)) return cap;
  const fits = Math.floor((available - other - chrome) / rowHeight);
  // Everything fits: no reduction to make.
  if (fits >= total) return Math.min(cap, Math.max(1, total));
  // It does not, so one row goes to "+N more" and the rest carry rules. Floored
  // at 1 rather than 0: a COLOR RULES panel with no rows would drop the "+N
  // more" line too and the display would stop saying the rules exist at all,
  // which is the silent truncation the named overflow exists to prevent. Below
  // that floor the scrollbar is what catches it.
  return Math.max(1, Math.min(cap, fits - 1));
}

export function panels(snapshot, extra, colors) {
  const s = snapshot || {};
  const blocks = s.blocks || {};
  const netflow = s.netflow || {};
  const ipfix = netflow.ipfix || {};
  const geoip = s.geoip || {};
  const feeds = s.feeds || null;

  const top = Array.isArray(blocks.top) ? blocks.top : [];
  // Bars are scaled to the leader, not to the total: with one country at 80%
  // of all blocks every other bar would be a stub, and the ranking below the
  // top row is the part worth reading.
  const peak = top.reduce((m, r) => Math.max(m, r.n || 0), 0);

  // The sparkline is the last hour; the bar and the count are the last 24.
  // They are scaled independently on purpose -- a country's shape over the
  // hour is worth reading whether or not it leads the day, and scaling the
  // lines to the day's leader would flatten every other row to nothing.
  const blockRows = top.map((r) => {
    const row = {
      label: r.cc,
      value: formatCount(r.n),
      bar: peak > 0 ? (r.n || 0) / peak : 0,
      spark: sparkPoints(r.spark),
    };
    // `title` is the row's hover text, and it is ABSENT rather than null when
    // the code cannot be named -- the painter tests for the key, so an
    // unnameable code (`--`, which this pipeline really produces) gets no
    // tooltip at all rather than an empty one that reads as a broken hint.
    const name = countryName(r.cc);
    if (name) row.title = name;
    return row;
  });
  if (!blockRows.length) {
    blockRows.push({ label: 'NONE', value: '—', bar: 0, muted: true });
  }

  const health = [];
  if (feeds) {
    for (const [name, v] of Object.entries(feeds)) {
      health.push({
        label: name.toUpperCase(),
        value: v && v.ok ? formatAge(v.age) : `STALE ${formatAge(v && v.age)}`,
        ok: !!(v && v.ok),
      });
    }
  } else {
    health.push({ label: 'FEEDS', value: '—', muted: true });
  }

  // The legend for the two built-in arc classes. A COLOR RULE already carries
  // its own swatch in rulePanel(), so amber and violet were the only colors on
  // the wall with nothing anywhere saying what they meant -- and they are the
  // two that matter most, being the alarm layer and everything else.
  //
  // The colors are HANDED IN, never known here: they are tuned constants that
  // have moved several times, they can be changed live through settings, and
  // arcs.js cannot be imported into this file at all (it imports three, and
  // everything above start() is unit-tested without one). A literal here would
  // keep claiming amber after a recolor, and a key that disagrees with the
  // display is worse than no key.
  //
  // Each sits ABOVE the rows it explains: the reader meets the color before
  // the numbers drawn in it.
  const legendRow = (color, text) =>
    (color ? [{ label: text, value: '', swatch: color, muted: true }] : []);

  const out = [
    {
      title: 'GEO BLOCKS',
      note: '24H',
      big: formatCount(blocks.total),
      rows: [
        ...legendRow(colors && colors.block, 'amber arcs — geo-blocked'),
        ...blockRows,
      ],
    },
    {
      title: 'NETFLOW',
      big: formatCount(netflow.flows_per_min),
      bigNote: 'FLOWS/MIN',
      rows: [
        ...legendRow(colors && colors.flow, 'violet arcs — all other traffic'),
        { label: 'INGEST LAG', value: formatLag(netflow.lag_seconds) },
        { label: 'RECORDS', value: formatCount(ipfix.records) },
        { label: 'NO TEMPLATE', value: formatCount(ipfix.no_template) },
        { label: 'GEOIP MISS', value: formatPercent(geoip.miss_rate) },
      ],
    },
    { title: 'FEED HEALTH', rows: health },
  ];
  if (extra) out.push(extra);
  return out;
}

// ---------------------------------------------------------------- the DOM --

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Viewbox units for the sparkline. Arbitrary but fixed: the SVG scales to
// whatever CSS gives it, and picking round numbers keeps the path readable in
// a DOM inspector.
const SPARK_W = 100;
const SPARK_H = 20;

/**
 * One row's last hour as an inline SVG polyline.
 *
 * Inline SVG rather than a canvas or a row of divs: there are at most five of
 * these, they redraw once every 10 seconds, and an SVG path costs nothing to
 * rebuild while a canvas would need its own resize handling on a display whose
 * rail is a percentage of the viewport.
 *
 * `createElementNS` is required -- `createElement('svg')` yields an HTML
 * element with the right tag name that never renders.
 */
function sparkSvg(points) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'rail-spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const step = points.length > 1 ? SPARK_W / (points.length - 1) : SPARK_W;
  // 1px of padding top and bottom so a peak at 1.0 is not clipped by the
  // viewBox edge and a zero is not lost against the row's baseline.
  const path = points
    .map((v, i) => `${(i * step).toFixed(1)},${(SPARK_H - 1 - v * (SPARK_H - 2)).toFixed(1)}`)
    .join(' ');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', path);
  svg.append(line);
  return svg;
}

function paint(root, data, clock, version) {
  root.replaceChildren();

  const head = el('header', 'rail-head');
  head.append(el('div', 'rail-title', 'NETVIZ'));
  const times = el('div', 'rail-clock');
  times.append(el('div', 'rail-clock-local', clock.local));
  times.append(el('div', 'rail-clock-utc', `${clock.utc} UTC`));
  head.append(times);
  root.append(head);

  for (const panel of data) {
    const box = el('section', `rail-panel${panel.id ? ` rail-panel-${panel.id}` : ''}`);
    const h = el('h2', 'rail-panel-title', panel.title);
    if (panel.note) h.append(el('span', 'rail-panel-note', panel.note));
    box.append(h);

    if (panel.big !== undefined) {
      const big = el('div', 'rail-big');
      big.append(el('span', 'rail-big-value', panel.big));
      if (panel.bigNote) big.append(el('span', 'rail-big-note', panel.bigNote));
      box.append(big);
    }

    for (const row of panel.rows) {
      const line = el('div', `rail-row${row.bar !== undefined ? ' bars' : ''}`
                             + (row.muted ? ' muted' : ''));
      // The country name behind a two-letter code, on the whole row rather
      // than on the label span: the bar and the count belong to that country
      // too, and a tooltip that only appears over two characters of text is
      // one nobody finds.
      if (row.title) line.title = row.title;
      // The swatch goes INSIDE the label, not beside it. `.rail-row` is a
      // two-column grid, so prepending the dot as a third child put it in
      // column one, pushed the label into column two, and wrapped the value
      // onto a second line -- which is what every COLOR RULES row had been
      // doing since swatches were added, and what the legend rows did the
      // moment they arrived. Nesting keeps the grid at two columns, so the
      // dot travels with the text it names and the value stays on the right
      // where every other row has it.
      const label = el('span', 'rail-label');
      if (row.swatch) {
        const dot = el('span', 'rail-swatch');
        dot.style.background = row.swatch;
        label.append(dot);
      }
      // A span rather than a text node: `el()` is the one way this file makes
      // DOM, and the fake the unit tests run against implements createElement
      // and not createTextNode.
      label.append(el('span', 'rail-label-text', row.label));
      line.append(label);
      const value = el('span', 'rail-value', row.value);
      if (row.ok === false) value.classList.add('bad');
      line.append(value);
      if (row.bar !== undefined) {
        const track = el('span', 'rail-bar');
        const fill = el('span', 'rail-bar-fill');
        fill.style.width = `${Math.round(row.bar * 100)}%`;
        track.append(fill);
        line.append(track);
      }
      if (row.spark) line.append(sparkSvg(row.spark));
      box.append(line);
    }
    root.append(box);
  }

  // Bottom right, dim: which build this wall is running. `margin-top: auto`
  // in the CSS floats it to the bottom of the flex column, so it stays there
  // whether the rail is showing five block rows or none. Omitted entirely
  // rather than drawn empty when the version is unknown -- see versionLabel.
  if (version) root.append(el('div', 'rail-foot', version));
}

/**
 * Mount the rail and start polling. Call only when the rail is wanted --
 * with the rail off nothing here runs, no element is created and no request is
 * made, so a wall that does not want it pays nothing for its existence.
 *
 * THE CALLER RESIZES, and this function deliberately does not. It used to take
 * an `onLayout` callback and fire it here, which meant mounting cost two
 * resizes -- rail.js's and then the caller's -- against unmounting's one, while
 * the settings executor's whole point is that however many keys ask for a
 * relayout it happens once. What is guaranteed instead is the ORDERING: when
 * this returns, `body.rail` is set and the rail is painted, so a caller that
 * measures #stage next sees the narrowed box rather than the full viewport.
 */
/**
 * @param counter the renderer's own class counter, for the COLOR RULES panel.
 * @param classColors optional `() => ({block, flow})` of CSS colors, called on
 *   every paint. A function rather than a value because the arc colors are
 *   live settings: `arcs.flow.colorAt` recolors the arcs already on screen, and
 *   a legend captured once at mount would go on claiming the old color. The
 *   rail cannot read them itself -- arcs.js imports three, and everything above
 *   start() is unit-tested without it.
 */
export function start(counter, classColors) {
  const root = document.getElementById('rail');
  if (!root) return null;
  document.body.classList.add('rail');
  root.classList.add('on');

  let snapshot = null;

  // Sticky across a failed poll. The version only changes when the collector
  // is redeployed, and a redeploy reloads the page anyway, so blanking it
  // because one request timed out would be throwing away a fact we hold.
  let version = '';

  /** What `fitRuleCap` needs, read off the rail as it currently stands.
   *
   *  Returns null when there is nothing to measure -- no rule panel drawn, or
   *  no rows in it -- and the caller then leaves the cap alone. Measuring is
   *  the only DOM-side half of this; every decision made from these numbers is
   *  in `fitRuleCap`, which is why it is a separate function.
   *
   *  `other` is the whole rail minus the rule panel, so it carries the head,
   *  the other panels, the foot and the flex gaps without this function
   *  knowing what any of them are -- a list of what to add up would go stale
   *  the first time a panel is added.
   *
   *  It comes from `railContentHeight`, NOT from `scrollHeight`, and that is
   *  the whole correctness of the fit -- see the note on that function. */
  const measure = () => {
    const box = root.querySelector('.rail-panel-rules');
    if (!box) return null;
    const rows = box.querySelectorAll('.rail-row');
    if (!rows.length) return null;
    const boxH = box.getBoundingClientRect().height;
    // Every row's real rect. Rule rows differ in height by nearly 2x depending
    // on whether the rule has fired -- see ruleBoxMetrics, which is where the
    // arithmetic lives so it can be proved without a browser.
    const metrics = ruleBoxMetrics(
      boxH, [...rows].map((r) => r.getBoundingClientRect().height));
    if (!metrics) return null;
    const style = getComputedStyle(root);
    const content = railContentHeight({
      childHeights: [...root.children].map((el) => el.getBoundingClientRect().height),
      gap: parseFloat(style.rowGap),
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
    });
    return {
      available: root.clientHeight,
      other: content - boxH,
      ...metrics,
    };
  };

  const draw = (capOverride) => {
    version = versionLabel(snapshot) || version;
    const rules = cfg('arcs.rules', []);
    const cap = capOverride === undefined ? cfg('rail.maxRules', 5) : capOverride;
    // The rule rows come from the renderer's own counter, not from
    // /stats.json: the collector has never seen the rule list.
    const extra = counter
      ? rulePanel(rules, counter, Date.now(), cap)
      : null;
    // Read per paint, never cached: an arc recolor through settings has to
    // move the key with it.
    let colors = null;
    try {
      colors = classColors ? classColors() : null;
    } catch (err) {
      // A legend is the least important thing on the rail. It must never cost
      // the numbers their paint.
      colors = null;
    }
    paint(root, panels(snapshot, extra, colors), formatClock(new Date()), version);

    // Then fit, at most once per draw. `capOverride !== undefined` is what
    // stops a second pass: the numbers `fitRuleCap` divides do not depend on
    // how many rows are drawn, so one repaint reaches the answer and a third
    // would only be the same arithmetic again. Every draw starts from
    // `rail.maxRules` afresh rather than from the last fitted cap, so deleting
    // a rule or growing the window gives the rows straight back -- a cap that
    // ratcheted down would need somebody to reload the wall to undo it.
    if (capOverride !== undefined || !extra) return;
    const m = measure();
    if (!m) return;
    const total = (Array.isArray(rules) ? rules : [])
      .filter((r) => r && r.enabled !== false).length;
    const fitted = fitRuleCap({ ...m, total, maxRules: cap });
    // Compared against what was RENDERED, not against the cap that was asked
    // for. `rulePanel` draws `min(cap, total)` rule rows, so in the default
    // case -- maxRules 5 against the one to three rules most sites run -- a
    // fitting cap of `total` differs from `cap` while describing the exact
    // same panel, and comparing to `cap` repainted identical DOM on every
    // poll for the life of the page.
    if (fitted !== Math.min(cap, Math.max(1, total))) draw(fitted);
  };

  const poll = async () => {
    try {
      const r = await fetch('/stats.json', { cache: 'no-store' });
      // 404 and a network error are the same thing to the rail: no numbers.
      // Unlike degraded.js it does not have to tell them apart, because the
      // banner is already saying which one it is.
      snapshot = r.ok ? await r.json() : null;
    } catch {
      snapshot = null;
    }
    draw();
  };

  draw();
  poll();
  // Held so the rail can be taken back down: rail.enabled is a live setting,
  // and a rail whose timers outlive its element goes on fetching /stats.json
  // for a panel nobody can see -- once per toggle, for the life of the page.
  let pollTimer = setInterval(poll, pollMs());
  // The clock is the only thing on the rail that has to move every second; the
  // counters move at the collector's pace, not the display's.
  const clockTimer = setInterval(draw, 1000);

  let stopped = false;
  return {
    poll,
    /** polling.railSeconds is a live setting; the interval is replaced rather
     *  than read from inside a fixed timer. */
    setPeriod(seconds) {
      if (stopped) return;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, seconds * 1000);
    },
    /** Unmount. Safe to call twice -- a double toggle is one click away. */
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
      document.body.classList.remove('rail');
      root.classList.remove('on');
      // replaceChildren, matching paint() -- innerHTML never held anything,
      // because paint() has always built nodes rather than markup.
      root.replaceChildren();
    },
  };
}
