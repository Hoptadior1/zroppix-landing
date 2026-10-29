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

// Monday (UTC) of the week a date falls in, as YYYY-MM-DD.
function weekStart(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
function nextWeekStart(d) { const x = new Date(weekStart(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 7); return x.toISOString().slice(0, 10); }

// Free-check allowance per visitor id: base + email bonus, then a small weekly refill that starts the week AFTER the base checks run out.
async function allowance(visitor) {
  const c = cfg();
  const bonus = Number(await store.get('bonus:' + visitor)) || 0;
  const used = Number(await store.get('used:' + visitor)) || 0;
  const total = c.freeChecks + bonus;
  const baseLeft = Math.max(0, total - used);
  const now = new Date(), wk = weekStart(now);
  let weeklyLeft = 0, nextFree = null;
  if (baseLeft === 0 && c.weeklyRefill > 0) {
    const exh = await store.get('exh:' + visitor);
    if (exh && exh < wk) {
      const wu = Number(await store.get('wk:' + visitor + ':' + wk)) || 0;
      weeklyLeft = Math.max(0, c.weeklyRefill - wu);
    }
    if (!weeklyLeft) nextFree = nextWeekStart(now);
  }
  return { total, used, left: baseLeft + weeklyLeft, bonus, weeklyLeft, nextFree };
}

// Take one check. Race-safe: increment first, undo if over.
async function consume(visitor) {
  const a = await allowance(visitor);
  if (a.used >= a.total && a.weeklyLeft > 0) {
    const key = 'wk:' + visitor + ':' + weekStart(new Date());
    const n = await store.incrBy(key, 1);
    if (n === 1) await store.expire(key, 14 * 86400);
    if (n > cfg().weeklyRefill) { await store.incrBy(key, -1); return false; }
    return true;
  }
  const n = await store.incrBy('used:' + visitor, 1);
  if (n === 1) await store.expire('used:' + visitor, 120 * 86400);
  if (n > a.total) { await store.incrBy('used:' + visitor, -1); return false; }
  if (n === a.total) await store.set('exh:' + visitor, weekStart(new Date()), 120 * 86400);
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

module.exports = { within, allowance, consume, addBonus, refund, nextWeekStart };
