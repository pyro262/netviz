// How much traffic each colour rule is claiming.
//
// Counted in the RENDERER, not the collector: the collector has never seen the
// rule list -- it is per-display and lives in localStorage -- so there is
// nowhere else this can be done. Imports nothing, so the counting is decided
// under `node --test`.
//
// Two rolling windows per class, the same lapped-slot discipline as
// netviz/stats.py's RollingCounter: a slot stores the absolute bucket index it
// was written for, so a lapped slot is cleared on next touch. Without that
// check an hour-old count survives for ever as long as traffic keeps landing
// on the same slot index.

/** Identity for counting: what a rule MATCHES, not how it looks. Colour and
 *  name are excluded on purpose, so recolouring a rule keeps its history --
 *  the history is about the traffic, not about the swatch. */
export function ruleKey(rule) {
  const r = rule || {};
  return `${r.match || ''}|${r.end || 'either'}`;
}

function makeWindow(slots, ms) {
  return { slots, ms, count: new Array(slots).fill(0), at: new Array(slots).fill(-1) };
}

// A moment exactly on a bucket boundary belongs to the bucket that just ENDED,
// not the one that is only now starting -- an event fired 1ms before "now"
// must land in the same bucket "now" itself reads back, or a query landing
// exactly on the edge (rare on a live clock, routine at nowMs=3600000 in a
// test) reports its own most recent event as one bucket stale.
function bucketAt(ms, atMs) {
  return Math.floor((atMs - 1) / ms);
}

function touch(w, nowMs) {
  const bucket = bucketAt(w.ms, nowMs);
  const i = ((bucket % w.slots) + w.slots) % w.slots;
  if (w.at[i] !== bucket) { w.at[i] = bucket; w.count[i] = 0; }
  return { i, bucket };
}

function total(w, nowMs) {
  const bucket = bucketAt(w.ms, nowMs);
  let sum = 0;
  for (let i = 0; i < w.slots; i += 1) {
    if (w.at[i] > bucket - w.slots && w.at[i] <= bucket) sum += w.count[i];
  }
  return sum;
}

export function createClassCounter(opts = {}) {
  const rateSlots = opts.rateSlots || 60;
  const rateMs = opts.rateMs || 1000;
  const sparkSlots = opts.sparkSlots || 20;
  const sparkMs = opts.sparkMs || 180000;      // 20 x 3min = the last hour
  const byClass = new Map();

  function windows(cls) {
    let w = byClass.get(cls);
    if (!w) {
      w = { rate: makeWindow(rateSlots, rateMs), spark: makeWindow(sparkSlots, sparkMs) };
      byClass.set(cls, w);
    }
    return w;
  }

  return {
    add(cls, nowMs) {
      const w = windows(cls);
      const r = touch(w.rate, nowMs);
      w.rate.count[r.i] += 1;
      const s = touch(w.spark, nowMs);
      w.spark.count[s.i] += 1;
    },

    /** Events per minute over the rate window. */
    ratePerMin(cls, nowMs) {
      const w = byClass.get(cls);
      if (!w) return 0;
      const seconds = (rateSlots * rateMs) / 1000;
      return (total(w.rate, nowMs) * 60) / seconds;
    },

    /** The last hour, oldest first -- or NULL when nothing happened in it. A
     *  flat line at zero is a claim, and it is what a broken series looks
     *  like; the rail draws nothing instead. */
    spark(cls, nowMs) {
      const w = byClass.get(cls);
      if (!w || total(w.spark, nowMs) === 0) return null;
      const bucket = bucketAt(sparkMs, nowMs);
      const out = [];
      for (let age = sparkSlots - 1; age >= 0; age -= 1) {
        const b = bucket - age;
        const i = ((b % sparkSlots) + sparkSlots) % sparkSlots;
        out.push(w.spark.at[i] === b ? w.spark.count[i] : 0);
      }
      return out;
    },

    /** Forget every class not in `keys`. Called whenever the rule list
     *  changes, so a deleted rule's numbers can never be shown beside the one
     *  that took its place. */
    setKeys(keys) {
      const keep = new Set(keys || []);
      for (const cls of [...byClass.keys()]) if (!keep.has(cls)) byClass.delete(cls);
    },
  };
}
