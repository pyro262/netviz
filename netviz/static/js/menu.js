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
 * The twelve layers, grouped for the submenu. A group is a label, not a
 * control -- SKY/WEATHER/MAP/EVENTS are how a person reading the list finds
 * a layer, not a schema concept, so a header's id is deliberately NOT a
 * `layers.*` path (it starts `layers-group-`) and nothing ever
 * `settings.apply()`s it. Order and labels are exactly the ones named for
 * this task; the five that already had a friendlier label than their key
 * (`bordersWatched` → "Watched countries", `cityLights` → "City lights",
 * `ripples` → "Impact ripples") keep it, everything new is titlecased from
 * the key.
 */
const LAYER_GROUPS = [
  { header: 'SKY', rows: [
    ['stars', 'Stars'],
    ['aurora', 'Aurora'],
    ['atmosphere', 'Atmosphere'],
  ] },
  { header: 'WEATHER', rows: [
    ['clouds', 'Clouds'],
    ['lightning', 'Lightning'],
  ] },
  { header: 'MAP', rows: [
    ['coastline', 'Coastline'],
    ['bordersWatched', 'Watched countries'],
    ['bordersWorld', 'World borders'],
    ['admin1', 'States and provinces'],
    ['cityLights', 'City lights'],
  ] },
  { header: 'EVENTS', rows: [
    ['ripples', 'Impact ripples'],
    ['countryFlash', 'Country flash'],
  ] },
];

