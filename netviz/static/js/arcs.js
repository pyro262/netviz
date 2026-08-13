// Fixed pool of great-circle tubes. Geometry is allocated once at construction
// and rewritten on spawn; on a wall display that runs for months, nothing may
// allocate per event.
import * as THREE from 'three';
import { plasmaAt } from './palette.js';
import { classNameFor, foreignEnd } from './classify.js';
import { compileRules, firstMatch, firstOverride } from './rules.js';
import { densityGain } from './density.js';
import { latLonToVec3 } from './globe.js';
import { cfg } from './config.js';

const SEGMENTS = 48;
const RADIAL = 5;

// The live feed runs ~57 events/sec. Drawing every one of them at a 6s life
// saturates any sane pool, and because the tubes blend additively, hundreds
// overlapping along the same corridor sum into a solid wash -- the globe
// disappears behind its own traffic. The display samples instead: blocks are
// rare and always drawn, flows are capped per second. Nothing is lost, the
// collector still stores and streams everything.
const FLOWS_PER_SECOND = cfg('traffic.flowsPerSecond', 14);

// Color is derived, not stored: `color` (an explicit hex) wins over `colorAt`
// (a position on the plasma ramp) and `gain` multiplies the result down. Any of
// the three changing means the derived value has to be recomputed.
const COLOR_KEYS = ['color', 'colorAt', 'gain'];

function specColor(c) {
  const base = c.color ? new THREE.Color(c.color) : plasmaAt(c.colorAt);
  return base.multiplyScalar(c.gain === undefined ? 1 : c.gain);
}

// lift scales the apex with chord length so short hops stay flat and long ones
// sweep. maxRise caps it: chord runs to 2r for a near-antipodal pair, so an
// uncapped block arc peaked 0.9r above the surface and towered over the limb
// -- taller than the globe's own silhouette is wide on screen.
/** Build a class spec from config.js. `color` (an explicit hex) wins over
 *  `colorAt` (a position on the plasma ramp); `gain` multiplies the result down,
 *  which is almost always what the wall wants. See config.js for what each
 *  field does and why the defaults are where they are. */
function classSpec(name, fallback) {
  const c = { ...fallback, ...cfg(`arcs.${name}`, {}) };
  // `hex` keeps the source of the color around, because setSpec has to be able
  // to recompute the derived THREE.Color when gain or colorAt moves later.
  return { ...c, hex: c.color, color: specColor(c) };
}

/** The geometry every color rule shares, read fresh on each call so a
 *  settings change to `arcs.highlight` reaches the next rebuild. `gain` and
 *  `bloomScale` are the fallbacks a rule that omits them takes -- the shipped
 *  0.70 / 0.41 live in config.js, not here. */
function sharedShape() {
  return { life: 4.0, tube: 0.0032, speed: 0.9, lift: 0.28, maxRise: 0.24,
           bloomScale: 0.41, gain: 0.70, ...cfg('arcs.highlight', {}) };
}

/**
 * Build the class -> spec table.
 *
 * Called from createArcs() rather than evaluated at import, because the color
 * rules can arrive from the collector's /config.json and a table frozen at
 * module load would be built before that fetch resolves. See
 * loadServerConfig() in config.js.
 *
 * Every rule shares one shape (`arcs.highlight`) and differs only in color,
 * gain and bloomScale. A single rule's class can still be overridden on its
 * own with an `arcs.rule2` key.
 */
function buildClasses() {
  const table = {
    flow: classSpec('flow', { life: 4.0, tube: 0.0032, colorAt: 0.30, gain: 1.0,
                              speed: 0.9, lift: 0.28, maxRise: 0.24, bloomScale: 1.25 }),
    block: classSpec('block', { life: 18.0, tube: 0.0052, colorAt: 0.86, gain: 0.74,
                                speed: 0.55, lift: 0.45, maxRise: 0.21, bloomScale: 0.5 }),
  };
  // One class per rule, all sharing the `arcs.highlight` geometry. Color,
  // gain and bloomScale come from the rule; a rule that omits gain or
  // bloomScale gets the shape's own, which is where the shipped 0.70 / 0.41
  // live -- no default is invented here.
  const shared = sharedShape();
  compileRules(cfg('arcs.rules', [])).rules.forEach((rule, i) => {
    const name = `rule${i + 1}`;
    table[name] = classSpec(name, {
      ...shared,
      color: rule.color,
      gain: rule.gain === undefined ? shared.gain : rule.gain,
      bloomScale: rule.bloomScale === undefined ? shared.bloomScale : rule.bloomScale,
    });
  });
  return table;
}

