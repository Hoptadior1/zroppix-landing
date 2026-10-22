'use strict';
// Daily spend cap with reservations (safe under concurrent requests) and a kill switch.
const store = require('./store');
const { cfg } = require('./config');
const { today } = require('./util');

const TTL = 3 * 86400;

async function isKilled() {
  if (cfg().killEnv) return true;
  try { return (await store.get('find:kill')) === '1'; } catch (_) { return true; } // fail closed
}

// Reserve the worst-case cost BEFORE spending. Returns a ticket, or null if the day's cap would be exceeded.
async function reserve(usd) {
  const key = 'spend:' + today();
  const micro = Math.max(1, Math.round(usd * 1e6));
  const total = await store.incrBy(key, micro);
  if (total === micro) await store.expire(key, TTL);
  if (total > Math.round(cfg().dailyCapUsd * 1e6)) {
    await store.incrBy(key, -micro);
    return null;
  }
  return { key, micro };
}

// Replace the reservation with the real cost.
async function settle(ticket, actualUsd) {
  if (!ticket) return;
  const actual = Math.max(0, Math.round((actualUsd || 0) * 1e6));
  const delta = actual - ticket.micro;
  if (delta !== 0) await store.incrBy(ticket.key, delta);
}

async function spentToday() {
  const v = await store.get('spend:' + today());
  return (Number(v) || 0) / 1e6;
}

// Daily counters for the owner's stats page.
async function bump(name, n) {
  const k = 'stat:' + today();
  try {
    const c = await store.hincrby(k, name, n == null ? 1 : n);
    if (c === (n == null ? 1 : n)) await store.expire(k, 40 * 86400);
  } catch (_) { /* stats must never break a request */ }
}

module.exports = { isKilled, reserve, settle, spentToday, bump };
