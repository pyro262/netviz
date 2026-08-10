import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooldown } from '../../netviz/static/js/cooldown.js';

test('the first landing at a target is always allowed', () => {
  const cd = createCooldown(120);
  assert.equal(cd.allow(30.3, -97.7, 'flow', 0), true);
});

test('a second landing at the same target inside the window is suppressed', () => {
  const cd = createCooldown(120);
  cd.allow(30.3, -97.7, 'flow', 0);
  assert.equal(cd.allow(30.3, -97.7, 'flow', 60), false);
  assert.equal(cd.allow(30.3, -97.7, 'flow', 119.9), false);
});

test('the window reopens exactly at the cooldown', () => {
  const cd = createCooldown(120);
  cd.allow(30.3, -97.7, 'flow', 0);
  assert.equal(cd.allow(30.3, -97.7, 'flow', 120), true);
});

test('a suppressed landing does not extend the window', () => {
  // Otherwise a busy target -- and home is every inbound arc's target -- would
  // never ripple again: each suppressed hit would push the deadline out.
  const cd = createCooldown(120);
  cd.allow(0, 0, 'flow', 0);
  for (let t = 1; t < 120; t += 1) cd.allow(0, 0, 'flow', t);
  assert.equal(cd.allow(0, 0, 'flow', 120), true);
});

test('nearby coordinates share one cell -- home jitters by a few km per event', () => {
  const cd = createCooldown(120);
  cd.allow(30.3, -97.7, 'flow', 0);
  assert.equal(cd.allow(30.4, -97.6, 'flow', 5), false);
});

test('genuinely different targets are independent', () => {
  const cd = createCooldown(120);
  cd.allow(30.3, -97.7, 'flow', 0);
  assert.equal(cd.allow(51.5, -0.13, 'flow', 5), true);
});

test('a block is not swallowed by a flow at the same target', () => {
  const cd = createCooldown(120);
  cd.allow(30.3, -97.7, 'flow', 0);
  assert.equal(cd.allow(30.3, -97.7, 'block', 5), true);
});

test('stale entries are pruned, so a long run does not grow without bound', () => {
  const cd = createCooldown(120);
  for (let i = 0; i < 500; i += 1) cd.allow(i % 90, i, 'flow', i);
  cd.allow(0, 0, 'flow', 100000);
  assert.ok(cd.size() < 50, `kept ${cd.size()} entries`);
});