// lift scales the apex with chord length so short hops stay flat and long ones
// sweep. maxRise caps it: chord runs to 2r for a near-antipodal pair, so an
// uncapped block arc peaks 0.9r above the surface and towers over the limb --
// taller than the globe's own silhouette is wide on screen.

const CURVE_SAMPLES = 32;

/** Great-circle path between two surface points, raised by a sine profile.
 *
 *  NOT a quadratic bezier with a lifted midpoint, which is the obvious
 *  construction and is wrong: past ~130 degrees of separation the curve sags
 *  BELOW the sphere near its endpoints (0.95r at 150 deg, 0.87r at 175 deg)
 *  and the globe swallows those sections, so a long arc renders with a break
 *  in it. Block arcs come from geo-blocked countries half a world away, so
 *  they were the ones that broke.
 *
 *  Slerp keeps every sample exactly on the great circle and the sin(pi*t)
 *  profile is zero at both ends and peaks in the middle, so the path is at or
 *  above the surface everywhere by construction. */
function arcCurve(a, b, radius, lift, maxRise) {
  const base = radius * 1.005;
  const chord = a.distanceTo(b);
  // Chord length sets the apex height, so short hops stay flat and
  // intercontinental arcs sweep -- bounded, or the longest ones dwarf the globe.
  const peak = Math.min(radius * maxRise, chord * lift);

  const va = a.clone().normalize();
  const vb = b.clone().normalize();
  let omega = va.angleTo(vb);
  let axis = null;
  if (Math.sin(omega) < 1e-4) {
    // Coincident or antipodal: slerp is undefined. Any great circle through
    // them is as good as any other, so pick one off an arbitrary perpendicular.
    axis = new THREE.Vector3(0, 1, 0);
    if (Math.abs(va.dot(axis)) > 0.9) axis.set(1, 0, 0);
    axis.cross(va).normalize();
    if (omega < 1e-4) omega = 0;
  }

  const points = [];
  for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
    const t = i / CURVE_SAMPLES;
    let dir;
    if (axis === null) {
      const s = Math.sin(omega);
      dir = va.clone().multiplyScalar(Math.sin((1 - t) * omega) / s)
        .add(vb.clone().multiplyScalar(Math.sin(t * omega) / s));
    } else {
      dir = va.clone().applyAxisAngle(axis, omega * t);
    }
    points.push(dir.multiplyScalar(base + peak * Math.sin(Math.PI * t)));
  }
  return new THREE.CatmullRomCurve3(points);
}

/** @param onLand called once per arc, when its travelling head reaches the
 *  destination: (lat, lon, className, country, color, bloomScale). Used for
 *  the impact ripples and the block flash. Fired from update(), not spawn(),
 *  so the ring appears when the arc arrives rather than when the event did.
 *
 *  `color` is the slot's LIVE shader uniform, not a copy -- the pool rewrites
 *  it when the slot is recycled, so a callback that keeps the reference will
 *  watch its ring change color under it. Copy it. This is what lets a ripple
 *  be drawn in its own arc's color, including the highlight classes, whose
 *  colors come from the collector and are not in any hardcoded table. */
