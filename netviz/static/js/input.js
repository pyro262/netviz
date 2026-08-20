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
import { zoomBy, decay } from './orbit.js';
import { pickCameraSphere, dragRotation, axisAngle } from './arcball.js';
import { isDoubleTap, DOUBLE_TAP } from './menu.js';

export function startInput({ canvas, rig, menu, customArcsPanel, settingsPanel }) {
  // `enabled` is a live GATE, not an early return.
  //
  // It used to return a do-nothing stub, and that stub had to carry the whole
  // interface -- tick() included -- because main.js calls input.tick(dt) every
  // frame and three re-schedules its animation frame only AFTER the callback
  // returns, so a missing method stops the loop after one frame and the wall
  // goes black until the next deploy. A stub also cannot be turned back on:
  // `input.enabled` is a setting now, and a control that needs a reload to take
  // effect is the silently-does-nothing control the schema exists to prevent.
  // So the listeners are always attached and every handler checks the gate.
  let enabled = cfg('input.enabled', true);

  let dragOn = cfg('input.drag', true);
  let zoomOn = cfg('input.zoom', true);
  let keysOn = cfg('input.keyboard', true);
  let invert = cfg('input.invert', false) ? -1 : 1;
  let damping = cfg('input.inertia', 0.85);
  let zoomFactor = cfg('input.zoomFactor', 1.12);
  let hideAfter = cfg('input.hideCursorSeconds', 3);
  // How long the camera stays borrowed after the menu closes, as opposed to
  // after a drag. Read here rather than inside campath's step because it is
  // the MENU that knows which kind of claim this is, not the state machine.
  let menuResume = cfg('input.menuResumeSeconds', 2);

  const pointers = new Map();          // pointerId -> {x, y}
  // Down position and time per live pointer, keyed separately from `pointers`
  // because that map is overwritten on every move -- the double-tap and drag
  // checks both need where and when the finger FIRST touched, not where it
  // ended up.
  const downPos = new Map();
  // True once this gesture has ever carried two live pointers. A pinch that
  // ends with the last finger lifting must never read as a tap: without this
  // flag the final lift of a two-finger gesture looks identical, at that one
  // event, to a clean one-finger tap.
  let gesturePinched = false;
  // The previous qualifying tap, for isDoubleTap. Cleared after a double-tap
  // fires so a third tap does not immediately re-toggle the menu, and after
  // any tap that turns out to have been a drag.
  let lastTap = null;
  // Camera-space unit vector of the sphere point under the pointer at grab.
  // Camera space, not world: the rotation that carries it under the pointer is
  // then the same maths at the equator, at a pole, and upside down past one.
  let grabPoint = null;
  let pinchDist = 0;
  // The fling, as a camera-space axis and a rate in degrees per second. One
  // axis and one number replace the old vLat/vLon pair, which could not express
  // a spin about the view direction at all -- and that is most of what a drag
  // near the limb, or any drag after a pole crossing, actually is.
  let spinAxis = { x: 0, y: 1, z: 0 };
  let spinRate = 0;
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
    if (!enabled) return;
    canvas.classList.remove('cursor-hidden');
    if (cursorTimer) clearTimeout(cursorTimer);
    if (hideAfter > 0) {
      cursorTimer = setTimeout(() => canvas.classList.add('cursor-hidden'),
                               hideAfter * 1000);
    }
  }

  /** Open if closed, close if open. Every opener uses the same toggle -- `s`,
   *  right-click and a double-tap all do this "for the same reason": `esc`
   *  cannot be the documented close (it exits fullscreen first in an ordinary
   *  window) so the openers have to double as the close. */
  function toggleMenu(x, y, ndcPos) {
    if (menu.isOpen()) { menu.close(); return; }
    // menu.open() checks input.lock itself and returns false without
    // touching the DOM when it refuses. Poking the rig and killing the fling
    // are both side effects of the menu ACTUALLY opening -- doing them first
    // and unconditionally meant a right-click on a locked public display
    // still restarted the idle countdown (and cancelled any coast) for a
    // menu that never appeared.
    if (!menu.open(x, y, ndcPos)) return;
    // A fling from an earlier drag can still be coasting -- decay() alone
    // takes ~114s to reach its floor, and nothing else clears it for the
    // `s` opener, which involves no pointer event at all to do it as a
    // side effect (onDown zeros it on every new touch/click, which is why
    // this went unnoticed on the mouse and double-tap openers). Without
    // this, "the camera does not fly home while the menu is open" is kept
    // for the autonomous walk but broken for residual momentum: the menu
    // opens over a globe that keeps spinning underneath it.
    spinRate = 0;
    rig.poke(menuResume);
  }

  function onDown(ev) {
    if (!enabled) return;
    showCursor();
    // The press that dismissed the menu dismisses it and nothing else. It is
    // not a grab: clicking away from a menu is how every menu on every
    // platform is closed, and starting a drag with the same press would turn
    // "put that away" into "and also move the globe".
    //
    // It cannot be detected by asking whether the menu is open. menu.js
    // listens on `document` in the CAPTURE phase and this listener is on the
    // canvas in the bubble phase, so the menu has ALREADY closed by the time
    // this runs -- `menu.isOpen()` is false here for the dismissing press and
    // for an ordinary one alike. The menu therefore names the exact event.
    //
    // The bug this fixes: grabbing here called beginManual, whose whole job
    // includes `resumeAfter = null` -- "a drag is its own claim, at the
    // ordinary delay" -- so dismissing the menu with a click replaced the 2s
    // menu hand-back with the 15s drag one, and the walk sat parked.
    if (menu && menu.dismissedBy && menu.dismissedBy(ev)) {
      rig.poke(menuResume);
      return;
    }
    if (pointers.size === 0) gesturePinched = false;   // fresh gesture starting
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    downPos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    canvas.setPointerCapture(ev.pointerId);
    if (pointers.size === 2) gesturePinched = true;
    if (pointers.size === 2 && zoomOn) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    if (!dragOn) return;
    // No limb clamp on the GRAB: pressing on empty sky is not a grab, and
    // pretending it landed on the nearest bit of globe would jump the view by
    // however far away the press was.
    grabPoint = pickCameraSphere(ndc(ev), rig.view());
    spinRate = 0;
    lastMove = performance.now();
    rig.grab();
  }

  function onMove(ev) {
    if (!enabled) return;
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
    // Clamped to the limb HERE, unlike the grab: a pointer that runs off the
    // globe mid-drag is the ordinary way a fling ends, and without the clamp
    // the globe stops dead under a finger that is still moving.
    const hit = pickCameraSphere(ndc(ev), rig.view(), true);
    if (!hit) return;
    // The step since the LAST move, not since the press -- see trackDrag. The
    // reference advances with the pointer, or the rotation compounds and the
    // turn per pixel scales with the browser's event rate.
    const from = grabPoint;
    rig.drag(from, hit, invert !== 1);
    grabPoint = hit;

    const now = performance.now();
    const dt = Math.max(0.001, (now - lastMove) / 1000);
    lastMove = now;
    const spin = axisAngle(invert === 1 ? dragRotation(from, hit)
                                        : dragRotation(hit, from));
    spinAxis = spin.axis;
    spinRate = spin.deg / dt;
  }

  function onUp(ev) {
    if (!enabled) return;
    const hadTwo = pointers.size === 2;
    const down = downPos.get(ev.pointerId);
    pointers.delete(ev.pointerId);
    downPos.delete(ev.pointerId);
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
        grabPoint = pickCameraSphere(ndcFromClient(p.x, p.y), rig.view());
      }
      spinRate = 0;
      lastMove = performance.now();
      return;
    }
    if (pointers.size === 0) {
      grabPoint = null;
      rig.release();
      // Double-tap, touch only. Opened from pointerup, deliberately -- opening
      // from pointerdown would let this same event bubble to the outside-click
      // listener createMenu.open() just registered on document and close the
      // menu it opened in the same tick.
      if (ev.pointerType !== 'mouse' && !gesturePinched && down) {
        const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
        // <=, matching isDoubleTap's own boundary (pinned by a boundary
        // test there): exactly maxPx used to be a tap by this check and a
        // drag by that one, so a tap landing precisely on the line failed
        // isDoubleTap's distance test for a different reason than the one
        // that actually mattered.
        if (moved <= DOUBLE_TAP.maxPx) {
          const now = { t: performance.now(), x: ev.clientX, y: ev.clientY };
          if (isDoubleTap(lastTap, now, DOUBLE_TAP)) {
            toggleMenu(ev.clientX, ev.clientY, ndc(ev));
            lastTap = null;   // a third tap must not immediately re-toggle it
          } else {
            lastTap = now;
          }
        } else {
          lastTap = null;   // moved too far since its own pointerdown: a drag
        }
      }
      gesturePinched = false;
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
    downPos.clear();
    gesturePinched = false;
    pinchDist = 0;
    grabPoint = null;
    // No fling: the gesture did not end in a throw, it ended in a loss.
    spinRate = 0;
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

  function onContextMenu(ev) {
    // Not optional, not conditional on `enabled` or on the menu actually
    // opening: a wall display must never offer the browser's Back / Reload /
    // Save-as, even when input.lock refuses the menu itself. Bound on
    // `window`, not the canvas -- `.menu` is a child of `#stage`, not of the
    // canvas, and so are the rail, the degraded banner and the update mark.
    // A canvas-only listener let a right-click ON any of those (including
    // the open menu itself) through to the real browser context menu, which
    // is exactly what this preventDefault exists to stop.
    ev.preventDefault();
    if (!enabled) return;
    toggleMenu(ev.clientX, ev.clientY, ndc(ev));
  }

  function onWheel(ev) {
    if (!enabled || !zoomOn) return;
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
    // A key typed into a text box belongs to the box, not the camera. Before the
    // rules panel there were no inputs on this page, so a global handler that
    // preventDefault()s every key it knows was safe; now `-` in an address range
    // and `s` in a country code would zoom the globe and open the menu instead.
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'
              || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!enabled || !keysOn || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const [min, max] = rig.zoomRange();
    const stepDeg = 5;
    // Every one of these is poke(), never grab()/release(). A keypress is an
    // instant, not a hold: grabbing and releasing on the same key would clear
    // `held` out from under a pointer that is genuinely down.
    // Arrows turn about the camera's own axes rather than adding to lat/lon, so
    // they keep working at a pole and past one -- the same reason the drag does.
    switch (ev.key) {
      // Signs measured, not derived: a positive turn about camera +Y takes the
      // camera WEST (lon -5), and about camera +X it takes it north. These four
      // preserve the previous behaviour -- right/up move the camera east/north.
      case 'ArrowLeft':  rig.poke(); rig.spin(CAM_Y, stepDeg); break;
      case 'ArrowRight': rig.poke(); rig.spin(CAM_Y, -stepDeg); break;
      case 'ArrowUp':    rig.poke(); rig.spin(CAM_X, stepDeg); break;
      case 'ArrowDown':  rig.poke(); rig.spin(CAM_X, -stepDeg); break;
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
      case 's': {
        // A keyboard has no pointer position, so open at the centre of the
        // stage -- where the globe is -- rather than refusing for lack of one.
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        toggleMenu(cx, cy, { x: 0, y: 0 });
        break;
      }
      case 'Escape':
        // NOT the documented close -- Escape exits fullscreen in an ordinary
        // window and no handler can prevent that, so a menu that only closed
        // on esc would cost the wall its fullscreen every time it was used.
        // Bound anyway as a last resort: the menu must never be able to trap
        // someone who does not know about `s` or right-click.
        if (menu.isOpen()) menu.close();
        break;
      default: return;
    }
    ev.preventDefault();
  }

  // Camera-space axes for the arrow keys and nothing else.
  const CAM_X = { x: 1, y: 0, z: 0 };
  const CAM_Y = { x: 0, y: 1, z: 0 };

  /** Called once per animation frame. Coasts the view after a fling. */
  function tick(dt) {
    if (!enabled) { spinRate = 0; return; }
    // Opening the menu pokes the rig once; that is only enough if the idle
    // countdown cannot expire underneath it -- so keep restarting it every
    // frame it stays open, or the camera flies home mid-read. The poke carries
    // `menuResume`, so the frame the menu closes on leaves a claim that hands
    // back in a couple of seconds instead of the drag's much longer wait: the
    // walk resumes on its own shortly after the menu goes away.
    // The camera must stay manual for the WHOLE time a panel is open, not
    // just the menu: menu.js's act() closes the menu in a `finally` before
    // the panel opens, so by then the menu already reports closed. Without
    // this the autonomous walk resumed after input.resumeSeconds and a block
    // burst was free to fly the view away while somebody was mid-drag on a
    // slider.
    if (menu.isOpen() || customArcsPanel?.isOpen() || settingsPanel?.isOpen()) {
      rig.poke(menuResume);
    }
    // The hand-back ends input's ownership of the view, full stop. Damping
    // 0.85/s has a ~6.2s time constant against a 1e-6 floor, so a fling coasts
    // for ~114 seconds -- nearly four times resumeSeconds. Without this guard
    // both campath.step() and this function write curLat/curLon at once, and
    // 5.6 degrees of longitude nobody asked for arrive AFTER the display has
    // taken itself back. Two owners of one piece of state is the whole bug.
    if (!rig.manual()) { spinRate = 0; return; }
    if (rig.held() || spinRate === 0) return;
    spinRate = decay(spinRate, damping, dt);
    if (spinRate === 0) return;
    rig.spin(spinAxis, spinRate * dt);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  window.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousemove', showCursor);
  showCursor();

  /** One live setting. Keyed by the settings path so apply.js can hand it
   *  straight through; each case writes one field and nothing else. */
  function setParam(path, value) {
    switch (path) {
      case 'input.enabled':
        enabled = value;
        // Turning it off mid-gesture: onUp is gated too, so without this the
        // rig would stay `held` for ever and campath would refuse to move the
        // camera at all -- a frozen wall on a healthy feed.
        if (!enabled) {
          releaseLost();
          if (cursorTimer) clearTimeout(cursorTimer);
          // HIDE it, do not reveal it. With input off there is nothing on
          // screen to point at, and showCursor() early-returns while disabled,
          // so a revealed cursor could never be hidden again -- a wall whose
          // input was just turned off kept an arrow parked on it until the
          // page reloaded, the exact inverse of hideCursorSeconds.
          canvas.classList.add('cursor-hidden');
        } else {
          showCursor();
        }
        return;
      case 'input.drag': dragOn = value; return;
      case 'input.zoom': zoomOn = value; return;
      case 'input.keyboard': keysOn = value; return;
      case 'input.invert': invert = value ? -1 : 1; return;
      case 'input.inertia': damping = value; return;
      case 'input.zoomFactor': zoomFactor = value; return;
      case 'input.menuResumeSeconds': menuResume = value; return;
      case 'input.hideCursorSeconds':
        hideAfter = value;
        showCursor();       // restart the countdown on the new interval
        return;
      default:
        throw new Error(`input: no parameter ${path}`);
    }
  }

  return {
    tick,
    setParam,
    stop() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', showCursor);
      if (cursorTimer) clearTimeout(cursorTimer);
    },
  };
}
