import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirm } from '../../netviz/static/js/confirm.js';

// Same minimal DOM fake as menu.test.mjs and rules_panel.test.mjs: createElement,
// append/remove, addEventListener/dispatch, querySelector by class. Never
// innerHTML, because the module under test never uses it either.
function fakeDom() {
  function mk(tag) {
    const listeners = {};
    const node = {
      tagName: tag, className: '', style: {}, textContent: '',
      children: [], parentNode: null, focused: false,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      append(...cs) { for (const c of cs) this.appendChild(c); },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      },
      focus() { this.focused = true; },
      querySelector(sel) {
        const cls = sel.replace(/^\./, '');
        const walk = (n) => {
          if (n.className && n.className.split(' ').includes(cls)) return n;
          for (const c of n.children || []) { const f = walk(c); if (f) return f; }
          return null;
        };
        for (const c of this.children) { const f = walk(c); if (f) return f; }
        return null;
      },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      dispatch(type, evt) { (listeners[type] || []).slice().forEach((fn) => fn(evt)); },
    };
    return node;
  }
  const root = mk('div');
  const docListeners = {};
  const document = {
    createElement: (tag) => mk(tag),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, evt) { (docListeners[type] || []).slice().forEach((fn) => fn(evt)); },
    listenerCount(type) { return (docListeners[type] || []).length; },
  };
  return { root, document };
}

function withFakeGlobals(dom, fn) {
  const real = globalThis.document;
  globalThis.document = dom.document;
  try { return fn(); } finally { globalThis.document = real; }
}

const OPTS = {
  title: 'Reset this display?',
  lead: 'Only this screen is affected.',
  will: ['Put the stats rail back to off.'],
  wont: ['Delete your color rules.'],
};

test('the dialog says what the action does AND what it does not', () => {
  // Both halves, because a warning that only lists consequences reads as
  // "something bad is happening" and gets clicked through.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    createConfirm({ root: dom.root }).ask(OPTS);
    const text = [];
    (function walk(n) {
      if (n.textContent) text.push(n.textContent);
      for (const c of n.children || []) walk(c);
    })(dom.root);
    const all = text.join(' ');
    assert.ok(all.includes('Put the stats rail back to off.'), 'no WILL line');
    assert.ok(all.includes('Delete your color rules.'), 'no WILL NOT line');
    assert.ok(all.includes('Reset this display?'), 'no title');
  });
});

test('yes runs the action and closes', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    let done = 0;
    const c = createConfirm({ root: dom.root });
    c.ask({ ...OPTS, onConfirm: () => { done += 1; } });
    dom.root.querySelector('.confirm-yes').dispatch('click', {});
    assert.equal(done, 1);
    assert.equal(c.isOpen(), false);
    assert.equal(dom.root.children.length, 0, 'the dialog stayed in the DOM');
  });
});

test('no runs nothing and closes', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    let done = 0;
    let cancelled = 0;
    const c = createConfirm({ root: dom.root });
    c.ask({ ...OPTS, onConfirm: () => { done += 1; }, onCancel: () => { cancelled += 1; } });
    dom.root.querySelector('.confirm-no').dispatch('click', {});
    assert.equal(done, 0, 'cancel performed the action');
    assert.equal(cancelled, 1);
    assert.equal(c.isOpen(), false);
  });
});

test('escape cancels, and never confirms', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    let done = 0;
    const c = createConfirm({ root: dom.root });
    c.ask({ ...OPTS, onConfirm: () => { done += 1; } });
    dom.document.dispatch('keydown', { key: 'Escape', stopPropagation() {} });
    assert.equal(done, 0);
    assert.equal(c.isOpen(), false);
  });
});

test('cancel holds the focus, not confirm', () => {
  // Enter or Space on a dialog somebody has not read yet must not perform the
  // action. This is the keyboard half of "a stray click cannot destroy
  // anything".
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    createConfirm({ root: dom.root }).ask(OPTS);
    assert.equal(dom.root.querySelector('.confirm-no').focused, true);
    assert.equal(dom.root.querySelector('.confirm-yes').focused, false);
  });
});

test('a click on the backdrop cancels; a click inside does not', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const c = createConfirm({ root: dom.root });
    c.ask(OPTS);
    let stopped = false;
    dom.root.querySelector('.confirm-box').dispatch('click',
      { stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'a click inside the box did not stop propagating');
    assert.equal(c.isOpen(), true, 'clicking the dialog itself closed it');
    dom.root.querySelector('.confirm').dispatch('click', {});
    assert.equal(c.isOpen(), false, 'clicking the backdrop did not cancel');
  });
});

test('with nothing to do it is an acknowledgement, not a question', () => {
  // The logic check: if the action would change nothing, a yes/no over it is a
  // question with no meaning, and "Yes" would teach that the button does
  // nothing. One button, and no way to fire onConfirm at all.
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    let done = 0;
    const c = createConfirm({ root: dom.root });
    c.ask({ ...OPTS, will: [], onConfirm: () => { done += 1; } });
    assert.equal(dom.root.querySelector('.confirm-yes'), null, 'a Yes button was drawn');
    assert.ok(dom.root.querySelector('.confirm-no'), 'no dismiss button');
    dom.root.querySelector('.confirm-no').dispatch('click', {});
    assert.equal(done, 0);
    assert.equal(c.isOpen(), false);
  });
});

test('asking twice while open does not stack two dialogs', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const c = createConfirm({ root: dom.root });
    c.ask(OPTS);
    c.ask(OPTS);
    assert.equal(dom.root.children.length, 1);
  });
});

test('closing removes the document listener it added', () => {
  const dom = fakeDom();
  withFakeGlobals(dom, () => {
    const c = createConfirm({ root: dom.root });
    c.ask(OPTS);
    assert.equal(dom.document.listenerCount('keydown'), 1);
    dom.root.querySelector('.confirm-no').dispatch('click', {});
    assert.equal(dom.document.listenerCount('keydown'), 0, 'listener leaked');
  });
});
