import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_ITEMS, PREVIEW_ITEMS, showPaths, createTestPanel }
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

test('every row is a declared schema path with a real explanation', () => {
  for (const item of [...SHOW_ITEMS, ...PREVIEW_ITEMS]) {
    const e = entry(item.path);
    assert.ok(e, item.path);
    assert.ok(item.label && item.label.length > 3, item.path);
    // ON the panel, not in a tooltip: a wall display is never hovered.
    assert.ok(e.help.length > 40,
      `${item.path} needs an explanation on the panel, not in a title`);
  }
  assert.equal(showPaths().length, SHOW_ITEMS.length);
});

test('the aurora row carries a strength slider, and it is a schema path too', () => {
  const aurora = SHOW_ITEMS.find((i) => i.path === 'test.show.aurora');
  assert.ok(aurora.param, 'no strength control on the one row that needs one');
  const e = entry(aurora.param);
  assert.equal(e.type, 'number');
  assert.equal(e.min, 0);
  assert.equal(e.max, 9, 'Kp is a 0-9 scale and the control must say so');
});

test('Show is dead until something is ticked', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    const panel = createTestPanel({ settings: configApplier(), root: dom.root });
    panel.open();
    assert.equal(dom.root.querySelector('.test-show').disabled, true,
      'a Show with nothing ticked is a button that does nothing');
    const box = dom.root.querySelectorAll('.test-check')[0];
    box.checked = true;
    box.dispatch('change', {});
    assert.equal(dom.root.querySelector('.test-show').disabled, false);
    panel.close();
  }));
});

test('Stop is dead until a showing is running', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    let running = false;
    const panel = createTestPanel({
      settings: configApplier(), root: dom.root,
      showcase: { isRunning: () => running, start: () => { running = true; return { started: true, items: ['aurora'], skipped: [] }; }, stop: () => { running = false; return true; } },
    });
    panel.open();
    assert.equal(dom.root.querySelector('.test-stop').disabled, true);
    CONFIG.test.show.aurora = true;
    panel.sync();
    dom.root.querySelector('.test-show').dispatch('click', {});
    assert.equal(dom.root.querySelector('.test-stop').disabled, false);
    dom.root.querySelector('.test-stop').dispatch('click', {});
    assert.equal(dom.root.querySelector('.test-stop').disabled, true);
    panel.close();
  }));
});

test('the report lists what went on screen AND what could not', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    CONFIG.test.show.aurora = true;
    CONFIG.test.show.customArcs = true;
    const panel = createTestPanel({
      settings: configApplier(), root: dom.root,
      showcase: {
        isRunning: () => true,
        start: () => ({ started: true, items: ['aurora'],
                        skipped: [{ id: 'customArcs', why: 'no custom arcs are defined on this display' }] }),
        stop: () => true,
      },
    });
    panel.open();
    dom.root.querySelector('.test-show').dispatch('click', {});
    const rows = dom.root.querySelectorAll('.test-report-row');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].className.includes('on'));
    assert.ok(rows[1].className.includes('skip'),
      'an item that could not run must not read as one that did');
    // The reason is on screen, not swallowed.
    const why = rows[1].querySelector('.test-report-why').textContent;
    assert.match(why, /no custom arcs/);
    panel.close();
  }));
});

test('the note says a showing survives closing the panel', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    CONFIG.test.show.aurora = true;
    const panel = createTestPanel({
      settings: configApplier(), root: dom.root,
      showcase: { isRunning: () => true,
                  start: () => ({ started: true, items: ['aurora'], skipped: [] }),
                  stop: () => true },
    });
    panel.open();
    dom.root.querySelector('.test-show').dispatch('click', {});
    const note = dom.root.querySelector('.test-note').textContent;
    assert.match(note, /keeps going|watch/i,
      'the one thing a person has to be told: closing this does not stop it');
    panel.close();
  }));
});

test('the hover previews are a separate block, not more of the same list', async () => {
  const dom = fakeDom();
  await withCleanTest(() => withDom(dom, async () => {
    const panel = createTestPanel({ settings: configApplier(), root: dom.root });
    panel.open();
    const sec = dom.root.querySelector('.test-preview-cat');
    assert.ok(sec, 'the previews were folded back into the main list');
    assert.equal(sec.querySelectorAll('.test-check').length, PREVIEW_ITEMS.length);
    // And they are NOT part of what Show acts on.
    assert.ok(!showPaths().some((p) => p.startsWith('test.preview.')));
    panel.close();
  }));
});

test('there is no self-test left to import', async () => {
  await assert.rejects(() => import('../../netviz/static/js/selftest.js'));
});
