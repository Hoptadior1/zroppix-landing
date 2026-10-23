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
async function addItem(sub, { name, variant, country, base }, now) {
  const c = cfg();
  const key = itemKey({ name, variant }, country);
  sub.items = sub.items || [];
  const existing = sub.items.find((it) => it.key === key && active(it, now));
  if (existing) return { ok: true, already: true, item: existing };
  if (activeItems(sub, now).length >= limitFor(sub)) return { error: 'limit' };
  const days = sub.plan === 'pro' ? c.watchDaysPro : c.watchDaysFree;
  const item = { id: crypto.randomBytes(5).toString('hex'), key, name, variant, country, created: now, expires: now + days * DAY, base: base || null, last: null };
  sub.items = sub.items.filter((it) => it.key !== key || active(it, now)).concat(item).slice(-60);
  return { ok: true, item };
}

// Decide whether today's result deserves an email for this item. Pro users hear about real improvements, free users about the first find.
function shouldNotify(item, best, extras, plan, now) {
  const c = cfg();
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

module.exports = { subId, itemKey, sig, sigOk, stopLink, unsubLink, link, getSub, saveSub, active, activeItems, limitFor, baselineFor, addItem, shouldNotify, DAY };
