// menu.js — the pure half of the on-screen menu: the model and the double-tap rule.
// The renderer and the action handler are in a later task.

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
  if (timeDiff > opts.maxMs) return false;

  const distSq = (now.x - prev.x) ** 2 + (now.y - prev.y) ** 2;
  const maxDistSq = opts.maxPx ** 2;
  if (distSq > maxDistSq) return false;

  return true;
}

/**
 * menuModel(state) → Array<Item>
 *
 * Builds the menu structure given the display's current state.
 * state is {railOn, layers: {...}, canLookHere, settingsPanel}.
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
    {
      id: 'settings',
      label: 'Settings',
      kind: 'action',
      enabled: state.settingsPanel,
      note: state.settingsPanel ? undefined : 'Settings panel coming in a future build',
    },
  ];
}