/**
 * menuModel(state) → Array<Item>
 *
 * Builds the menu structure given the display's current state.
 * state is {railOn, layers: {...twelve keys...}, layersExpanded,
 * canLookHere, settingsPanel, rulesPanel, canReset}.
 *
 * Returns an array of top-level menu items in this order:
 * - lookHere: action, enabled only when pointer was on globe
 * - rail: toggle, reflects current rail state
 * - layers: submenu, click-to-expand, with a group header (kind: 'group',
 *   non-interactive) before each of the four groups and a toggle for each
 *   of the twelve layers -- present only while state.layersExpanded is
 *   true, so a collapsed submenu carries no child items at all rather than
 *   twelve items with nothing rendering them.
 * - settings: action, enabled when settings panel exists, with note when disabled
 *
 * Each item is {id, label, kind, on?, enabled, note?, items?, expanded?}.
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
      expanded: !!state.layersExpanded,
      items: state.layersExpanded
        ? LAYER_GROUPS.flatMap((g) => [
            { id: `layers-group-${g.header.toLowerCase()}`, label: g.header, kind: 'group' },
            ...g.rows.map(([key, label]) => ({
              id: `layers.${key}`,
              label,
              kind: 'toggle',
              on: state.layers[key],
              enabled: true,
            })),
          ])
        : [],
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

  // Whether the Layers group is expanded. A closure variable, not a module
  // global and not read/written through settings.apply -- it is transient
  // UI state ("did this operator already open the list"), not a display
  // setting, and it must not ride localStorage the way every schema path
  // does.
  //
  // RESET TO false ON EVERY open(), deliberately. It used to persist across
  // opens, on the theory that somebody adjusting several layers should not
  // re-open the group each visit. On the wall that read as the menu popping
  // open at twelve rows tall every single time -- the group stays expanded
  // for the rest of the page's life after one visit, and the common case is
  // not adjusting layers at all. Collapsed-by-default costs one click to the
  // person who wants layers and nothing to everybody else, which is the
  // trade the other way round from the one first shipped.
  let layersExpanded = false;
  // The (x, y, point) the menu is currently drawn at, so the Layers header
  // can rebuild the menu IN PLACE at the same position when clicked, without
  // going through open() again -- open() forgets the last dismissal and
  // re-registers the outside-click/esc/blur listeners, neither of which an
  // expand/collapse should touch.
  let lastOpen = null;

  function isOpen() { return node !== null; }

  /** The live state menuModel() is built from, re-read fresh every time
   *  (including on an expand/collapse) so a layer flipped elsewhere -- by
   *  this menu a moment ago, or by anything else that calls settings.apply
   *  -- is never stale by the time it is redrawn. */
  function currentState(point) {
    return {
      railOn: cfg('rail.enabled', false),
      layers: {
        cityLights: cfg('layers.cityLights', true),
        coastline: cfg('layers.coastline', true),
        bordersWatched: cfg('layers.bordersWatched', true),
        bordersWorld: cfg('layers.bordersWorld', true),
        admin1: cfg('layers.admin1', true),
        stars: cfg('layers.stars', true),
        aurora: cfg('layers.aurora', true),
        atmosphere: cfg('layers.atmosphere', true),
        ripples: cfg('layers.ripples', true),
        countryFlash: cfg('layers.countryFlash', true),
        clouds: cfg('layers.clouds', false),
        lightning: cfg('layers.lightning', false),
      },
      layersExpanded,
      canLookHere: point !== null,
      // Enabled when this menu was built with a panel to open. A menu
      // constructed without one -- as some tests still are -- must not draw
      // a row whose click handler is guarded out. Same rule as rulesPanel.
      settingsPanel: !!settingsPanel,
      rulesPanel: !!rulesPanel,
      canReset: !!onReset,
    };
  }

  function buildNode(point) {
    const n = el('div', 'menu');
    for (const item of menuModel(currentState(point))) n.append(renderItem(item, point));
    return n;
  }

  /** The Layers header's click handler. Flips the remembered expand state
   *  and redraws the menu at its current position -- it must NOT close the
   *  menu (that is the whole point of making this click-to-expand rather
   *  than an ordinary action) and so it is never passed through act(), which
   *  closes unconditionally in a `finally`. See the header's own
   *  addEventListener call below for the guard against this being undone by
   *  accident. */
  function toggleLayersExpand() {
    layersExpanded = !layersExpanded;
    if (!node || !lastOpen) return;   // nothing open to redraw
    const fresh = buildNode(lastOpen.point);
    node.remove();
    root.appendChild(fresh);
    node = fresh;
    clampPosition(node, lastOpen.x, lastOpen.y);
  }

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
    // A group header (SKY/WEATHER/MAP/EVENTS) is a label, not a control: no
    // `.menu-item` class (so it never picks up the item hover rule), no
    // click listener, nothing else to build.
    if (item.kind === 'group') {
      const header = el('div', 'menu-group-header', item.label);
      header.setAttribute('data-id', item.id);
      return header;
    }

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

    // 'submenu': click-to-expand header plus, while expanded, its children
    // (four group labels and twelve toggles), indented.
    //
    // This used to be always-expanded -- "the whole menu is a handful of
    // items, and a second interaction to reveal five toggles would cost more
    // on a touch wall than it saves" -- and that was true of five layers.
    // It stopped being true once every layer got a row: with the rules and
    // reset items present (the live-deployment case), the menu has 6
    // top-level rows with Layers collapsed (lookHere, rail, layers, rules,
    // settings, reset). Always-expanded at five layers added 5 more (11
    // total); always-expanded at twelve layers plus their four group headers
    // would add 16 (22 total) -- more than triple the collapsed count, most
    // of it below the fold on a touch wall, to show toggles for layers
    // nobody came to change today. Collapsed, the twelve-layer menu is still
    // the same 6 rows it always was; expanding it is one tap, same cost as
    // the double-tap that opened the menu in the first place.
    const mark = item.expanded ? '▾' : '▸';
    row.append(el('span', 'menu-expand-mark', mark));
    // Deliberately a bare addEventListener, NOT act(toggleLayersExpand):
    // act() closes the menu in a `finally` after every click, which is right
    // for a toggle or an action -- the thing you came to change has changed,
    // so the menu's job here is done -- and wrong for this one row, whose
    // entire purpose is to let you flip several layers without reopening the
    // menu between them. This is the only click handler in this file not
    // wrapped in act(); if a future edit "cleans it up" into
    // row.addEventListener('click', act(toggleLayersExpand)), every layer
    // toggle starts closing the menu on the click that was supposed to just
    // reveal them.
    row.addEventListener('click', () => toggleLayersExpand());
    const wrap = el('div', 'menu-submenu-wrap');
    wrap.append(row);
    if (item.expanded) {
      const sub = el('div', 'menu-submenu');
      for (const child of item.items || []) sub.append(renderItem(child, point));
      wrap.append(sub);
    }
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
    // Every open starts with the Layers group shut -- see its declaration for
    // why this is a reset rather than remembered state.
    layersExpanded = false;

    const point = rig.pointAt(ndc);
    lastOpen = { x, y, point };
    node = buildNode(point);
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
