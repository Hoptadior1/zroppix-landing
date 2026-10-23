'use strict';
// GET|POST /api/watchrun   Vercel Cron calls this once a day (it sends "Authorization: Bearer <CRON_SECRET>").
// The owner can also call it with the admin token. It rechecks every watched product (each product once, however many people watch it),
// then emails the people whose product has a real, dated offer. One product is searched per invocation (a search takes most of the
// 60 seconds a function may run), and the function then calls itself to carry on until the queue is empty.
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, sha, today } = require('./_lib/util');
const { isKilled, bump } = require('./_lib/spend');
const { sendEmail, watchAlertEmail } = require('./_lib/email');
const PRO = require('./_lib/pro');
const R = require('./_lib/rules');
const RS = require('./_lib/research');
const W = require('./_lib/watch');

const eq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
function authorised(req) {
  const c = cfg();
  const got = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  return (c.cronSecret && eq(got, c.cronSecret)) || (c.adminToken && eq(got, c.adminToken));
}

// Build today's list: every product somebody actively watches, once, skipping any checked in the last 20 hours.
async function buildQueue() {
  const c = cfg(); const now = Date.now();
  const ids = Object.keys(pairs(await store.hgetall('wsubs'))).slice(0, 2000);
  const groups = new Map();
  for (const id of ids) {
    const sub = await W.getSub(id);
    if (!sub || sub.unsubscribed) continue;
    if (sub.plan === 'pro') { // a lapsed plan keeps only its first watch
      const p = await PRO.lookupPlan(sub.email).catch(() => ({ ok: false }));
      if (p.ok && !p.pro) {
        sub.plan = 'free'; let kept = 0;
        sub.items = (sub.items || []).map((it) => (W.active(it, now) && ++kept > c.watchFreeItems ? Object.assign({}, it, { paused: true }) : it));
        await W.saveSub(id, sub);
      }
    }
    for (const it of W.activeItems(sub, now)) {
      if (!groups.has(it.key)) groups.set(it.key, { key: it.key, product: { name: it.name, variant: it.variant }, country: it.country, subs: [] });
      groups.get(it.key).subs.push({ id, item: it.id });
    }
  }
  await store.del('wq');
  let n = 0;
  for (const g of groups.values()) {
    if (n >= c.watchMaxProducts) break;
    if (await store.get('wlast:' + g.key)) continue;
    await store.setJson('wprod:' + g.key, g, 2 * 86400);
    await store.lpush('wq', g.key); n++;
  }
  return n;
}
function pairs(arr) { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; }

async function processProduct(key, state) {
  const c = cfg();
  const g = await store.getJson('wprod:' + key);
  if (!g) return;
  const spent = Number(await store.get('wspend:' + today())) || 0;
  if (spent >= Math.round(c.watchCapUsd * 1e6)) { state.capped = true; return; }
  const now = new Date();
  let ev = await store.getJson(RS.cacheKeyFor(g.product, g.country));
  if (!ev || state.fresh) {
    // Alternate the search wording day by day, so a product missed one day gets a different search the next.
    const pass = (Math.floor(Date.now() / 86400000) % 2) + 1;
    const r = await RS.research({ product: g.product, country: g.country, pass, started: Date.now(), now, source: 'watch' });
    if (r.busy) { state.capped = true; return; }
    if (r.failed || !r.ok || !r.didJudge) return; // leave it for tomorrow; people are never emailed from a result we could not read
    await store.incrBy('wspend:' + today(), Math.round((r.costUsd || 0) * 1e6));
    await store.expire('wspend:' + today(), 3 * 86400);
    ev = r.out;
    if (r.hadResults && !r.searchErr) await store.setJson(RS.cacheKeyFor(g.product, g.country), ev, (ev.accepted.length ? c.cacheHours * 3600 : 1800));
  }
  await store.set('wlast:' + key, '1', 20 * 3600);
  state.products++;
  if (!RS.hasOffers(ev)) return;
  const best = R.pickBest(ev.accepted.filter((a) => a.kind === 'price' || a.kind === 'refurb'));
  const extras = ev.accepted.filter((a) => a.kind === 'coupon' || a.kind === 'cashback').map((a) => ({ kind: a.kind, store: a.store, code: a.code, percent: a.percent, expires: a.expiresIso }));
  for (const ref of g.subs) {
    if (state.emails >= c.watchMaxEmails) return;
    const sub = await W.getSub(ref.id);
    if (!sub || sub.unsubscribed) continue;
    const item = (sub.items || []).find((it) => it.id === ref.item);
    if (!item || !W.active(item, Date.now())) continue;
    const pro = sub.plan === 'pro';
    if (!W.shouldNotify(item, best, extras, sub.plan, Date.now())) continue;
    const label = item.name + (item.variant ? ' (' + item.variant + ')' : '');
    const m = watchAlertEmail({ name: label, best, extras, pro, findUrl: c.siteUrl + '/find?q=' + encodeURIComponent(item.name), stopUrl: W.stopLink(ref.id, item.id), unsubUrl: W.unsubLink(ref.id) });
    const r = await sendEmail({ to: sub.email, subject: m.subject, html: m.html, text: m.text, headers: m.headers });
    if (!r.ok) continue; // not marked as sent, so tomorrow's run tries again
    item.last = { price: best.price, store: best.store, ts: Date.now(), codes: extras.filter((x) => x.code).map((x) => x.code).slice(0, 10) };
    if (!pro) item.done = true; // a free watch delivers its one alert and finishes
    await W.saveSub(ref.id, sub);
    state.emails++; bump('watch_sent');
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!authorised(req)) return send(res, 401, { error: 'unauthorized' });
  const c = cfg();
  const url = new URL(req.url, 'http://x');
  const started = Date.now();
  const state = { products: 0, emails: 0, capped: false, fresh: url.searchParams.get('fresh') === '1' };
  try {
    if (await isKilled()) return send(res, 503, { error: 'paused' });
    if (!url.searchParams.get('next')) { const n = await buildQueue(); bump('watch_run'); state.queued = n; }
    // Take products off the queue until about 45 seconds are used (a cached product is quick; a fresh search takes most of the minute).
    while (Date.now() - started < 12000) {
      const key = await store.rpop('wq');
      if (!key) break;
      await processProduct(key, state);
      if (state.capped) { await store.del('wq'); break; }
    }
    const left = await store.llen('wq');
    if (left > 0 && !state.capped) {
      // Carry on in a fresh invocation. We only wait a moment for the request to leave; the next run continues on its own.
      const secret = c.cronSecret || c.adminToken;
      try { await fetch(c.siteUrl + '/api/watchrun?next=1', { headers: { Authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(2500) }); } catch (_) { /* expected: we stop waiting */ }
    }
    return send(res, 200, { ok: true, searched: state.products, emails: state.emails, queued: state.queued, left, capped: state.capped });
  } catch (e) { return send(res, 503, { error: 'unavailable' }); }
};
