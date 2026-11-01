'use strict';
// Price watches ("tell me when it's found"). Data lives in the same store as everything else:
//   wsub:<id>   one record per email address: {email, plan, marketing, items:[...]}   (id = first 32 hex of sha256(email))
//   wsubs       index of all ids (hash)
//   wpend:<tok> a watch waiting for the shopper to confirm by email (7 days)
// Links in emails carry an HMAC signature, so nobody can stop or list someone else's watches by guessing.
const crypto = require('crypto');
const { cfg } = require('./config');
const store = require('./store');
const { sha, clean, normName } = require('./util');
const R = require('./rules');
const RS = require('./research');

const DAY = 86400000;
const subId = (email) => sha(String(email).toLowerCase()).slice(0, 32);
const itemKey = (product, country) => RS.cacheKeyFor(product, country).slice(3, 27); // short stable id for "this product in this country"

function sig(...parts) {
  const secret = cfg().salt;
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(parts.join('|')).digest('hex').slice(0, 32);
}
function sigOk(given, ...parts) {
  const want = sig(...parts);
  if (!want || typeof given !== 'string' || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}
const link = (params) => cfg().siteUrl + '/api/watch?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const stopLink = (id, itemId) => link({ a: 'stop', w: id, i: itemId, s: sig('stop', id, itemId) });
const unsubLink = (id) => link({ a: 'unsub', w: id, s: sig('unsub', id) });

async function getSub(id) { return store.getJson('wsub:' + id); }
async function saveSub(id, sub) {
  await store.setJson('wsub:' + id, sub, 400 * 86400);
  await store.hset('wsubs', id, '1');
}

// An item counts while it has not expired, was not stopped and (for free users) has not already delivered its one alert.
const active = (it, now) => it && !it.stopped && !it.done && !it.paused && (!it.expires || it.expires > (now || Date.now()));
const activeItems = (sub, now) => (sub && !sub.unsubscribed ? sub.items || [] : []).filter((it) => active(it, now));
const limitFor = (sub) => (sub.plan === 'pro' ? cfg().watchProItems : cfg().watchFreeItems);

// What the best offer looked like when the watch was set up, from our cache only (never a new search).
async function baselineFor(product, country) {
  try {
    const ev = await store.getJson(RS.cacheKeyFor(product, country));
    if (!ev || !RS.hasOffers(ev)) return null;
    const b = R.pickBest(ev.accepted);
    return b && b.price > 0 ? { price: b.price, store: b.store, currency: b.currency } : null;
  } catch (_) { return null; }
}

// Add an item to a subscriber record. Returns {ok} or {error}.
async function addItem(sub, { name, variant, country, base, target }, now) {
  const c = cfg();
  const key = itemKey({ name, variant }, country);
  sub.items = sub.items || [];
  const existing = sub.items.find((it) => it.key === key && active(it, now));
  if (existing) { if (target) existing.target = target; return { ok: true, already: true, item: existing }; }
  if (activeItems(sub, now).length >= limitFor(sub)) return { error: 'limit' };
  const days = sub.plan === 'pro' ? c.watchDaysPro : c.watchDaysFree;
  const item = { id: crypto.randomBytes(5).toString('hex'), key, name, variant, country, created: now, expires: now + days * DAY, base: base || null, last: null, target: target || null, checks: 0, lastCheck: null, lastRun: null };
  sub.items = sub.items.filter((it) => it.key !== key || active(it, now)).concat(item).slice(-60);
  return { ok: true, item };
}

// Decide whether today's result deserves an email for this item. Pro users hear about real improvements, free users about the first find.
function shouldNotify(item, best, extras, plan, now) {
  const c = cfg();
  if (item.target) { // a watch with a target price only speaks when a dated store price reaches it
    if (!best || best.kind !== 'price' || !(best.price > 0) || !best.sourceUrl) return false;
    if (best.currency !== item.target.currency || best.price > item.target.price) return false;
    if (!item.last) return true;
    if (plan !== 'pro') return false;
    if (now - item.last.ts < c.watchMinGapDays * DAY) return false;
    return best.price <= item.last.price * 0.97;
  }
  if (!best || !(best.price > 0) || !best.sourceUrl) return false;
  const codes = (extras || []).filter((x) => x.code).map((x) => x.code);
  if (!item.last) {
    if (item.base && item.base.price && !(best.price < item.base.price * 0.98)) return false; // watching a product that already had an offer: only a better one counts
    return true;
  }
  if (plan !== 'pro') return false;
  if (now - item.last.ts < c.watchMinGapDays * DAY) return false;
  const lower = best.price <= item.last.price * 0.97;
  const newCode = codes.some((x) => !(item.last.codes || []).includes(x));
  return lower || newCode;
}

// A target price is a number the shopper chose. It must be a sensible amount, and in the currency the offers are read in.
const MAX_TARGET = 100000;
function parseTarget(raw, base) {
  if (raw == null || raw === '') return null;
  const t = typeof raw === 'object' ? raw : { price: raw };
  const s = String(t.price == null ? '' : t.price).trim();
  if (!/^[^\d-]{0,3}\d[\d,]*(\.\d+)?\s*$/.test(s)) return { error: 'bad_target' }; // digits only, with at most a currency sign in front: no minus, no letters
  const n = Number(s.replace(/[^0-9.]/g, ''));
  const price = Math.round(n * 100) / 100;
  if (!(price >= 1 && price <= MAX_TARGET)) return { error: 'bad_target' };
  const cur = String(t.currency || (base && base.currency) || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur) || (base && base.currency && base.currency !== cur)) return { error: 'bad_currency' };
  return { price, currency: cur };
}
// What one daily check saw, kept on the watch so the shopper can see real evidence. Only counts we really have.
function recordCheck(item, ev, now) {
  item.checks = (item.checks || 0) + 1;
  item.lastCheck = now;
  const acc = (ev && ev.accepted) || []; const rej = (ev && ev.rejected) || [];
  item.lastRun = { found: acc.length + rej.length, passed: acc.length, rejected: rej.length };
}
// Vercel Cron runs /api/watchrun at 05:00 UTC every day (see vercel.json). Only watches that are active have a next check.
const nextRun = (now) => { const d = new Date(now); d.setUTCHours(5, 0, 0, 0); if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };
const view = (it, now) => ({ id: it.id, name: it.name, variant: it.variant, created: it.created, expires: it.expires, checks: it.checks || 0, lastCheck: it.lastCheck || null, lastRun: it.lastRun || null, target: it.target || null, last: it.last ? { price: it.last.price, store: it.last.store, ts: it.last.ts } : null, next: nextRun(now) });

module.exports = { parseTarget, recordCheck, nextRun, view, subId, itemKey, sig, sigOk, stopLink, unsubLink, link, getSub, saveSub, active, activeItems, limitFor, baselineFor, addItem, shouldNotify, DAY };
