// Reading a display's memory after a schema path has been renamed.
//
// THE POLICY, once, for every breaking change this release makes and every one
// after it:
//
//   * convert IN MEMORY at boot, so the wall is never wrong;
//   * write NOTHING to storage until a person approves;
//   * STAGE AND VALIDATE before writing, and refuse a partial conversion;
//   * say what it will do and what it will not, with the safe answer default.
//
// One registry rather than an ad-hoc migration per rename: three copies of
// "read old, draw right, ask before writing" will drift, and the drift is
// silent -- a display that quietly stops drawing the rules somebody typed.
//
// Imports settings.js and nothing else -- no DOM, no storage, no three -- so
// every decision here is made under `node --test`.
import { validate } from './settings.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One entry per breaking schema change.
 *
 *  `writes()` is what `stageConversion` validates -- deliberately NOT the whole
 *  blob. A stored patch can carry a path some older build wrote and this one no
 *  longer declares; refusing the conversion over it would leave the display
 *  asking the same question at every panel open for ever, with no answer that
 *  ever succeeds. An unrelated stale key is the executor's problem (it reports
 *  it at boot, by name), not this conversion's. */
export const CONVERTERS = [
  {
    id: 'arcs.custom',
    detect: (stored) => hasOwn(stored, 'arcs.rules'),
    writes: () => ['arcs.custom'],
    count: (stored) => (Array.isArray(stored['arcs.rules'])
      ? stored['arcs.rules'].length : 0),
    convert: (stored) => {
      const out = { ...stored };
      out['arcs.custom'] = stored['arcs.rules'];
      delete out['arcs.rules'];
      return out;
    },
    summary: (n) => `${plural(n, 'custom arc')} you saved under the old name `
                  + `would be stored under the new one.`,
  },
];

/** Which converters have something to do against this stored blob. */
export function pendingConversions(stored = {}) {
  return CONVERTERS.filter((c) => c.detect(stored));
}

/** The blob as this build reads it, plus what it would take to make that
 *  reading permanent. Pure: `stored` is never mutated. */
export function convertStored(stored = {}) {
  const pending = pendingConversions(stored);
  const patch = pending.reduce((acc, c) => c.convert(acc), { ...stored });
  return { patch, pending };
}

/** Build the blob that WOULD be written, and validate the paths this conversion
 *  produces before anybody stores it.
 *
 *  ALL OR NOTHING. A conversion that lands half its entries reads as "those
 *  rules never existed" -- the same discipline refresh_geoip.sh uses when it
 *  verifies a database inside the container before installing it. */
export function stageConversion(stored = {}, pending = []) {
  if (!pending.length) return { ok: true, next: { ...stored }, error: null };
  const next = pending.reduce((acc, c) => c.convert(acc), { ...stored });
  const written = {};
  for (const c of pending) {
    for (const path of c.writes()) {
      if (hasOwn(next, path)) written[path] = next[path];
    }
  }
  const { rejected } = validate(written);
  if (rejected.length) {
    const first = rejected[0];
    return { ok: false, next: null,
             error: `${first.path}: ${first.why}` };
  }
  return { ok: true, next, error: null };
}
