// What this display remembers.
//
// A PATCH of schema paths, not a config tree -- exactly what settings.apply
// consumes -- so restoring at boot is the same code path as changing at
// runtime, and a path the schema no longer declares is refused by the executor
// with a reason rather than silently reviving a dead setting.
//
// The storage object is passed in, never reached through `window`, so every
// decision here is made under `node --test` rather than in a browser. Same
// discipline as campath.js, orbit.js and rules.js.

import { compileRules } from './rules.js';

export const KEY = 'netviz.settings.v1';

/** The stored patch, or an empty one plus a reason.
 *
 *  A missing key is NOT an error: a fresh kiosk has never been configured, and
 *  warning on every boot about the normal case teaches people to ignore the
 *  warnings that matter. A corrupt value IS reported -- and deliberately left
 *  in place, because somebody may want to recover it by hand. */
export function loadPatch(storage) {
  let raw;
  try {
    raw = storage && storage.getItem ? storage.getItem(KEY) : null;
  } catch (e) {
    return { patch: {}, error: `storage unavailable: ${e.message}` };
  }
  if (raw === null || raw === undefined || raw === '') return { patch: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { patch: {}, error: `stored settings are not JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { patch: {}, error: 'stored settings are not an object' };
  }
  return { patch: parsed, error: null };
}

/** Merge `patch` onto what is stored and write it back. */
export function savePatch(storage, patch) {
  const { patch: current } = loadPatch(storage);
  const next = { ...current, ...(patch || {}) };
  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    // Private browsing, a disabled-storage kiosk, a full quota. The display
    // still works and the panel still edits live; only the memory is missing.
    return { ok: false, error: `could not save settings: ${e.message}` };
  }
  return { ok: true, error: null };
}

/** Forget what this display was told, so config.js and the collector's own
 *  /config.json decide again on the next load.
 *
 *  `keep` is the list of setting paths to carry across, and it is what makes
 *  "reset to netviz defaults" a statement about the DISPLAY rather than about
 *  the operator's work: `arcs.rules` is a list somebody sat and typed, so a
 *  control that resets the wall's appearance has no business deleting it.
 *  Everything persists into one blob under one key, so keeping a path means
 *  writing the blob back with only that path in it -- removing the key would
 *  take the rules with it, which is exactly the failure this argument exists
 *  to prevent.
 *
 *  With nothing left to keep the key is removed outright rather than left as
 *  `{}`: an empty patch and no patch mean the same thing to every reader, and
 *  a stored `{}` reads as "this display was configured" when it was not. */
export function clearPatch(storage, keep = []) {
  const kept = {};
  if (keep.length) {
    const { patch } = loadPatch(storage);
    for (const path of keep) {
      if (Object.prototype.hasOwnProperty.call(patch, path)) kept[path] = patch[path];
    }
  }
  try {
    if (Object.keys(kept).length) storage.setItem(KEY, JSON.stringify(kept));
    else storage.removeItem(KEY);
  } catch (e) {
    return { ok: false, error: `could not clear settings: ${e.message}` };
  }
  return { ok: true, error: null };
}

/**
 * Wrap a settings object so every ACCEPTED key persists.
 *
 * Accepted only: storing a rejected key would resurrect the same rejection on
 * every boot for ever. The executor's own result is returned untouched, so
 * callers -- the menu, the panel -- cannot tell the difference, which is what
 * keeps "the menu only ever calls settings.apply" true with persistence added
 * underneath it.
 */
export function withPersistence(settings, storage) {
  return {
    ...settings,
    apply(patch) {
      const out = settings.apply(patch);
      const keep = {};
      for (const path of out.applied || []) {
        if (Object.prototype.hasOwnProperty.call(patch, path)) keep[path] = patch[path];
      }
      if (Object.keys(keep).length) {
        const saved = savePatch(storage, keep);
        if (!saved.ok) console.warn(`netviz: ${saved.error}`);
      }
      return out;
    },
  };
}

/** The list as a file. Two-space JSON with a trailing newline: this is the
 *  same shape config.js takes, so an export can equally be pasted into a
 *  tracked config rather than only re-imported. */
export function serialiseRules(list) {
  return `${JSON.stringify(Array.isArray(list) ? list : [], null, 2)}\n`;
}

/** `netviz-rules-YYYY-MM-DD.json`, in UTC so two displays in different
 *  timezones cannot produce two filenames for the same backup. */
export function exportFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const iso = d.toISOString().slice(0, 10);
  return `netviz-rules-${iso}.json`;
}

/**
 * A file back into a rule list, or a reason it was refused.
 *
 * ALL-or-nothing, and every bad row is named rather than only the first: an
 * import is one deliberate act, so the person doing it can fix the file once
 * instead of discovering its faults one reload at a time. A live edit is the
 * opposite call -- see readyRules() in rules_panel.js.
 */
export function parseImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${e.message}` };
  }
  if (!Array.isArray(parsed)) return { error: 'not a list of rules' };
  const { refused } = compileRules(parsed);
  if (refused.length) {
    return { error: refused.map((r) => `rule ${r.index + 1}: ${r.reason}`).join('; ') };
  }
  return { rules: parsed, error: null };
}