export function createArcs(radius, capacity = 220, onLand = null) {
  // Built here, not at import: the highlight colors come from the
  // collector and main.js awaits that fetch before calling this.
  const CLASS = buildClasses();
  const group = new THREE.Group();
  const pool = [];
  // Both are `let`, not constants read at import: settings.js declares them as
  // live settings, so a patch has to be able to move them without a reload.
  let flowsPerSecond = FLOWS_PER_SECOND;
  let bodyOpacity = cfg('arcs.bodyOpacity', 0.18);

  for (let i = 0; i < capacity; i += 1) {
    const geom = new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)),
      SEGMENTS, 0.002, RADIAL, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        color: { value: new THREE.Color(0xffffff) },
        head: { value: 0.0 },     // pulse position along the arc, 0..1
        fade: { value: 0.0 },     // whole-arc opacity
        // Opacity of the tube behind the travelling head. A uniform rather than
        // a shader constant so it can be moved without recompiling 220
        // materials -- see arcs.setUniform.
        body: { value: bodyOpacity },
      },
      vertexShader: /* glsl */`
        varying float vT;
        void main() {
          vT = uv.x;             // TubeGeometry lays length along uv.x
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 color;
        uniform float head;
        uniform float fade;
        uniform float body;
        varying float vT;
        void main() {
          float trail = smoothstep(0.22, 0.0, head - vT) * step(vT, head);
          // The body term is deliberately low: these blend additively and
          // overlap heavily along the busiest corridor. See flowsPerSecond.
          gl_FragColor = vec4(color, (body + trail) * fade);
        }
      `,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.layers.enable(1);       // bloom layer; post.js owns the constant
    mesh.visible = false;
    group.add(mesh);
    pool.push({ mesh, mat, age: 0, life: 0, spec: null, born: 0, lat: 0, lon: 0,
                dlat: 0, dlon: 0, cls: 'flow', country: null, landed: false,
                active: false });
  }

  let cursor = 0;
  let windowStart = 0;
  let flowsThisSecond = 0;

  function take() {
    // Prefer a free slot; under flood, recycle the oldest active one.
    for (let i = 0; i < capacity; i += 1) {
      const slot = pool[(cursor + i) % capacity];
      if (!slot.active) {
        cursor = (cursor + i + 1) % capacity;
        return slot;
      }
    }
    let oldest = pool[0];
    for (const s of pool) if (s.age > oldest.age) oldest = s;
    return oldest;
  }

  /**
   * Draw an arc for this event.
   *
   * `cls` and `sups` are the caller's already-resolved answer for a SUPPRESSED
   * event. DNS is hidden unless a rule is aimed at the reason it was hidden,
   * and that rule -- not the first rule that merely matches -- is the one that
   * owns the color. Recomputing the class here with classNameFor would ask the
   * weaker question and hand the arc to whatever broad rule sits above:
   * with `[{match:'DE'}, {match:'udp/53'}]` a DNS flow to Germany was
   * authorized and counted as rule 2 and then drawn in rule 1's color.
   *
   * Both are omitted for ordinary traffic, which resolves its class here
   * exactly as it always has. `sups` is retained on the slot so setRules can
   * re-ask the same narrow question later -- see there.
   */
  function spawn(ev, cls, sups) {
    // The collector drops events it cannot geolocate, so a missing sll is
    // defensive only -- but a wall display must never throw in a frame loop.
    if (!ev || !ev.sll || !ev.dll) return;
    const className = cls || classNameFor(ev);
    const spec = CLASS[className] || CLASS.flow;

    // Rate-cap flows only. A dropped flow costs nothing -- the next one is
    // 20ms away -- but a dropped block would hide the thing the wall is for.
    if (spec !== CLASS.block) {
      const now = performance.now() / 1000;
      if (now - windowStart >= 1) { windowStart = now; flowsThisSecond = 0; }
      if (flowsThisSecond >= flowsPerSecond) return;
      flowsThisSecond += 1;
    }
    const a = latLonToVec3(ev.sll[0], ev.sll[1], radius * 1.005);
    const b = latLonToVec3(ev.dll[0], ev.dll[1], radius * 1.005);

    const slot = take();
    slot.mesh.geometry.dispose();
    slot.mesh.geometry = new THREE.TubeGeometry(
      arcCurve(a, b, radius, spec.lift, spec.maxRise), SEGMENTS, spec.tube, RADIAL, false);
    slot.mat.uniforms.color.value.copy(spec.color);
    slot.mesh.userData.bloomScale = spec.bloomScale !== undefined ? spec.bloomScale : 1;
    slot.mat.uniforms.head.value = 0;
    slot.mat.uniforms.fade.value = 0;
    slot.age = 0;
    slot.life = spec.life;
    slot.spec = spec;
    slot.lat = ev.sll[0];
    slot.lon = ev.sll[1];
    slot.dlat = ev.dll[0];
    slot.dlon = ev.dll[1];
    slot.cls = className;
    // Kept so a later setRules() can re-run the match against a new rule
    // list -- see the comment there. The pool is ~220 slots; the cost of
    // holding one extra object reference per slot is negligible.
    slot.ev = ev;
    // Empty for ordinary traffic. Non-empty means this arc exists only
    // because a rule overrode a suppression, which is a different question
    // from "which rule matches" and has to be re-asked as itself.
    slot.sups = sups && sups.length ? sups : null;
    // The country to flash: the FAR end, not the source. Every geo block on
    // this router is outbound, so `sc` is "--" and `sll` is home -- reading the
    // source meant flashCountry was called with "--" on every real block and
    // silently did nothing. Verified against the live feed 2026-08-09.
    slot.country = (foreignEnd(ev) || {}).country || null;
    slot.landed = false;
    slot.born = performance.now() / 1000;
    slot.active = true;
    slot.mesh.visible = true;
  }

  function update(dt) {
    // Block arcs are never dropped, so a burst -- opening WeChat fires a dozen
    // blocks to China on one corridor -- piles them up on the same path, and
    // additive blending sums them into a glare that a single arc never shows.
    // Dim the class by how many of it are live. See density.js for the curve;
    // `fade` feeds the fragment alpha, so the halo dims with the line and no
    // separate bloom handling is needed.
    let liveBlocks = 0;
    for (const slot of pool) {
      if (slot.active && slot.spec === CLASS.block) liveBlocks += 1;
    }
    const blockGain = densityGain(liveBlocks);

    for (const slot of pool) {
      if (!slot.active) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        continue;
      }
      const head = slot.age * slot.spec.speed;
      slot.mat.uniforms.head.value = head % 1.25;
      // The head reaches the far end at head = 1. Once per arc, never on a
      // recycled slot: `landed` is reset in spawn().
      if (!slot.landed && head >= 1) {
        slot.landed = true;
        if (onLand) {
          onLand(slot.dlat, slot.dlon, slot.cls, slot.country,
                 slot.mat.uniforms.color.value, slot.mesh.userData.bloomScale);
        }
      }
      // Fade in fast, hold, fade out over the last third.
      slot.mat.uniforms.fade.value =
        Math.min(1, t * 8) * (t > 0.66 ? 1 - (t - 0.66) / 0.34 : 1)
        * (slot.spec === CLASS.block ? blockGain : 1);
    }
  }

  function liveCount() {
    return pool.reduce((n, s) => n + (s.active ? 1 : 0), 0);
  }

  /** Arc origins for camera auto-orientation, newest weighted highest. */
  function origins() {
    const out = [];
    for (const s of pool) {
      if (!s.active) continue;
      out.push({ lat: s.lat, lon: s.lon, w: s.spec === CLASS.block ? 3 : 1, t: s.born });
    }
    return out;
  }

  /** A live setting that is not per-class. Writes the field or the uniform and
   *  nothing else; settings.js owns the bounds and apply.js the ordering. */
  function setUniform(key, value) {
    if (key === 'flowsPerSecond') { flowsPerSecond = value; return; }
    if (key === 'bodyOpacity') {
      bodyOpacity = value;
      for (const slot of pool) slot.mat.uniforms.body.value = value;
      return;
    }
    throw new Error(`arcs: no uniform ${key}`);
  }

  /**
   * One field of one arc class.
   *
   * The spec object is mutated IN PLACE rather than replaced, because
   * `slot.spec === CLASS.block` is how update() counts live blocks for the
   * density gain -- swapping in a fresh object would orphan every arc already
   * in the air and undercount them for the rest of their life.
   *
   * `highlight` is the shape shared by every color rule, so it writes through
   * to each live ruleN class; a rule's own color, gain and bloomScale come
   * from the rule list and move through setRules, not through here.
   *
   * Almost every field is COPIED OUT of the spec at spawn -- color into the
   * slot's uniform, bloomScale into userData, life into slot.life -- so writing
   * the spec alone changes nothing a viewer can see until the next arc of that
   * class happens to spawn. Block arcs live 18s and arrive rarely, so a block
   * recolor would read as a control that did nothing. The four that can be
   * pushed into the arcs already in the air are pushed here; `speed` needs
   * nothing, since update() reads it from the spec every frame; and
   * lift/maxRise/tube are baked into the TubeGeometry and cannot be pushed at
   * all, which is why apply.js clears the pool for those three instead.
   */
  function setSpec(cls, key, value) {
    const targets = cls === 'highlight'
      ? Object.keys(CLASS).filter((n) => n.startsWith('rule'))
      : [cls];
    for (const name of targets) {
      const spec = CLASS[name];
      if (!spec) continue;
      spec[key] = value;
      if (COLOR_KEYS.includes(key)) {
        spec.color = specColor({ ...spec, color: spec.hex });
      }
      for (const slot of pool) {
        // Identity, not name: a slot keeps the spec object it spawned with, and
        // setSpec mutates in place precisely so that comparison stays valid.
        if (!slot.active || slot.spec !== spec) continue;
        if (COLOR_KEYS.includes(key)) slot.mat.uniforms.color.value.copy(spec.color);
        else if (key === 'bloomScale') slot.mesh.userData.bloomScale = value;
        else if (key === 'life') slot.life = value;
      }
    }
  }

  /**
   * Install a new rule list.
   *
   * Every rule shares the same geometry, so nothing here needs the pool
   * cleared -- color, gain and bloomScale are pushed into the arcs ALREADY IN
   * THE AIR. That is the difference between a control that works and one that
   * appears to do nothing: a rule change that only affected arcs spawned later
   * would read as dead, exactly as the block recolor did before setSpec
   * learned to push (block arcs live 18s and arrive rarely).
   *
   * An arc whose rule was deleted falls back to the flow spec rather than
   * holding a reference to a class that no longer exists.
   *
   * Every arc still in the air is reclassified by RE-MATCHING its spawning
   * event against the list just compiled, not by re-looking-up its old
   * `slot.cls` name against the new CLASS table. `slot.cls` is a position
   * (`rule2` means "matched the second rule"), not an identity -- so on a
   * plain re-lookup, deleting rule 1 left every `rule2` arc pointing at a
   * CLASS entry that no longer existed (falling back to flow, even though
   * rule 2 still claims it) while every `rule1` arc silently inherited
   * whatever rule now occupies index 1 -- a color it never matched. The same
   * shift happened on any edit that drops a row, since `readyRules` renumbers
   * everything after it. Re-matching against the event fixes all three: a
   * surviving rule keeps its arcs, a deleted rule's arcs fall back to flow,
   * and an arc that was flow because nothing matched yet is promoted the
   * moment a new rule claims it -- which is also what makes the "pushed into
   * the arcs already in the air" promise true for arcs that were not
   * previously rule-colored at all, not just recolored.
   *
   * classify.classNameFor is NOT used here on purpose: it reads
   * CONFIG.arcs.rules, which is still the OLD list at the moment this handler
   * runs -- apply.js writes CONFIG only after every handler in a patch
   * returns. firstMatch is called directly against the list just compiled.
   */
  function setRules(list) {
    const compiled = compileRules(list);
    const shared = sharedShape();
    for (const name of Object.keys(CLASS)) {
      if (name.startsWith('rule')) delete CLASS[name];
    }
    compiled.rules.forEach((rule, i) => {
      const name = `rule${i + 1}`;
      CLASS[name] = classSpec(name, {
        ...shared,
        color: rule.color,
        gain: rule.gain === undefined ? shared.gain : rule.gain,
        bloomScale: rule.bloomScale === undefined ? shared.bloomScale : rule.bloomScale,
      });
    });
    for (const slot of pool) {
      // Blocks are never rule-colored, whatever they matched -- the wall
      // exists to show them, full stop. A slot with no stored event (should
      // not happen post-spawn, but a wall must never throw) keeps its
      // current class rather than being guessed at.
      if (!slot.active || slot.cls === 'block' || !slot.ev) continue;
      // An arc that is only on screen because a rule overrode its suppression
      // is re-matched with the SAME narrow question it was spawned under. Two
      // ways the plain firstMatch is wrong for it: a broad rule above the
      // overriding one would take the color (the spawn-path bug, arriving
      // through the other door), and deleting the overriding rule would leave
      // a DNS arc drawn as an ordinary flow -- authorized by nothing, which is
      // the state the suppression exists to prevent. No override left means it
      // should not be on the wall, so it is retired rather than recolored.
      if (slot.sups) {
        const oidx = firstOverride(compiled, slot.ev, slot.sups);
        if (oidx < 0) {
          slot.active = false;
          slot.mesh.visible = false;
          continue;
        }
        const ospec = CLASS[`rule${oidx + 1}`] || CLASS.flow;
        slot.cls = `rule${oidx + 1}`;
        slot.spec = ospec;
        slot.mat.uniforms.color.value.copy(ospec.color);
        slot.mesh.userData.bloomScale = ospec.bloomScale;
        continue;
      }
      const idx = firstMatch(compiled, slot.ev);
      const name = idx >= 0 ? `rule${idx + 1}` : 'flow';
      const spec = CLASS[name] || CLASS.flow;
      slot.cls = name;
      slot.spec = spec;
      slot.mat.uniforms.color.value.copy(spec.color);
      slot.mesh.userData.bloomScale = spec.bloomScale;
    }
    return { applied: compiled.rules.length, refused: compiled.refused };
  }

  /** Retire every arc in the air. The tube radius is baked into a slot's
   *  geometry at spawn, so a changed `tube` shows on the next arc and not on
   *  the ones already drawn -- which is what makes it a rebuild rather than a
   *  uniform. Clearing the pool is how it becomes visible within a frame. */
  function rebuild() {
    for (const slot of pool) {
      slot.active = false;
      slot.mesh.visible = false;
    }
  }

  /** Diagnostics only -- tools/verify_walk.py names the expected ripple color
   *  with this rather than re-deriving it. Nothing on the wall reads it. */
  function classColor(name) {
    return CLASS[name] && CLASS[name].color;
  }

  return {
    group, spawn, update, liveCount, origins, setUniform, setSpec, setRules, rebuild,
    classColor,
  };
}
