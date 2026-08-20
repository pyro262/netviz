import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CATEGORIES, testPaths, createTestPanel }
  from '../../netviz/static/js/test_panel.js';
import { entry } from '../../netviz/static/js/settings.js';
import { CONFIG } from '../../netviz/static/js/config.js';

// Minimal DOM fake, same discipline as the other panels': createElement,
// append/remove, addEventListener/dispatch, class-and-attribute
// querySelector, never innerHTML.
function matches(node, sel) {
  const m = /^\.([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
  if (!m) throw new Error(`fake DOM cannot parse selector ${sel}`);
  const [, cls, attr, val] = m;
  if (!node.className || !node.className.split(' ').includes(cls)) return false;
  if (attr && node.getAttribute(attr) !== val) return false;
  return true;
}

function fakeDom() {
  function mk(tag) {
    const listeners = {};
    const attrs = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '', value: '',
      checked: false, disabled: false, children: [], parentNode: null,
      setAttribute(n, v) { attrs[n] = String(v); },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      append(...cs) { for (const c of cs) this.appendChild(c); },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      },
      replaceChildren(...cs) {
        for (const c of this.children.slice()) c.parentNode = null;
        this.children = [];
        for (const c of cs) this.appendChild(c);
      },
      querySelectorAll(sel) {
        const out = [];
        (function walk(n) {
          for (const c of n.children || []) { if (matches(c, sel)) out.push(c); walk(c); }
        })(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
      removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn); },
      dispatch(t, e) { (listeners[t] || []).slice().forEach((fn) => fn(e)); },
    };
    return node;
  }
  const root = mk('div');
  const document = {
    createElement: (t) => mk(t),
    addEventListener() {}, removeEventListener() {},
  };
  return { root, document };
}

/** AWAIT-AWARE, because `run()` is async: a synchronous `finally` puts the real
 *  `document` back before the runner's promise resolves, and the panel's own
 *  showReport then calls createElement on `undefined`. */
async function withDom(dom, fn) {
  const real = globalThis.document;
  globalThis.document = dom.document;
  try { return await fn(); } finally { globalThis.document = real; }
}

/** Writes land in CONFIG, so `cfg()` reads them back the way the real
 *  persisting applier makes it. Restored by withCleanTest below. */
function configApplier(into) {
  return {
    apply: (patch) => {
      if (into) into.push(patch);
      for (const [path, v] of Object.entries(patch)) {
        const parts = path.split('.');
        let o = CONFIG;
        for (const k of parts.slice(0, -1)) o = o[k];
        o[parts[parts.length - 1]] = v;
      }
      return { applied: Object.keys(patch), rejected: [] };
    },
  };
}

async function withCleanTest(fn) {
  const saved = JSON.parse(JSON.stringify(CONFIG.test));
  try { return await fn(); } finally { Object.assign(CONFIG.test, saved); }
}

const click = (dom, sel) => dom.root.querySelector(sel).dispatch('click', {});

test('five categories, every option a declared schema path', () => {
  assert.equal(TEST_CATEGORIES.length, 5);
  for (const cat of TEST_CATEGORIES) {
    assert.ok(cat.options.length >= 1, cat.id);
    for (const opt of cat.options) assert.ok(entry(opt.path), opt.path);
  }
  assert.equal(testPaths().length, 15);
});

test('a single-option category offers no "enable all"', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, () => {
    const panel = createTestPanel({ settings: configApplier(), root: dom.root });
    panel.open();
    for (const cat of TEST_CATEGORIES) {
      const btn = dom.root.querySelector(`.test-all[data-cat="${cat.id}"]`);
      if (cat.options.length === 1) {
        assert.equal(btn, null, `${cat.id}: enabling one thing is an empty question`);
      } else {
        assert.ok(btn, cat.id);
      }
    }
    panel.close();
  }));
});

test('every option says in words what it does -- no bare checkbox', () => {
  for (const cat of TEST_CATEGORIES) {
    assert.ok(cat.lead && cat.lead.length > 20, `${cat.id} has no lead sentence`);
    for (const opt of cat.options) {
      assert.ok(opt.label && opt.label.length > 3, opt.path);
      assert.ok(entry(opt.path).help.length > 40,
        `${opt.path} needs an explanation on the panel, not in a tooltip`);
    }
  }
});

test('"enable all" ticks only its own category', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, () => {
    const applied = [];
    const panel = createTestPanel({ settings: configApplier(applied), root: dom.root });
    panel.open();
    applied.length = 0;
    click(dom, '.test-all[data-cat="feeds"]');
    const touched = applied.flatMap((p) => Object.keys(p));
    assert.equal(touched.length, 4);
    assert.ok(touched.every((p) => p.startsWith('test.feeds.')), touched.join(', '));
    panel.close();
  }));
});

test('Run calls the runner with exactly the ticked paths', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, () => {
    const runs = [];
    CONFIG.test.geo.home = true;
    const panel = createTestPanel({
      settings: configApplier(), runner: (paths) => { runs.push(paths); return []; },
      root: dom.root,
    });
    panel.open();
    click(dom, '.test-run');
    assert.deepEqual(runs, [['test.geo.home']]);
    panel.close();
  }));
});

test('Run with nothing ticked does not call the runner', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, () => {
    const runs = [];
    const panel = createTestPanel({
      settings: configApplier(), runner: (p) => { runs.push(p); return []; },
      root: dom.root,
    });
    panel.open();
    click(dom, '.test-run');
    assert.deepEqual(runs, [], 'a run of nothing is a run that always passes');
    assert.match(dom.root.querySelector('.test-note').textContent, /nothing/i);
    panel.close();
  }));
});

test('the report draws one row per check, marked pass, fail or skipped', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    CONFIG.test.geo.home = true;
    const panel = createTestPanel({
      settings: configApplier(), root: dom.root,
      // THE REAL SHAPE selftest.js returns -- `{id, status, reason}`, async.
      // A stub with an `ok` flag and a synchronous return is what let two bugs
      // through: run() did not await, so showReport got a Promise and drew
      // nothing, and the failure count read `!l.ok` and called every pass a
      // failure. verify_test_mode.py's case 5 found both.
      runner: async () => [
        { id: 'test.geo.home', status: 'pass', reason: 'home projects' },
        { id: 'test.geo.landmarks', status: 'fail', reason: 'Sydney is 180 deg out' },
        { id: 'test.feeds.netflow', status: 'skipped', reason: 'collector unreachable' },
      ],
    });
    panel.open();
    click(dom, '.test-run');
    await new Promise((r) => { setTimeout(r, 0); });   // let the runner resolve
    const rows = dom.root.querySelectorAll('.test-report-row');
    assert.equal(rows.length, 3);
    assert.ok(rows[0].className.includes('pass'));
    assert.ok(rows[1].className.includes('fail'));
    assert.ok(rows[2].className.includes('skip'),
      'a check that could not run is neither a pass nor a failure');
    const note = dom.root.querySelector('.test-note').textContent;
    assert.match(note, /1 of 3/);
    assert.match(note, /1 could not run/);
    panel.close();
  }));
});

test('Enable everything ticks all fifteen', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, () => {
    const applied = [];
    const panel = createTestPanel({ settings: configApplier(applied), root: dom.root });
    panel.open();
    applied.length = 0;
    click(dom, '.test-enable-all');
    assert.equal(applied.flatMap((p) => Object.keys(p)).length, 15);
    panel.close();
  }));
});
