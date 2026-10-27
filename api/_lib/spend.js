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

// Anonymous per-day tally of searched product names (no visitor, address or email stored).
// Capped so random text cannot grow it without limit: past MAXN different names a day, new ones count under "(other)".
const MAXN = 3000;
async function trackProduct(name, found) {
  try {
    const f = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!f) return;
    const day = today();
    const k = 'prod:' + day;
    let field = f;
    if ((await store.hget(k, f)) == null && (await store.hlen(k)) >= MAXN) field = '(other)';
    const c = await store.hincrby(k, field, 1);
    if (c === 1) await store.expire(k, 31 * 86400);
    if (!found) {
      const kn = 'prodn:' + day;
      const c2 = await store.hincrby(kn, field, 1);
      if (c2 === 1) await store.expire(kn, 31 * 86400);
    }
  } catch (_) { /* never break a request */ }
}

// Anonymous per-day tally of where searches started (a page tag such as "home" or "blog-black-friday-..."), capped like the product tally.
// Anonymous per-page / per-traffic-source funnel tally. Only short tags are stored: no visitor, address or email.
async function trackFunnel(pg, tr, ev, afterLimit) {
  try {
    const d = today();
    const add = async (k, field, cap) => {
      let f = field;
      if ((await store.hget(k, f)) == null && (await store.hlen(k)) >= cap) f = '(other)|' + ev;
      const c = await store.hincrby(k, f, 1);
      if (c === 1) await store.expire(k, 40 * 86400);
    };
    await add('pgf:' + d, pg + '|' + ev, 700);
    await add('trf:' + d, tr + '|' + ev, 400);
    if (afterLimit) await add('alf:' + d, ev, 60);
  } catch (_) { /* never break a request */ }
}

async function trackSource(ref) {
  try {
    const f = String(ref || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'unknown';
    const k = 'srcs:' + today();
    let field = f;
    if ((await store.hget(k, f)) == null && (await store.hlen(k)) >= 300) field = '(other)';
    const c = await store.hincrby(k, field, 1);
    if (c === 1) await store.expire(k, 31 * 86400);
  } catch (_) { /* never break a request */ }
}

// How long checks that ran a live search took: count, total, slowest, and buckets (<10s, 10-20, 20-30, 30-45, 45+).
async function trackLatency(ms) {
  try {
    const k = 'lat:' + today();
    const sec = Math.max(0, ms) / 1000;
    const b = sec < 10 ? 'b0' : sec < 20 ? 'b1' : sec < 30 ? 'b2' : sec < 45 ? 'b3' : 'b4';
    const c = await store.hincrby(k, 'n', 1);
    await store.hincrby(k, 'sum', Math.round(ms));
    await store.hincrby(k, b, 1);
    const mx = Number(await store.hget(k, 'max')) || 0;
    if (ms > mx) await store.hset(k, 'max', String(Math.round(ms)));
    if (c === 1) await store.expire(k, 31 * 86400);
  } catch (_) { /* never break a request */ }
}

// Unique visitors per day, without storing the browser ID: only a one-way scramble of it, capped, deleted after about 31 days.
const { sha } = require('./util');
async function trackVisitor(kind, visitor) {
  try {
    if (!visitor) return;
    const k = kind + ':' + today();
    const f = sha('uv|' + visitor).slice(0, 16);
    if ((await store.hget(k, f)) != null) return;
    if ((await store.hlen(k)) >= 50000) return;
    await store.hset(k, f, '1');
    if ((await store.hlen(k)) === 1) await store.expire(k, 31 * 86400);
  } catch (_) { /* never break a request */ }
}

// Searches, and found / nothing results, per country.
async function trackCountry(country, kind) {
  try {
    const c = String(country || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    if (!c) return;
    const k = 'ctry:' + today();
    const n = await store.hincrby(k, c + ':' + kind, 1);
    if (n === 1) await store.expire(k, 31 * 86400);
  } catch (_) { /* never break a request */ }
}

module.exports = { isKilled, reserve, settle, spentToday, bump, trackProduct, trackSource, trackFunnel, trackLatency, trackVisitor, trackCountry };
