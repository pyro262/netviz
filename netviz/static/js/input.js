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

export function startInput({ canvas, rig }) {
  const enabled = cfg('input.enabled', true);
  // The disabled stub must carry the WHOLE interface, tick included. main.js
  // calls input.tick(dt) every frame, and three.js re-schedules its animation
  // frame only AFTER the callback returns -- so a missing method throws, the
  // loop stops after one frame, and the wall is a black canvas until the next
  // deploy. A config knob must never be able to do that.
  if (!enabled) return { tick() {}, stop() {} };

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
        rig.poke();          // zoom is inside the state machine too
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

  /**
   * Release because the pointer went away, not because it was lifted.
   *
   * A pointerup is not guaranteed. A mouse unplugged mid-press, a compositor
   * grabbing the pointer, a window losing focus mid-drag -- each leaves `held`
   * set forever, and campath's step() then refuses to move the camera at all.
   * The wall freezes on a healthy feed with no degraded banner. campath has a
   * maxHeldSeconds backstop for the paths nobody thought of; these two events
   * are the ones we know about, and they release in milliseconds instead of
   * five minutes.
   */
  function releaseLost() {
    if (pointers.size === 0) return;
    for (const id of pointers.keys()) {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    }
    pointers.clear();
    pinchDist = 0;
    grabPoint = null;
    // No fling: the gesture did not end in a throw, it ended in a loss.
    vLat = 0; vLon = 0;
    rig.release();
  }

  function onBlur() { releaseLost(); }

  function onLostCapture(ev) {
    // Fires on an ordinary pointerup too, after onUp has already cleaned up.
    // Only a pointer still in the map is one we did not hear about lifting --
    // which also keeps a pinch's 2->1 transition off this path.
    if (!pointers.has(ev.pointerId)) return;
    releaseLost();
  }

  function onWheel(ev) {
    if (!zoomOn) return;
    ev.preventDefault();
    showCursor();
    // poke(), not grab()/release(): a wheel notch is not a pointer going down,
    // and faking one would clear `held` on the way out of a live drag. Without
    // this the zoom sits outside the state machine entirely and forty seconds
    // spent wheeling in on an arc reads as an empty room -- the camera decides
    // nobody is there and flies home mid-inspection.
    rig.poke();
    const [min, max] = rig.zoomRange();
    const notches = ev.deltaY > 0 ? 1 : -1;
    rig.setDistance(zoomBy(rig.distance(), notches, zoomFactor, min, max));
  }

  function onKey(ev) {
    if (!keysOn || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const v = rig.view();
    const [min, max] = rig.zoomRange();
    const stepDeg = 5;
    // Every one of these is poke(), never grab()/release(). A keypress is an
    // instant, not a hold: grabbing and releasing on the same key would clear
    // `held` out from under a pointer that is genuinely down.
    switch (ev.key) {
      case 'ArrowLeft':  rig.poke(); rig.look(v.lat, v.lon - stepDeg); break;
      case 'ArrowRight': rig.poke(); rig.look(v.lat, v.lon + stepDeg); break;
      case 'ArrowUp':    rig.poke(); rig.look(v.lat + stepDeg, v.lon); break;
      case 'ArrowDown':  rig.poke(); rig.look(v.lat - stepDeg, v.lon); break;
      case '+': case '=':
        rig.poke();
        rig.setDistance(zoomBy(rig.distance(), -1, zoomFactor, min, max));
        break;
      case '-': case '_':
        rig.poke();
        rig.setDistance(zoomBy(rig.distance(), 1, zoomFactor, min, max));
        break;
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
    // The hand-back ends input's ownership of the view, full stop. Damping
    // 0.85/s has a ~6.2s time constant against a 1e-6 floor, so a fling coasts
    // for ~114 seconds -- nearly four times resumeSeconds. Without this guard
    // both campath.step() and this function write curLat/curLon at once, and
    // 5.6 degrees of longitude nobody asked for arrive AFTER the display has
    // taken itself back. Two owners of one piece of state is the whole bug.
    if (!rig.manual()) { vLat = 0; vLon = 0; return; }
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
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
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
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', showCursor);
      if (cursorTimer) clearTimeout(cursorTimer);
    },
  };
}
