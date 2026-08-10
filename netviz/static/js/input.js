// Direct manipulation: drag to turn, wheel or pinch to move closer, keyboard
// for the things a pointer is clumsy at.
//
// DOM only. Every decision about where a gesture sends the camera lives in
// orbit.js and campath.js, both pure and unit-tested; this file converts
// events into calls and owns no maths worth arguing about.
//
// Pointer Events throughout, so mouse, pen and touch are one code path. The
// alternative -- mousedown plus touchstart -- duplicates every handler and
// invites synthetic-click confusion on the overlap.
import { cfg } from './config.js';
import { pickSphere, solveDrag, zoomBy, decay } from './orbit.js';

export function startInput({ canvas, rig, onToggleRail }) {
  const enabled = cfg('input.enabled', true);
  if (!enabled) return { stop() {} };

  const dragOn = cfg('input.drag', true);
  const zoomOn = cfg('input.zoom', true);
  const keysOn = cfg('input.keyboard', true);
  const invert = cfg('input.invert', false) ? -1 : 1;
  const damping = cfg('input.inertia', 0.85);
  const zoomFactor = cfg('input.zoomFactor', 1.12);
  const hideAfter = cfg('input.hideCursorSeconds', 3);

  const pointers = new Map();          // pointerId -> {x, y}
  let grabPoint = null;                // sphere point under the pointer at grab
  let pinchDist = 0;
  let vLat = 0, vLon = 0;              // degrees per second, for inertia
  let lastMove = 0;
  let cursorTimer = null;

  const ndcFromClient = (x, y) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((x - r.left) / r.width) * 2 - 1,
      y: -(((y - r.top) / r.height) * 2 - 1),
    };
  };
  const ndc = (ev) => ndcFromClient(ev.clientX, ev.clientY);

  function showCursor() {
    canvas.classList.remove('cursor-hidden');
    if (cursorTimer) clearTimeout(cursorTimer);
    if (hideAfter > 0) {
      cursorTimer = setTimeout(() => canvas.classList.add('cursor-hidden'),
                               hideAfter * 1000);
    }
  }

  function onDown(ev) {
    showCursor();
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    canvas.setPointerCapture(ev.pointerId);
    if (pointers.size === 2 && zoomOn) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    if (!dragOn) return;
    const v = rig.view();
    grabPoint = pickSphere(v.lat, v.lon, v.distance, ndc(ev).x, ndc(ev).y,
                           v.fovDeg, v.aspect);
    vLat = 0; vLon = 0;
    lastMove = performance.now();
    rig.grab();
  }

  function onMove(ev) {
    showCursor();
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    // Two fingers is a pinch, and only a pinch: the midpoint drifts while
    // pinching, and turning the globe by that drift reads as a wobble.
    if (pointers.size === 2) {
      if (!zoomOn) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        rig.setDistance(rig.distance() * (pinchDist / d));
      }
      pinchDist = d;
      return;
    }

    if (!dragOn || !grabPoint) return;
    const v = rig.view();
    const before = { lat: v.lat, lon: v.lon };
    const solved = solveDrag(before, grabPoint, ndc(ev), v);
    const lat = before.lat + (solved.lat - before.lat) * invert;
    const dLonRaw = ((solved.lon - before.lon + 540) % 360) - 180;
    const lon = before.lon + dLonRaw * invert;
    rig.look(lat, lon);

    const now = performance.now();
    const dt = Math.max(0.001, (now - lastMove) / 1000);
    lastMove = now;
    vLat = (lat - before.lat) / dt;
    vLon = dLonRaw * invert / dt;
  }

  function onUp(ev) {
    const hadTwo = pointers.size === 2;
    pointers.delete(ev.pointerId);
    if (canvas.hasPointerCapture?.(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    if (pointers.size < 2) pinchDist = 0;
    if (hadTwo && pointers.size === 1) {
      // One finger lifted out of a pinch. grabPoint still holds whatever the
      // *first* finger touched at the original onDown, from before the
      // pinch moved anything -- re-pick under the surviving finger exactly
      // as a fresh onDown would, and drop the fling estimate so it does not
      // inherit the pinch's midpoint drift. Stay manual and grabbed: a
      // pointer is still down.
      if (dragOn) {
        const [, p] = [...pointers.entries()][0];
        const v = rig.view();
        const n = ndcFromClient(p.x, p.y);
        grabPoint = pickSphere(v.lat, v.lon, v.distance, n.x, n.y,
                               v.fovDeg, v.aspect);
      }
      vLat = 0; vLon = 0;
      lastMove = performance.now();
      return;
    }
    if (pointers.size === 0) {
      grabPoint = null;
      rig.release();
    }
  }

  function onWheel(ev) {
    if (!zoomOn) return;
    ev.preventDefault();
    showCursor();
    const [min, max] = rig.zoomRange();
    const notches = ev.deltaY > 0 ? 1 : -1;
    rig.setDistance(zoomBy(rig.distance(), notches, zoomFactor, min, max));
  }

  function onKey(ev) {
    if (!keysOn || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const v = rig.view();
    const [min, max] = rig.zoomRange();
    const stepDeg = 5;
    switch (ev.key) {
      case 'ArrowLeft':  rig.grab(); rig.look(v.lat, v.lon - stepDeg); rig.release(); break;
      case 'ArrowRight': rig.grab(); rig.look(v.lat, v.lon + stepDeg); rig.release(); break;
      case 'ArrowUp':    rig.grab(); rig.look(v.lat + stepDeg, v.lon); rig.release(); break;
      case 'ArrowDown':  rig.grab(); rig.look(v.lat - stepDeg, v.lon); rig.release(); break;
      case '+': case '=': rig.setDistance(zoomBy(rig.distance(), -1, zoomFactor, min, max)); break;
      case '-': case '_': rig.setDistance(zoomBy(rig.distance(), 1, zoomFactor, min, max)); break;
      case 'r': if (onToggleRail) onToggleRail(); break;
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
        break;
      default: return;
    }
    ev.preventDefault();
  }

  /** Called once per animation frame. Coasts the view after a fling. */
  function tick(dt) {
    if (rig.held() || (vLat === 0 && vLon === 0)) return;
    vLat = decay(vLat, damping, dt);
    vLon = decay(vLon, damping, dt);
    if (vLat === 0 && vLon === 0) return;
    const v = rig.view();
    rig.look(v.lat + vLat * dt, v.lon + vLon * dt);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousemove', showCursor);
  showCursor();

  return {
    tick,
    stop() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', showCursor);
      if (cursorTimer) clearTimeout(cursorTimer);
    },
  };
}
