// Degraded mode: say so on the wall when the feed dies.
//
// Without this the globe keeps spinning with no arcs and looks perfectly
// healthy, so a room reading it from across the room cannot tell a quiet night
// from a dead collector. That is the whole point -- a silent failure on a
// monitoring display is worse than no display.
//
// Three signals, in order of severity:
//   poll failed      -> the collector is not answering HTTP at all
//   socket closed    -> HTTP is up but the event stream is gone
//   feed stale       -> everything is up and one input has gone quiet
//
// decide() is pure and lives here so it can be tested under node --test;
// everything that touches the DOM is in start().
import { cfg } from './config.js';

// faster than build.json -- this one is the alarm
const POLL_MS = cfg('polling.healthSeconds', 10) * 1000;

/** Compact enough for a banner read at 3 metres. */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * @param {object|null} health  last /health.json body, or null if the endpoint
 *                              404s (a build without it -- NOT a dead feed)
 * @param {boolean} socketOpen  is the WebSocket currently connected
 * @param {boolean} lastPollOk  did the last poll get any answer at all
 */
export function decide({ health, socketOpen, lastPollOk }) {
  if (!lastPollOk) {
    return { degraded: true, text: '▲ COLLECTOR UNREACHABLE' };
  }
  if (!socketOpen) {
    return { degraded: true, text: '▲ FEED DISCONNECTED' };
  }
  const feeds = health && health.feeds ? health.feeds : {};
  const stale = Object.entries(feeds).filter(([, v]) => !v.ok);
  if (stale.length) {
    const text = stale
      .map(([name, v]) => `${name.toUpperCase()} STALE — ${formatAge(v.age)}`)
      .join('   ');
    return { degraded: true, text: `▲ ${text}` };
  }
  return { degraded: false, text: '' };
}

/** Wire the poller to the banner and the drain. `isOpen` reports socket state. */
export function start({ isOpen }) {
  const banner = document.getElementById('degraded');
  let health = null;

  const applyState = (state) => {
    banner.textContent = state.text;
    banner.classList.toggle('on', state.degraded);
    // The drain is a CSS filter on the canvas rather than per-material colour
    // work: it catches the arcs, the city sprites and the bloom in one move,
    // and costs nothing when the class is off.
    document.body.classList.toggle('degraded', state.degraded);
  };

  const poll = async () => {
    let lastPollOk = true;
    try {
      const r = await fetch('/health.json', { cache: 'no-store' });
      if (r.status === 404) {
        health = null;             // build without the endpoint, not a failure
      } else if (r.ok) {
        health = await r.json();
      } else {
        lastPollOk = false;
      }
    } catch {
      lastPollOk = false;
    }
    applyState(decide({ health, socketOpen: isOpen(), lastPollOk }));
  };

  poll();
  let timer = setInterval(poll, POLL_MS);
  return {
    /** The poll interval is a setting, and this is the alarm -- so it has to be
     *  changeable without a reload, which means tearing the interval down and
     *  starting a new one rather than reading a variable inside a fixed timer. */
    setPeriod(seconds) {
      clearInterval(timer);
      timer = setInterval(poll, seconds * 1000);
    },
    stop() { clearInterval(timer); },
  };
}
