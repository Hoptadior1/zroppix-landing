'use strict';
// POST /api/protect  {store, product, paid, date, visitor}  ->  the lowest dated price the SAME store has now, and the possible difference.
// Price adjustments are paid against the store's own price, so only offers from the chosen store are compared.
// Free: one lookup per browser. A result already in the cache (someone ran Find on the product in the last few hours) costs nothing and uses no lookup.
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, normName } = require('./_lib/util');
const { isKilled } = require('./_lib/spend');
const { within, refund } = require('./_lib/limits');
const R = require('./_lib/rules');
const RS = require('./_lib/research');
const PRO = require('./_lib/pro');
let DEALS; try { DEALS = require('./_lib/deals_index.json'); } catch (_) { DEALS = []; }

const STORES = { amazon: 'amazon', bestbuy: 'best buy', target: 'target', walmart: 'walmart', costco: 'costco' };
const r2 = (n) => Math.round(n * 100) / 100;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const visitor = validVisitor(body.visitor);
  const key = String(body.store || '');
  const name = clean(body.product, 100);
  const paid = Number(body.paid);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : '';
  if (!visitor) return send(res, 400, { error: 'bad_visitor' });
  if (!STORES[key]) return send(res, 200, { ok: true, lookup: 'unsupported' }); // "other" store: nothing to look up
  if (name.length < 2 || !(paid > 0 && paid < 100000) || !day) return send(res, 400, { error: 'bad_input' });
  const ageDays = Math.floor((Date.now() - new Date(day + 'T00:00:00Z').getTime()) / 86400000);
  if (ageDays < 0 || ageDays > 120) return send(res, 400, { error: 'bad_date' });
  const c = cfg();
  let counted = false; let usedLookup = false; const ip = ipHash(req);
  try {
    if (await isKilled()) return send(res, 503, { error: 'paused' });
    const w = await PRO.whoIs(req).catch(() => null);
    const pro = !!(w && w.pro);
    if (pro) { if (!(await within('prouse', w.eh, c.proPerDay, 'day'))) return send(res, 429, { error: 'pro_limit' }); }
    else { if (!(await within('protect', ip, c.protectPerIpDay, 'day'))) return send(res, 429, { error: 'daily_limit' }); counted = true; }

    const product = { name, variant: '' };
    const cacheKey = RS.cacheKeyFor(product, 'US');
    let ev = await store.getJson(cacheKey);
    let cached = !!ev;
    if (!ev) {
      if (!pro) {
        const n = await store.incrBy('protused:' + visitor, 1);
        if (n === 1) await store.expire('protused:' + visitor, 120 * 86400);
        if (n > c.protectFree) { await store.incrBy('protused:' + visitor, -1); if (counted) await refund('protect', ip, 'day'); return send(res, 402, { error: 'no_lookups' }); }
        usedLookup = true;
      }
      const r1 = await RS.research({ product, country: 'US', pass: 1, started: Date.now(), now: new Date() });
      if (r1.busy || r1.failed) {
        if (usedLookup) await store.incrBy('protused:' + visitor, -1);
        if (counted) await refund('protect', ip, 'day');
        return send(res, 200, { ok: true, lookup: 'unavailable' });
      }
      ev = r1.out;
      if (r1.ok && r1.didJudge && !r1.searchErr && r1.hadResults) await store.setJson(cacheKey, ev, (ev.accepted.length ? c.cacheHours * 3600 : 1800));
    }
    const key2 = STORES[key];
    const mine = (ev.accepted || []).filter((a) => a.kind === 'price' && a.currency === 'USD' && a.price > 0 && normName(a.store || '').includes(key2));
    mine.sort((a, b) => a.price - b.price);
    const low = mine[0] || null;
    const tgt = low ? R.storeTarget(low, name, 'US') : null;
    const out = { ok: true, lookup: 'done', cached, store: STORES[key], checkedAt: new Date().toISOString() };
    const dl = R.matchDeal(name, DEALS) || R.matchDeal(name.replace(/\b\d+(\.\d+)?[- ]?(inch|in|gb|tb)\b/gi, ' ').replace(/\s+/g, ' '), DEALS); // size and storage words do not change which product's history applies
    if (dl && dl.average > 0 && dl.lowest > 0) out.typical = { average: dl.average, lowest: dl.lowest };
    if (low) {
      out.found = { price: low.price, dateHuman: low.dateHuman, ageDays: low.ageDays, sourceUrl: low.sourceUrl, sourceTitle: low.sourceTitle, url: tgt && tgt.kind !== 'article' ? tgt.url : null };
      out.diff = low.price < paid ? r2(paid - low.price) : 0;
    } else { out.found = null; out.diff = 0; }
    return send(res, 200, out);
  } catch (e) {
    try { if (usedLookup) await store.incrBy('protused:' + visitor, -1); if (counted) await refund('protect', ip, 'day'); } catch (_) { /* ignore */ }
    return send(res, 503, { error: 'unavailable' });
  }
};
