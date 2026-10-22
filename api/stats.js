'use strict';
// GET /api/stats  (header: Authorization: Bearer <FIND_ADMIN_TOKEN>)  -> owner-only numbers. Disabled if no token is set.
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, sha } = require('./_lib/util');

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
    const days = [];
    for (let i = 0; i < 14; i++) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const out = [];
    for (const d of days) {
      const s = pairs(await store.hgetall('stat:' + d));
      const spend = (Number(await store.get('spend:' + d)) || 0) / 1e6;
      const aiChecks = s.check_ai || 0;
      out.push({ day: d, spend_usd: Math.round(spend * 1000) / 1000, ai_checks: aiChecks, cache_hits: s.check_cache || 0, shown_offers: s.check_ok || 0, fallbacks: s.check_fallback || 0, errors: s.check_ai_error || 0,
        searches: s.searches || 0, matches_ai: s.match_ai || 0, avg_cost_per_check_usd: aiChecks ? Math.round((spend / aiChecks) * 1000) / 1000 : null,
        share_no_offer: (s.check_ok || 0) + (s.check_fallback || 0) ? Math.round(((s.check_fallback || 0) / ((s.check_ok || 0) + (s.check_fallback || 0))) * 100) : null,
        bonus_requested: s.bonus_requested || 0, bonus_claimed: s.bonus_claimed || 0, waitlist: s.waitlist || 0 });
    }
    return send(res, 200, { cap_usd: c.dailyCapUsd, killed: c.killEnv || (await store.get('find:kill')) === '1', waitlist_total: await store.hlen('wl'), mail_queue: await store.llen('mailq'), days: out });
  } catch (e) { return send(res, 503, { error: 'unavailable' }); }
};
