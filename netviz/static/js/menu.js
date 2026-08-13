// menu.js — the on-screen menu: the model, the double-tap rule, and (this
// task) the thing that actually draws and acts. Task 3 wires the openers
// (right-click, `s`, double-tap) into `createMenu`'s open()/close(); nothing
// here decides WHEN to open.
import { cfg } from './config.js';

export const DOUBLE_TAP = { maxMs: 320, maxPx: 24 };

/**
 * isDoubleTap(prev, now, opts) → boolean
 *
 * Detects whether two taps form a double-tap gesture.
 * prev and now are {t: milliseconds, x: pixels, y: pixels}.
 * opts is {maxMs, maxPx} — the time and distance windows.
 *
 * Returns false if prev is null (the first tap of the session).
 */
export function isDoubleTap(prev, now, opts) {
  if (!prev) return false;

  const timeDiff = now.t - prev.t;
  if (timeDiff < 0 || timeDiff > opts.maxMs) return false;

  const distSq = (now.x - prev.x) ** 2 + (now.y - prev.y) ** 2;
  const maxDistSq = opts.maxPx ** 2;
  if (distSq > maxDistSq) return false;

  return true;
}

/**
 * menuModel(state) → Array<Item>
 *
 * Builds the menu structure given the display's current state.
 * state is {railOn, layers: {...}, canLookHere, settingsPanel, rulesPanel, canReset}.
 *
 * Returns an array of top-level menu items in this order:
 * - lookHere: action, enabled only when pointer was on globe
 * - rail: toggle, reflects current rail state
 * - layers: submenu with toggles for visible layers
 * - settings: action, enabled when settings panel exists, with note when disabled
 *
 * Each item is {id, label, kind, on?, enabled, note?, items?}.
 */
export function menuModel(state) {
  return [
    {
      id: 'lookHere',
      label: 'Look here',
      kind: 'action',
      enabled: state.canLookHere,
    },
    {
      id: 'rail',
      label: 'Stats rail',
      kind: 'toggle',
      on: state.railOn,
      enabled: true,
    },
    {
      id: 'layers',
      label: 'Layers',
      kind: 'submenu',
      enabled: true,
      items: [
        {
          id: 'layers.stars',
          label: 'Stars',
          kind: 'toggle',
          on: state.layers.stars,
          enabled: true,
        },
        {
          id: 'layers.aurora',
          label: 'Aurora',
          kind: 'toggle',
          on: state.layers.aurora,
          enabled: true,
        },
        {
          id: 'layers.bordersWatched',
          label: 'Watched countries',
          kind: 'toggle',
          on: state.layers.bordersWatched,
          enabled: true,
        },
        {
          id: 'layers.cityLights',
          label: 'City lights',
          kind: 'toggle',
          on: state.layers.cityLights,
          enabled: true,
        },
        {
          id: 'layers.ripples',
          label: 'Impact ripples',
          kind: 'toggle',
          on: state.layers.ripples,
          enabled: true,
        },
      ],
    },
    // Absent, not disabled, when the display is locked: the lock says
    // configuring is not on offer, and a greyed row advertises a control
    // nobody in the room can use.
    ...(state.rulesPanel ? [{
      id: 'rules',
      label: 'Color rules…',
      kind: 'action',
      enabled: true,
    }] : []),
    {
      id: 'settings',
      label: 'Settings…',
      kind: 'action',
      enabled: state.settingsPanel,
      note: state.settingsPanel ? undefined : 'Settings panel coming in a future build',
    },
    // A display-wide control, so it lives beside the other display-wide ones
    // rather than in the rules editor -- which is where it started, under a
    // label ("Reset to collector", then "Discard my rules") that read as
    // though the rules were the thing being thrown away. They are not: the
    // rules are the operator's own work and this keeps them. What it resets
    // is everything the menu itself sets -- the rail, the layers, anything a
    // future settings panel writes -- back to what netviz ships.
    //
    // Absent, not disabled, when the display is locked, same as the rules
    // editor and for the same reason.
    ...(state.canReset ? [{
      id: 'reset',
      label: 'Reset to netviz defaults',
      kind: 'action',
      enabled: true,
    }] : []),
  ];
}

// ---------------------------------------------------------------- the DOM --
//
// Everything above this line is pure and covered by menuModel's own tests.
// Everything below needs a DOM, real or the minimal fake `tests/js/rail.test.mjs`
// already uses -- createElement/append/remove/classList, never innerHTML.

/** Most item ids ARE the schema path they write -- that is the whole point of
 *  reusing menuModel's layer ids -- but the top-level toggles read friendlier
 *  than their path (`rail`, not `rail.enabled`), so the handful that differ
 *  are named here rather than guessed from the id at click time. */
