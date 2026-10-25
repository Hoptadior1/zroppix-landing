'use strict';
// POST /api/check  {candidate:{name,variant}, visitor, country?}  ->  the offers.
// A check is only used up when real offers are shown. Locked details are never sent to free users.
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, pickCountry, isOwner, normName, sha } = require('./_lib/util');
const { isKilled, reserve, settle, bump, trackProduct } = require('./_lib/spend');
const { within, allowance, consume } = require('./_lib/limits');
const ai = require('./_lib/anthropic');
const P = require('./_lib/prompts');
const R = require('./_lib/rules');
const PRO = require('./_lib/pro');

let DEALS = [];
try { DEALS = require('./_lib/deals_index.json'); } catch (_) { DEALS = []; }

const RS = require('./_lib/research');
const { OFFER_KINDS, hasOffers } = RS;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const visitor = validVisitor(body.visitor);
  const cand = body.candidate && typeof body.candidate === 'object' ? body.candidate : {};
  const product = { name: clean(cand.name, 100), variant: clean(cand.variant, 50) };
  if (product.name.length < 2) return send(res, 400, { error: 'no_product' });
  if (!visitor) return send(res, 400, { error: 'bad_visitor' });
  const c = cfg();
  const country = pickCountry(req, body);
  const owner = isOwner(req);
  let tier = owner ? 'pro' : 'free';
  let unmetered = owner; // the owner and signed-in Pro customers do not use free checks
  let customer = null;
  const started = Date.now();
  let ticket = null;
  try {
    if (await isKilled()) return send(res, 503, { error: 'paused' });
    const ip = ipHash(req);
    if (!owner) {
      // A signed-in customer whose plan is active gets the Pro view. If the plan cannot be confirmed, they are treated as free (never an error).
      const w = await PRO.whoIs(req).catch(() => null);
      if (w && w.pro) { tier = 'pro'; unmetered = true; customer = w; }
    }
    // Free visitors are limited per network address. Owner and Pro customers are limited per person instead (below).
    if (!unmetered && !(await within('check', ip, c.checkPerIpDay, 'day'))) return send(res, 429, { error: 'daily_limit' });
    if (customer && !(await within('prouse', customer.eh, c.proPerDay, 'day'))) return send(res, 429, { error: 'pro_limit' });

    const al = await allowance(visitor);
    if (!unmetered && al.left <= 0) return send(res, 402, { error: 'no_checks', left: 0, bonusAvailable: al.bonus === 0 });

    const now = new Date();
    const deal = R.matchDeal(product.name, DEALS);
    const cacheKey = RS.cacheKeyFor(product, country);
    let ev = await store.getJson(cacheKey);
    let cached = !!ev;
    let judged = true;
    let hadSearchError = false;
    let parsed = true;

    let stored = false; // true when this result sits in the cache, so a second search can build on it
    const fallbackNow = () => send(res, 200, { status: 'fallback', tier, product, country, checkedAt: now.toISOString(), cached: false, remaining: { left: al.left, total: al.total },
      result: R.buildFallback({ productName: product.name, country, stale: [], deal, newer: [], hadSearchError: true }) });

    if (!ev) {
      const r1 = await RS.research({ product, country, pass: 1, started, now });
      if (r1.busy) return send(res, 503, { error: 'busy' });
      if (r1.failed) return fallbackNow(); // never an empty page, even if the search failed
      ev = r1.out; judged = r1.didJudge; hadSearchError = r1.searchErr; parsed = r1.ok;
      // Cache only runs we could read. A run that found offers is kept for the full time; a clean "nothing found" only briefly.
      if (parsed && judged && !hadSearchError && r1.hadResults) { await store.setJson(cacheKey, ev, (ev.accepted.length ? c.cacheHours * 3600 : 1800)); stored = true; }
    } else if (body.pass === 2 && !ev.pass2 && !hasOffers(ev)) {
      // Second search: different wording, merged with the first result. Only after a first search that found no offers, and only once.
      if (!unmetered && !(await within('check2', ipHash(req), c.checkPerIpDay, 'day'))) return send(res, 429, { error: 'daily_limit' });
      const r2 = await RS.research({ product, country, pass: 2, started, now });
      if (r2.busy) return send(res, 503, { error: 'busy' });
      if (r2.failed) { bump('check_cache'); }
      else {
        const merged = RS.merge(ev, r2.out);
        ev = merged; judged = r2.didJudge;
        if (r2.ok && r2.didJudge && !r2.searchErr) { await store.setJson(cacheKey, ev, (hasOffers(ev) ? c.cacheHours * 3600 : 1800)); stored = true; }
      }
    } else { bump('check_cache'); stored = true; }

    const offers = ev.accepted.filter((a) => OFFER_KINDS.has(a.kind));
    const hist = deal ? { url: '/deals/' + deal.slug, title: deal.title, lowest: deal.lowest || null, average: deal.average || null, updated: deal.updated || null } : null;
    if (!offers.length) {
      bump(parsed ? 'check_fallback' : 'check_unreadable');
      await trackProduct(product.name, false);
      return send(res, 200, { status: 'fallback', tier, product, country, checkedAt: now.toISOString(), cached, judged, remaining: { left: al.left, total: al.total },
        result: Object.assign(R.buildFallback({ productName: product.name, country, stale: ev.stale, deal, newer: ev.accepted.filter((a) => a.kind === 'newer_model').slice(0, 1), unreadable: !parsed, tier, undated: ev.undated || [] }), R.rejectedOut(ev.rejected, tier === 'pro'), { retry: !!(stored && parsed && judged && !ev.pass2 && body.pass !== 2) }) });
    }
    // Real offers are shown: this is where a check is used.
    let left = al.left;
    if (!unmetered) {
      const ok = await consume(visitor);
      if (!ok) return send(res, 402, { error: 'no_checks', left: 0, bonusAvailable: al.bonus === 0 });
      left = al.left - 1;
    }
    bump('check_ok');
    await trackProduct(product.name, true);
    return send(res, 200, { status: 'ok', tier, product, country, checkedAt: now.toISOString(), cached, judged, remaining: { left, total: al.total },
      result: R.shape(ev, tier, { history: hist }, { productName: product.name, country }) });
  } catch (e) {
    if (ticket) { try { await settle(ticket, 0); } catch (_) { /* ignore */ } }
    return send(res, 503, { error: 'unavailable' });
  }
};
