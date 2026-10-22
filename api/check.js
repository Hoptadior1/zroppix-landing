'use strict';
// POST /api/check  {candidate:{name,variant}, visitor, country?}  ->  the offers.
// A check is only used up when real offers are shown. Locked details are never sent to free users.
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, pickCountry, isOwner, normName, sha } = require('./_lib/util');
const { isKilled, reserve, settle, bump } = require('./_lib/spend');
const { within, allowance, consume } = require('./_lib/limits');
const ai = require('./_lib/anthropic');
const P = require('./_lib/prompts');
const R = require('./_lib/rules');

let DEALS = [];
try { DEALS = require('./_lib/deals_index.json'); } catch (_) { DEALS = []; }

const OFFER_KINDS = new Set(['price', 'coupon', 'cashback', 'refurb']);

// Owner-only diagnostics: what the AI returned on the last 20 runs. Visible only through /api/stats?debug=1.
async function logDebug(entry) {
  try {
    await store.lpush('dbg', JSON.stringify(entry));
    await store.ltrim('dbg', 0, 19);
    await store.expire('dbg', 3 * 86400);
  } catch (_) { /* diagnostics must never break a request */ }
}

function gatherView(f) { // what the judge is allowed to see
  return { id: f.id, kind: f.kind, store: f.store, title: f.title, price: f.price, currency: f.currency, percent: f.percent, code: f.code, expires: f.expires, page_date: f.pageDate, quote: f.quote, seller: f.seller, condition: f.condition };
}

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
  const tier = owner ? 'pro' : 'free';
  const started = Date.now();
  let ticket = null;
  try {
    if (await isKilled()) return send(res, 503, { error: 'paused' });
    const ip = ipHash(req);
    if (!(await within('check', ip, c.checkPerIpDay, 'day'))) return send(res, 429, { error: 'daily_limit' });

    const al = await allowance(visitor);
    if (!owner && al.left <= 0) return send(res, 402, { error: 'no_checks', left: 0, bonusAvailable: al.bonus === 0 });

    const now = new Date();
    const deal = R.matchDeal(product.name, DEALS);
    const cacheKey = 'c2:' + sha(normName(product.name + ' ' + product.variant) + '|' + country);
    let ev = await store.getJson(cacheKey);
    let cached = !!ev;
    let judged = true;
    let hadSearchError = false;
    let parsed = true;

    if (!ev) {
      ticket = await reserve(c.reserveCheckUsd);
      if (!ticket) return send(res, 503, { error: 'busy' });
      let cost = 0;
      let gather;
      try {
        gather = await ai.call({
          model: c.gatherModel, system: P.GATHER_SYSTEM,
          messages: [{ role: 'user', content: P.gatherUser(product, country, now.toISOString().slice(0, 10)) }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: c.maxSearches, user_location: { type: 'approximate', country } }],
          maxTokens: 12000, deadline: started + 38000,
        });
        cost += gather.costUsd;
      } catch (e) {
        await settle(ticket, cost); ticket = null;
        bump('check_ai_error');
        // Never an empty page, even if the search failed: plain store links and our history page.
        return send(res, 200, { status: 'fallback', tier, product, country, checkedAt: now.toISOString(), cached: false, remaining: { left: al.left, total: al.total },
          result: R.buildFallback({ productName: product.name, country, stale: [], deal, newer: [], hadSearchError: true }) });
      }
      hadSearchError = gather.searchErrors > 0;
      const gj = ai.extractJson(gather.text);
      parsed = !!(gj && Array.isArray(gj.findings));
      const rawFindings = parsed ? gj.findings.slice(0, 12) : [];
      const norm = rawFindings.map((x, i) => R.normalizeFinding(x, i));

      let verdicts = {};
      if (norm.length) {
        try {
          const jr = await ai.call({
            model: c.judgeModel, system: P.JUDGE_SYSTEM,
            messages: [{ role: 'user', content: P.judgeUser(product, now.toISOString().slice(0, 10), norm.map(gatherView)) }],
            maxTokens: 6000, deadline: started + 54000,
          });
          cost += jr.costUsd;
          const jj = ai.extractJson(jr.text);
          for (const v of (jj && Array.isArray(jj.verdicts) ? jj.verdicts : [])) {
            if (v && v.id) verdicts[clean(v.id, 12)] = { same_product: v.same_product !== false, verdict: v.verdict === 'accept' ? 'accept' : 'reject', reason: clean(v.reason, 100) };
          }
          // A finding the judge did not mention is treated as not vetted.
          for (const f of norm) if (!verdicts[f.id]) verdicts[f.id] = { same_product: false, verdict: 'reject', reason: 'not confirmed by the second check' };
        } catch (e) { judged = false; verdicts = {}; }
      }
      await settle(ticket, cost); ticket = null;
      bump('check_ai'); bump('cost_micro', Math.round(cost * 1e6)); bump('searches', (gather.usage.server_tool_use || {}).web_search_requests || 0);

      const out = R.evaluate(rawFindings, { now, maxAgeDays: c.maxAgeDays, staleMaxDays: c.staleMaxDays, results: gather.results, judge: verdicts });
      ev = out;
      out.proof = { pages: gather.results.length, sites: new Set(gather.results.map((r) => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }).filter(Boolean)).size, rejected: out.rejected.length };
      await logDebug({ t: now.toISOString(), product: product.name + (product.variant ? ' / ' + product.variant : ''), country, stop: gather.stop, blocks: gather.blockTypes, usage: gather.usage, searches: (gather.usage.server_tool_use || {}).web_search_requests || 0, searchErrors: gather.searchErrors,
        results: gather.results.length, resultUrls: gather.results.slice(0, 8).map((r) => r.url), textLen: gather.text.length, textHead: gather.text.slice(0, 700), textTail: gather.text.slice(-300),
        parsed, findings: rawFindings.length, accepted: out.accepted.length, rejected: out.rejected.slice(0, 8), judged, costUsd: Math.round(cost * 10000) / 10000 });
      // Cache only runs we could read. A run that found offers is kept for the full time; a clean "nothing found" only briefly.
      if (parsed && judged && !hadSearchError && gather.results.length) await store.setJson(cacheKey, out, (out.accepted.length ? c.cacheHours * 3600 : 1800));
    } else bump('check_cache');

    const offers = ev.accepted.filter((a) => OFFER_KINDS.has(a.kind));
    const hist = deal ? { url: '/deals/' + deal.slug, title: deal.title, lowest: deal.lowest || null, average: deal.average || null, updated: deal.updated || null } : null;
    if (!offers.length) {
      bump(parsed ? 'check_fallback' : 'check_unreadable');
      return send(res, 200, { status: 'fallback', tier, product, country, checkedAt: now.toISOString(), cached, judged, remaining: { left: al.left, total: al.total },
        result: Object.assign(R.buildFallback({ productName: product.name, country, stale: ev.stale, deal, newer: ev.accepted.filter((a) => a.kind === 'newer_model').slice(0, 1), unreadable: !parsed }), { rejected: ev.rejected.slice(0, 8).map((r) => ({ what: r.what, why: r.why })) }) });
    }
    // Real offers are shown: this is where a check is used.
    let left = al.left;
    if (!owner) {
      const ok = await consume(visitor);
      if (!ok) return send(res, 402, { error: 'no_checks', left: 0, bonusAvailable: al.bonus === 0 });
      left = al.left - 1;
    }
    bump('check_ok');
    return send(res, 200, { status: 'ok', tier, product, country, checkedAt: now.toISOString(), cached, judged, remaining: { left, total: al.total },
      result: R.shape(ev, tier, { history: hist }, { productName: product.name, country }) });
  } catch (e) {
    if (ticket) { try { await settle(ticket, 0); } catch (_) { /* ignore */ } }
    return send(res, 503, { error: 'unavailable' });
  }
};
