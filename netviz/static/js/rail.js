// The optional right rail: the numbers behind the arcs.
//
// OFF by default. The globe was tuned full-width against a wall, and shrinking
// it to 74% changes the apparent size of every arc, sprite and bloom halo, so
// the rail cannot be something a build turns on for everybody. It is opted into
// per display, by URL:
//
//     http://HOST:8099/?rail=1     rail on
//     http://HOST:8099/            rail off  (or ?rail=0)
//
// URL rather than config.js because one collector serves several kiosks: two
// Chromium autostart lines, one image, no rebuild to change your mind.
//
// Everything above start() is pure -- no DOM, no fetch -- so the formatting and
// the layout decisions are tested under `node --test` rather than judged by
// squinting at a photograph of a wall.

import { cfg } from './config.js';

const POLL_MS = cfg('polling.railSeconds', 10) * 1000;

/** Does this URL ask for the rail?
 *
 *  `?rail`, `?rail=1`, `?rail=true`, `?rail=on` all mean yes; `?rail=0`,
 *  `?rail=false`, `?rail=off` mean no. Anything else -- including no parameter
 *  at all -- falls back to `rail.enabled` in config.js, so an installation that
 *  always wants it can flip the default without editing every kiosk's URL. */
export function railEnabled(search, fallback) {
  const fb = fallback === undefined ? cfg('rail.enabled', false) : fallback;
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return fb;
  }
  if (!params.has('rail')) return fb;
  const v = (params.get('rail') || '').toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return fb;
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


export function panels(snapshot) {
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
  const blockRows = top.map((r) => ({
    label: r.cc,
    value: formatCount(r.n),
    bar: peak > 0 ? (r.n || 0) / peak : 0,
    spark: sparkPoints(r.spark),
  }));
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

  return [
    {
      title: 'GEO BLOCKS',
      note: '24H',
      big: formatCount(blocks.total),
      rows: blockRows,
    },
    {
      title: 'NETFLOW',
      big: formatCount(netflow.flows_per_min),
      bigNote: 'FLOWS/MIN',
      rows: [
        { label: 'INGEST LAG', value: formatLag(netflow.lag_seconds) },
        { label: 'RECORDS', value: formatCount(ipfix.records) },
        { label: 'NO TEMPLATE', value: formatCount(ipfix.no_template) },
        { label: 'GEOIP MISS', value: formatPercent(geoip.miss_rate) },
      ],
    },
    { title: 'FEED HEALTH', rows: health },
  ];
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

function paint(root, data, clock) {
  root.replaceChildren();

  const head = el('header', 'rail-head');
  head.append(el('div', 'rail-title', 'NETVIZ'));
  const times = el('div', 'rail-clock');
  times.append(el('div', 'rail-clock-local', clock.local));
  times.append(el('div', 'rail-clock-utc', `${clock.utc} UTC`));
  head.append(times);
  root.append(head);

  for (const panel of data) {
    const box = el('section', 'rail-panel');
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
      line.append(el('span', 'rail-label', row.label));
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
}

/**
 * Mount the rail and start polling. Call only when railEnabled() is true --
 * with the rail off nothing here runs, no element is created and no request is
 * made, so a wall that does not want it pays nothing for its existence.
 *
 * `onLayout` is called once, synchronously, after the rail element is in the
 * document: the globe's canvas is now narrower and the renderer has to be
 * resized against the new box before the first frame.
 */
export function start({ onLayout } = {}) {
  const root = document.getElementById('rail');
  if (!root) return null;
  document.body.classList.add('rail');
  root.classList.add('on');
  if (onLayout) onLayout();

  let snapshot = null;

  const draw = () => paint(root, panels(snapshot), formatClock(new Date()));

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
  const pollTimer = setInterval(poll, POLL_MS);
  // The clock is the only thing on the rail that has to move every second; the
  // counters move at the collector's pace, not the display's.
  const clockTimer = setInterval(draw, 1000);

  let stopped = false;
  return {
    poll,
    /** Unmount. Safe to call twice -- a double toggle is one click away. */
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
      document.body.classList.remove('rail');
      root.classList.remove('on');
      root.innerHTML = '';
    },
  };
}
