'use strict';
const store = require('./store');
const { cfg } = require('./config');
const { today, hourKey } = require('./util');

// Fixed-window counter. Returns true if the caller is still within `max`.
async function within(scope, id, max, per) {
  const win = per === 'hour' ? hourKey() : today();
  const key = `rl:${scope}:${id}:${win}`;
  const n = await store.incrBy(key, 1);
  if (n === 1) await store.expire(key, per === 'hour' ? 7200 : 172800);
  return n <= max;
}

// Free-check allowance per visitor id: base + email bonus.
async function allowance(visitor) {
  const bonus = Number(await store.get('bonus:' + visitor)) || 0;
  const used = Number(await store.get('used:' + visitor)) || 0;
  const total = cfg().freeChecks + bonus;
  return { total, used, left: Math.max(0, total - used), bonus };
}

// Take one check. Race-safe: increment first, undo if over.
async function consume(visitor) {
  const a = await allowance(visitor);
  const n = await store.incrBy('used:' + visitor, 1);
  if (n === 1) await store.expire('used:' + visitor, 120 * 86400);
  if (n > a.total) { await store.incrBy('used:' + visitor, -1); return false; }
  return true;
}

async function addBonus(visitor, n) {
  const v = await store.incrBy('bonus:' + visitor, n);
  await store.expire('bonus:' + visitor, 120 * 86400);
  return v;
}

// Give back one use of a window counter (used when a check failed for our own reasons, so the visitor is not punished).
async function refund(scope, id, per) {
  try {
    const win = per === 'hour' ? hourKey() : today();
    const key = `rl:${scope}:${id}:${win}`;
    const n = await store.incrBy(key, -1);
    if (n < 0) await store.incrBy(key, -n);
  } catch (_) { /* ignore */ }
}

module.exports = { within, allowance, consume, addBonus, refund };
