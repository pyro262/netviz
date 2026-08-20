// A modal yes/no, for the few actions that cannot be undone by clicking again.
//
// Imports NOTHING -- no three, no config, no storage. It is handed its words and
// its callbacks, which is what lets the wording be decided (and tested) by the
// caller that knows what is about to happen, and what lets this file be proved
// under `node --test` against the same DOM fake menu.test.mjs uses.
//
// Two rules this dialog exists to keep:
//
//  - It says what the action does AND what it does not do. A warning that only
//    lists consequences reads as "something bad is about to happen" and teaches
//    people to click through it; the half that says what is safe is what makes
//    the other half worth reading.
//  - Cancel is the default. It is focused, it is what Escape does, and it is
//    what clicking outside does. The whole point is that a stray click on the
//    menu row underneath cannot destroy anything, so the safe answer has to be
//    the one a stray second click lands on.

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * openConfirm({ root, title, lead, will, wont, note, confirmLabel, cancelLabel,
 *               onConfirm, onCancel })
 *
 * `will` and `wont` are arrays of plain sentences -- what the action changes and
 * what it leaves alone. Either may be empty, and when `will` is empty the dialog
 * becomes an acknowledgement with a single button: there is nothing to confirm,
 * so offering a yes/no over an action that would do nothing is a question with
 * no meaning. That case is why the caller passes a computed list rather than a
 * fixed one.
 *
 * Returns { close } and mounts immediately. Only one at a time: a second call
 * while one is open is ignored, so a double-click on the opener cannot stack two
 * dialogs whose buttons then disagree about which is on top.
 */
export function createConfirm({ root } = {}) {
  const mount = root || document.body;
  let node = null;
  let cancelFn = null;

  function isOpen() { return node !== null; }

  function close() {
    if (!node) return;
    document.removeEventListener('keydown', onKeyDown, true);
    node.remove();
    node = null;
    cancelFn = null;
  }

  function onKeyDown(e) {
    if (!node) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      const fn = cancelFn;
      close();
      if (fn) fn();
    }
  }

  function ask(opts = {}) {
    // Already asking. Ignoring is right rather than replacing: the second call
    // is a double-click on the opener, not a new question.
    if (node) return { close };
    const will = opts.will || [];
    const wont = opts.wont || [];
    const nothingToDo = will.length === 0;
    cancelFn = opts.onCancel || null;

    node = el('div', 'confirm');
    const box = el('div', 'confirm-box');
    box.append(el('div', 'confirm-title', opts.title || 'Are you sure?'));
    if (opts.lead) box.append(el('div', 'confirm-lead', opts.lead));

    if (will.length) {
      const group = el('div', 'confirm-group');
      group.append(el('div', 'confirm-group-head', 'This WILL:'));
      const list = el('ul', 'confirm-list');
      for (const line of will) list.append(el('li', 'confirm-will', line));
      group.append(list);
      box.append(group);
    }
    if (wont.length) {
      const group = el('div', 'confirm-group');
      group.append(el('div', 'confirm-group-head', 'This will NOT:'));
      const list = el('ul', 'confirm-list');
      for (const line of wont) list.append(el('li', 'confirm-wont', line));
      group.append(list);
      box.append(group);
    }
    if (opts.note) box.append(el('div', 'confirm-note', opts.note));

    const foot = el('div', 'confirm-foot');
    if (!nothingToDo) {
      const yes = el('button', 'confirm-yes', opts.confirmLabel || 'Yes, proceed');
      yes.addEventListener('click', () => {
        const fn = opts.onConfirm;
        close();
        if (fn) fn();
      });
      foot.append(yes);
      // The third answer, for the one question that has three: a Close over
      // pending work can keep them, discard them, or not close at all. It is
      // rendered BETWEEN yes and cancel so the destructive answer is never the
      // one adjacent to the safe default -- and it is inside `nothingToDo`'s
      // guard because a dialog over an action with no effect must not gain a
      // second meaningless answer.
      if (opts.altLabel) {
        const alt = el('button', 'confirm-alt', opts.altLabel);
        alt.addEventListener('click', () => {
          const fn = opts.onAlt;
          close();
          if (fn) fn();
        });
        foot.append(alt);
      }
    }
    const no = el('button', 'confirm-no',
                  nothingToDo ? (opts.dismissLabel || 'Close')
                              : (opts.cancelLabel || 'No, cancel'));
    no.addEventListener('click', () => {
      const fn = cancelFn;
      close();
      if (fn) fn();
    });
    foot.append(no);
    box.append(foot);
    node.append(box);

    // The backdrop cancels; the box swallows its own clicks so a click INSIDE
    // the dialog -- on a word, on padding -- is not read as dismissing it.
    node.addEventListener('click', () => {
      const fn = cancelFn;
      close();
      if (fn) fn();
    });
    box.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); });

    mount.appendChild(node);
    document.addEventListener('keydown', onKeyDown, true);
    // Cancel takes focus, not confirm: Enter and Space on a freshly opened
    // dialog must not be a way to perform the action without reading it.
    if (no.focus) no.focus();
    return { close };
  }

  return { ask, close, isOpen };
}
