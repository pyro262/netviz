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

/** Forget everything this display was told, so the collector's own config and
 *  the NETVIZ_HIGHLIGHT* migration take over again on the next load. */
export function clearPatch(storage) {
  try {
    storage.removeItem(KEY);
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