const TOGGLE_PATHS = { rail: 'rail.enabled' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Keep the menu fully inside the viewport, measured after it is in the DOM so
 * real layout decides the size. A fake DOM under `node --test` has no layout
 * at all -- offsetWidth/offsetHeight come back 0/undefined there -- so a
 * nominal fallback size is used rather than clamping against nothing.
 */
function clampPosition(node, x, y) {
  const w = node.offsetWidth || 220;
  const h = node.offsetHeight || 160;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || (x + w);
  const vh = (typeof window !== 'undefined' && window.innerHeight) || (y + h);
  const left = Math.max(4, Math.min(x, vw - w - 4));
  const top = Math.max(4, Math.min(y, vh - h - 4));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

/**
 * createMenu({ rig, settings, rulesPanel, settingsPanel, onReset, root }) -> { open(x, y, ndc), close(), isOpen() }
 *
 * `rig` supplies `pointAt(ndc)` (what the pointer was over, for "Look here")
 * and `lookHere(lat, lon)` (the action itself) -- NOT `visit()`, which is the
 * automatic block-burst detour's path and, unlike this one, must never
 * override a held view; see camera.js's own comment on the two methods for
 * why they cannot share a code path. `settings` is the live applier --
 * every click that changes something goes through `settings.apply({path:
 * value})`, because the layer ids in menuModel's submenu ARE schema paths and
 * there is no second way to write one; the menu never touches CONFIG or a
 * live object directly. `rulesPanel` is the color-rules editor
 * (`createRulesPanel`) -- the menu only opens it, it never touches
 * settings.apply for anything the panel owns. `settingsPanel`
 * (`createSettingsPanel`) is the tuning panel, opened the same way; the two
 * panels never coexist -- see `open()`'s own comment on that. `root` is the
 * DOM node the menu mounts under --
 * `document.body` on the real page, and deliberately NOT `#stage`: `#stage`
 * is `position: fixed`, which creates a stacking context, so a menu inside it
 * ranks its z-index only among stage's own children and the `#rail` sibling
 * painted its numbers straight over the menu's opaque background.
 *
 * Built from menuModel() on every open, never cached across opens, so a
 * toggle flipped a minute ago -- by this menu or by anything else that calls
 * settings.apply -- shows correctly the next time somebody opens it.
 */
export function createMenu({ rig, settings, rulesPanel, settingsPanel, onReset, root }) {
  let node = null;
  // The pointerdown that dismissed the menu, kept only until the next open.
  //
  // This listener is on `document` in the CAPTURE phase and input.js's is on
  // the canvas in the bubble phase, so input.js sees the dismissing press
  // AFTER the menu has already closed -- `isOpen()` is false by then and a
  // dismissal is indistinguishable from an ordinary press on the globe. It
  // used to grab the camera on that press, and a grab is a drag's own claim,
  // which replaced the menu's 2s hand-back with a drag's 15s: closing the
  // menu with a click parked the walk for fifteen seconds. Event identity is
  // the only thing that separates the two cases; no timing heuristic can.
  let dismissEvent = null;

  function isOpen() { return node !== null; }

  /** Was THIS event the press that dismissed the menu? Identity, not shape --
   *  two presses in the same place are different events and only one of them
   *  closed anything. */
  function dismissedBy(e) { return e != null && e === dismissEvent; }

  function onOutside(e) {
    if (node && e && e.target && !node.contains(e.target)) {
      dismissEvent = e;
      close();
    }
  }
  function onKeyDown(e) {
    if (e && e.key === 'Escape') close();
  }
  function onBlur() { close(); }

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
  }

  /** Wrap an action so any click closes the menu -- one of the close
   *  triggers named in the brief, and leaving a stale menu open over
   *  whatever the click just changed would read as unfinished.
   *
   *  try/finally, not fn() followed by close(): a throwing settings.apply
   *  (a rejected patch is reported, not thrown, but nothing guarantees every
   *  future action stays that well-behaved) used to leave the menu open over
   *  a change that never happened -- the one state this wrapper exists to
   *  prevent, reached by the one path that skipped it. */
  function act(fn) {
    return () => { try { fn(); } finally { close(); } };
  }

  function renderItem(item, point) {
    const row = el('div', `menu-item menu-${item.kind}${item.enabled ? '' : ' disabled'}`);
    // NOT `row.dataset.id = ...`: `dataset` is a getter with no setter on a
    // real HTMLElement, so assigning to it (or replacing it) throws in
    // strict mode. setAttribute works identically on a real element and on
    // any fake that bothers to implement it, which is the whole reason to
    // prefer it over the DOM's convenience accessors here.
    row.setAttribute('data-id', item.id);
    row.append(el('span', 'menu-label', item.label));

    if (item.kind === 'toggle') {
      row.append(el('span', `menu-check${item.on ? ' on' : ''}`, item.on ? '✓' : ''));
      if (item.enabled) {
        const path = TOGGLE_PATHS[item.id] || item.id;
        row.addEventListener('click', act(() => settings.apply({ [path]: !item.on })));
      }
      return row;
    }

    if (item.kind === 'action') {
      if (item.note) row.append(el('span', 'menu-note', item.note));
      if (item.enabled) {
        row.addEventListener('click', act(() => {
          if (item.id === 'lookHere' && point) rig.lookHere(point.lat, point.lon);
          // Both panels are opened from this same menu, both mount at
          // z-index 6 on document.body, and there is no reason to have both
          // up at once -- so opening one closes the other rather than
          // letting them overlap. The menu is what dispatches both actions,
          // so it is the one place that knows about both panels; neither
          // panel needs to know the other exists.
          // ...and the tuning panel is closed through requestClose(), never
          // close(), because it may hold changes nobody has kept: the
          // force-close discarded them SILENTLY, which is the one case its own
          // Close question exists to catch. requestClose asks when something is
          // pending, closes at once when nothing is, and calls back only when
          // the panel actually went -- so a cancel leaves the tuning panel open
          // with its changes intact and the rules panel unopened, rather than
          // this handler racing an answer it never waited for.
          if (item.id === 'rules' && rulesPanel) {
            if (settingsPanel) settingsPanel.requestClose(() => rulesPanel.open());
            else rulesPanel.open();
          }
          if (item.id === 'settings' && settingsPanel) { rulesPanel?.close(); settingsPanel.open(); }
          if (item.id === 'reset' && onReset) onReset();
        }));
      }
      return row;
    }

    // 'submenu': a non-interactive header plus its children, indented.
    // Always expanded rather than click-to-open -- the whole menu is a
    // handful of items, and a second interaction to reveal five toggles
    // would cost more on a touch wall than it saves.
    const wrap = el('div', 'menu-submenu-wrap');
    wrap.append(row);
    const sub = el('div', 'menu-submenu');
    for (const child of item.items || []) sub.append(renderItem(child, point));
    wrap.append(sub);
    return wrap;
  }

  /**
   * Open at screen position (x, y); `ndc` is the same pointer position in
   * normalised device coordinates, for `rig.pointAt`. Returns false and draws
   * nothing when `input.lock` is set -- checked here, at open time, rather
   * than held as a copy, so a lock flipped while the menu is closed takes
   * effect on the very next open with no extra wiring.
   */
  function open(x, y, ndc) {
    if (cfg('input.lock', false)) return false;
    // Forget the last dismissal. Held any longer it would suppress the grab on
    // some unrelated press later on -- a dead camera -- and keep a DOM event
    // reachable for as long as the page runs.
    dismissEvent = null;
    close();   // the opening gesture repeated: a fresh open replaces any old one

    const point = rig.pointAt(ndc);
    const state = {
      railOn: cfg('rail.enabled', false),
      layers: {
        stars: cfg('layers.stars', true),
        aurora: cfg('layers.aurora', true),
        bordersWatched: cfg('layers.bordersWatched', true),
        cityLights: cfg('layers.cityLights', true),
        ripples: cfg('layers.ripples', true),
      },
      canLookHere: point !== null,
      // Enabled when this menu was built with a panel to open. A menu
      // constructed without one -- as some tests still are -- must not draw
      // a row whose click handler is guarded out. Same rule as rulesPanel.
      settingsPanel: !!settingsPanel,
      // The lock is already checked at the top of open(), so a menu that
      // drew at all may offer this -- but only if this menu was actually
      // built with a panel to open; a menu constructed without one (as some
      // tests still do) must not draw a row whose handler is guarded out.
      rulesPanel: !!rulesPanel,
      // Same rule as rulesPanel: a menu built without a reset handler must not
      // draw a row whose click does nothing.
      canReset: !!onReset,
    };

    node = el('div', 'menu');
    for (const item of menuModel(state)) node.append(renderItem(item, point));
    root.appendChild(node);
    clampPosition(node, x, y);

    // Outside click/tap and esc are captured on the document so they fire
    // however the menu is dismissed; blur is the page losing focus outright.
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKeyDown, true);
    if (typeof window !== 'undefined') window.addEventListener('blur', onBlur);
    return true;
  }

  return { open, close, isOpen, dismissedBy };
}
