'use strict';
// GET /api/stats  (header: Authorization: Bearer <FIND_ADMIN_TOKEN>)  -> owner-only numbers. Disabled if no token is set.
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, sha } = require('./_lib/util');
const { build } = require('./_lib/health');

function pairs(arr) { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0; return o; }

module.exports = async (req, res) => {
  const c = cfg();
  if (!c.adminToken) return send(res, 404, { error: 'not_found' });
  const got = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!got || !crypto.timingSafeEqual(Buffer.from(sha(got)), Buffer.from(sha(c.adminToken)))) return send(res, 401, { error: 'unauthorized' });
  try {
    if (req.url && /[?&]debug=1/.test(req.url)) {
      const rows = (await store.lrange('dbg', 0, 19)) || [];
      return send(res, 200, { runs: rows.map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean) });
    }
    if (req.url && /[?&]insights=1/.test(req.url)) {
      const n = Math.max(1, Math.min(14, Number((/[?&]days=(\d+)/.exec(req.url) || [])[1]) || 7));
      const src = {}, st = {}, ctry = {}, uvDays = [], lat = { n: 0, sum: 0, max: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 };
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const a = pairs(await store.hgetall('srcs:' + d)); for (const k of Object.keys(a)) src[k] = (src[k] || 0) + a[k];
        const b = pairs(await store.hgetall('stat:' + d)); for (const k of Object.keys(b)) st[k] = (st[k] || 0) + b[k];
        const cc = pairs(await store.hgetall('ctry:' + d)); for (const k of Object.keys(cc)) ctry[k] = (ctry[k] || 0) + cc[k];
        uvDays.push({ day: d, searched: await store.hlen('uv:' + d), checked: await store.hlen('uvc:' + d) });
        const l = pairs(await store.hgetall('lat:' + d));
        for (const k of ['n', 'sum', 'b0', 'b1', 'b2', 'b3', 'b4']) lat[k] += l[k] || 0;
        lat.max = Math.max(lat.max, l.max || 0);
      }
      const g = (k) => st[k] || 0;
      const cl = {};
      for (const k of Object.keys(ctry)) { const m = /^([A-Z]{2}):([sfn])$/.exec(k); if (m) { cl[m[1]] = cl[m[1]] || { country: m[1], searches: 0, found: 0, nothing: 0 }; cl[m[1]][{ s: 'searches', f: 'found', n: 'nothing' }[m[2]]] = ctry[k]; } }
      const checks = g('check_ok') + g('check_fallback') + g('check_unreadable');
      return send(res, 200, {
        days: n,
        funnel: { searches: g('queries'), checks, found: g('check_ok'), offer_clicks: g('ev_offer_click'), pro_clicks: g('ev_pro_click'), pro_views: g('ev_pro_view'), checkout_opened: g('ev_checkout_loaded'), checkout_paid: g('ev_checkout_paid'), watches: g('ev_watch_added'), signins: g('ev_signin_click') },
        visitors: { per_day: uvDays, today: uvDays[0] || null },
        countries: Object.keys(cl).map((k) => cl[k]).sort((x, y) => y.searches - x.searches).slice(0, 25),
        health: await build(new Date(Date.now() - 86400000).toISOString().slice(0, 10)),
        sources: Object.keys(src).map((k) => ({ source: k, count: src[k] })).sort((x, y) => y.count - x.count).slice(0, 20),
        limits: { out_of_checks: g('limit_checks'), daily_ip_cap: g('limit_ip'), pro_fair_use: g('limit_pro'), bonus_requested: g('bonus_requested'), bonus_claimed: g('bonus_claimed') },
        why: { no_offers: g('why_nooffers'), search_error: g('why_searcherr'), unreadable: g('why_unreadable'), busy: g('why_busy') },
        speed: { runs: lat.n, avg_s: lat.n ? Math.round(lat.sum / lat.n / 100) / 10 : null, slowest_s: Math.round(lat.max / 100) / 10, under10: lat.b0, s10_20: lat.b1, s20_30: lat.b2, s30_45: lat.b3, over45: lat.b4 },
      });
    }
    if (req.url && /[?&]products=1/.test(req.url)) {
      const n = Math.max(1, Math.min(14, Number((/[?&]days=(\d+)/.exec(req.url) || [])[1]) || 7));
      const tot = {}, none = {}, perDay = [];
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const a = pairs(await store.hgetall('prod:' + d)), b = pairs(await store.hgetall('prodn:' + d));
        let sa = 0, sb = 0;
        for (const k of Object.keys(a)) { tot[k] = (tot[k] || 0) + a[k]; sa += a[k]; }
        for (const k of Object.keys(b)) { none[k] = (none[k] || 0) + b[k]; sb += b[k]; }
        perDay.push({ day: d, searches: sa, nothing: sb, distinct: Object.keys(a).length });
      }
      const top = (o) => Object.keys(o).map((k) => ({ product: k, count: o[k] })).sort((x, y) => y.count - x.count).slice(0, 20);
      return send(res, 200, { days: n, top: top(tot), nothing: top(none), per_day: perDay });
    }
    const days = [];
    for (let i = 0; i < 14; i++) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const out = [];
    for (const d of days) {
      const s = pairs(await store.hgetall('stat:' + d));
      const spend = (Number(await store.get('spend:' + d)) || 0) / 1e6;
      const aiChecks = s.check_ai || 0;
      out.push({ day: d, spend_usd: Math.round(spend * 1000) / 1000, ai_checks: aiChecks, cache_hits: s.check_cache || 0, shown_offers: s.check_ok || 0, fallbacks: s.check_fallback || 0, errors: s.check_ai_error || 0,
        searches: s.queries || 0, web_searches: s.searches || 0, matches_ai: s.match_ai || 0, avg_cost_per_check_usd: aiChecks ? Math.round((spend / aiChecks) * 1000) / 1000 : null,
        share_no_offer: (s.check_ok || 0) + (s.check_fallback || 0) ? Math.round(((s.check_fallback || 0) / ((s.check_ok || 0) + (s.check_fallback || 0))) * 100) : null,
        bonus_requested: s.bonus_requested || 0, bonus_claimed: s.bonus_claimed || 0, waitlist: s.waitlist || 0, pro_login_sent: s.pro_login_sent || 0, pro_login_nopro: s.pro_login_nopro || 0, pro_signins: s.pro_signin || 0,
        second_searches: s.check_pass2 || 0, watches_requested: s.watch_requested || 0, watches_confirmed: s.watch_confirmed || 0, watches_pro: s.watch_added_pro || 0, watch_searches: s.watch_ai || 0, alerts_sent: s.watch_sent || 0, watch_stops: s.watch_stop || 0, watch_unsubs: s.watch_unsub || 0 });
    }
    return send(res, 200, { cap_usd: c.dailyCapUsd, killed: c.killEnv || (await store.get('find:kill')) === '1', waitlist_total: await store.hlen('wl'), watchers_total: await store.hlen('wsubs'), mail_queue: await store.llen('mailq'), days: out });
  } catch (e) { return send(res, 503, { error: 'unavailable' }); }
};
