// The named theme library: a look somebody liked, kept by name.
//
// A SECOND localStorage KEY, not a field inside netviz.settings.v1. The
// settings blob is what "Reset to netviz defaults" clears, and a library nested
// inside it would either be lost on every reset or would need a keep-list entry
// pointing at a nested field, which clearPatch() cannot express -- it keeps
// whole paths. Its own key also means a corrupt library cannot take the
// display's settings down with it.
//
// Same discipline as rulestore.js, for the same reasons: a missing key is not
// an error (a fresh kiosk has saved nothing), a corrupt value IS reported and
// deliberately LEFT IN PLACE so somebody can recover it by hand, and a storage
// failure degrades to "edits still work, memory does not".
//
// Storage is passed in, never reached through `window`, so every decision here
// is made under `node --test`.
import { RANDOMIZE_PATHS } from './randomize_color.js';

export const THEME_KEY = 'netviz.themes.v1';

/** Every path a saved theme captures.
 *
 *  RANDOMIZE_PATHS is unioned in rather than listed: a saved theme has to
 *  reproduce a Randomize result faithfully, and Randomize reaches past the
 *  twenty element colors into the two arc colors, the two surface tints and the
 *  three atmosphere numbers. Deriving the set from the roller means anything
 *  added to Randomize is captured without a second edit here -- and a path
 *  Randomize can write that a saved theme does not carry is a look that reloads
 *  different from how it was saved. */
export function capturePaths() {
  return [...new Set(['appearance.theme', 'appearance.customRamp',
                      ...RANDOMIZE_PATHS])];
}

export function loadThemes(storage) {
  let raw;
  try {
    raw = storage && storage.getItem ? storage.getItem(THEME_KEY) : null;
  } catch (e) {
    return { themes: {}, error: `storage unavailable: ${e.message}` };
  }
  if (raw === null || raw === undefined || raw === '') return { themes: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { themes: {}, error: `saved themes are not JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { themes: {}, error: 'saved themes are not an object' };
  }
  return { themes: parsed, error: null };
}

function write(storage, themes) {
  try {
    storage.setItem(THEME_KEY, JSON.stringify(themes));
  } catch (e) {
    return { ok: false, error: `could not save the theme: ${e.message}` };
  }
  return { ok: true, error: null };
}

export function saveTheme(storage, name, patch) {
  const { themes } = loadThemes(storage);
  return write(storage, { ...themes, [name]: { ...patch } });
}

export function deleteTheme(storage, name) {
  const { themes } = loadThemes(storage);
  const next = { ...themes };
  delete next[name];
  return write(storage, next);
}

/** Case-insensitive, so a picker reads alphabetically to a person rather than
 *  putting every capitalized name above every lowercase one. */
export function themeNames(themes = {}) {
  return Object.keys(themes)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
