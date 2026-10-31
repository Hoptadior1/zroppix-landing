'use strict';
// One search-and-verify run for one product, shared by /api/check (a shopper waiting) and /api/watchrun (the daily recheck).
// Pass 1 and pass 2 use different search wording. Spend is always reserved first and settled after, even on errors.
const { cfg } = require('./config');
const store = require('./store');
const { clean, normName, sha } = require('./util');
const { reserve, settle, bump } = require('./spend');
const ai = require('./anthropic');
const P = require('./prompts');
const R = require('./rules');
const S = require('./sources');
const OF = require('./offers');

const OFFER_KINDS = new Set(['price', 'coupon', 'cashback', 'refurb']);
const hasOffers = (ev) => !!ev && ev.accepted.some((x) => OFFER_KINDS.has(x.kind));
const cacheKeyFor = (product, country) => 'c2:' + sha(normName(product.name + ' ' + product.variant) + '|' + country);

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

// Returns {busy} if the day's spend cap is reached, {failed} if the search itself failed,
// otherwise {out, ok, didJudge, searchErr, hadResults, costUsd}.
// What is searched depends on what is already known: coupons, cashback and other savings are remembered between searches
// (until they expire, or for a few days), so only the part that is stale is searched again. Everything that can be done
// by code (de-duplication, matching, expiry checks, arithmetic) is done by code, and the AI judge sees only what is left.
const memKeyFor = (product, country) => 'm1:' + sha(normName(product.name + ' ' + product.variant) + '|' + country);

async function research({ product, country, pass, started, now, source }) {
  const c = cfg();
  now = now || new Date(); started = started || Date.now();
  const ticket = await reserve(c.reserveCheckUsd);
  if (!ticket) return { busy: true };
  let cost = 0; let settled = false;
  const done = async () => { if (!settled) { settled = true; await settle(ticket, cost); } };
  const meter = { calls: [], searches: 0, tokensIn: 0, tokensOut: 0, usd: 0, memoryItems: 0, skipped: [], deduped: 0, rememberedRejects: 0, shortcut: 0, ms: 0 };
  const timed = async (step, model, p) => { const t0 = Date.now(); const r = await p; const u = r.usage || {}; const sr = (u.server_tool_use || {}).web_search_requests || 0; meter.calls.push({ step, model, in: u.input_tokens || 0, out: u.output_tokens || 0, searches: sr, usd: Math.round(r.costUsd * 1e5) / 1e5, ms: Date.now() - t0 }); meter.searches += sr; meter.tokensIn += u.input_tokens || 0; meter.tokensOut += u.output_tokens || 0; meter.usd += r.costUsd; return r; };
  try {
    const today = now.toISOString().slice(0, 10);
    const split = c.parallelGather && pass !== 2 && c.maxSearches >= 2; // pass 2 keeps its own wording
    const per = split ? Math.max(2, Math.ceil(c.maxSearches / 2)) : c.maxSearches;
    const userMsg = (pass === 2 ? P.gatherUser2 : P.gatherUser)(product, country, today);
    const run = (step, focus) => timed(step, c.gatherModel, ai.call({
      model: c.gatherModel, system: P.GATHER_SYSTEM,
      messages: [{ role: 'user', content: userMsg + (focus || '') }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: per, user_location: { type: 'approximate', country } }],
      maxTokens: 12000, deadline: started + 38000,
    }));

    // Memory: what was found before and is still valid. The extras search (coupons, cashback, other savings) is skipped while it is fresh.
    let mem = null; const memKey = memKeyFor(product, country);
    if (pass !== 2 && c.memory) { try { mem = await store.getJson(memKey); } catch (_) { mem = null; } }
    const freshHours = source === 'watch' ? c.extrasFreshWatchHours : c.extrasFreshHours;
    const useMem = split && OF.memoryUsable(mem, now, freshHours);
    const remembered = useMem ? OF.reviveItems(mem.items, now, { coupon: c.maxAgeDays, cashback: c.cashbackMaxDays, promo: 60 }) : [];
    if (useMem) { meter.skipped.push('extras search (remembered ' + remembered.length + ' offers)'); meter.memoryItems = remembered.length; bump('mem_extras_skipped'); }

    // The stores' own data and the price search start together. The extras search starts as soon as the store data gives exact identifiers.
    const apiP = pass === 2 ? Promise.resolve({ ids: {}, findings: [], results: [] }) : S.fetchAll(product, country, now);
    const priceRun = split ? run('prices', P.FOCUS_PRICES) : run('single', '');
    const api = await apiP;
    const extraRun = split && !useMem ? run('extras', P.FOCUS_EXTRAS + P.idsLine(api.ids)) : null;
    const runs = await Promise.allSettled(extraRun ? [priceRun, extraRun] : [priceRun]);
    const okRuns = runs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
    if (!okRuns.length) { await done(); bump('check_ai_error'); return { failed: true }; }
    const extrasOk = !!extraRun && runs[1] && runs[1].status === 'fulfilled';
    const gather = {
      text: okRuns.map((g) => g.text).join('\n'), costUsd: okRuns.reduce((n, g) => n + g.costUsd, 0),
      results: okRuns.reduce((a, g) => a.concat(g.results), []), searchErrors: okRuns.reduce((n, g) => n + g.searchErrors, 0) + (runs.length - okRuns.length),
      stop: okRuns[0].stop, blockTypes: okRuns[0].blockTypes,
      usage: { server_tool_use: { web_search_requests: okRuns.reduce((n, g) => n + ((g.usage.server_tool_use || {}).web_search_requests || 0), 0) } },
    };
    cost += gather.costUsd;
    const searchErr = gather.searchErrors > 0;
    let ok = false; let rawFindings = []; let extrasParsed = false;
    runs.forEach((rn, k) => {
      if (rn.status !== 'fulfilled') return;
      const gj = ai.extractJson(rn.value.text);
      if (gj && Array.isArray(gj.findings)) {
        ok = true; if (k === 1) extrasParsed = true;
        gj.findings.slice(0, split ? 8 : 12).forEach((x, n) => {
          if (!x || typeof x !== 'object') return;
          const y = Object.assign({}, x, { id: (pass === 2 ? 'p2_' : split ? 'w' + (k + 1) + '_' : '') + (n + 1) });
          delete y._api; delete y.verified; // only our own store-data code may mark an offer as verified
          rawFindings.push(y);
        });
      }
    });
    if (api.findings.length) { ok = true; rawFindings = rawFindings.concat(api.findings); bump('api_findings', api.findings.length); }

    // Code, not the AI: drop repeats and anything already rejected for this product in a recent search.
    const dd = OF.dedupe(rawFindings); rawFindings = dd.list; meter.deduped = dd.dropped;
    const rejSet = new Set(mem && mem.rej ? mem.rej : []);
    const keyOfRaw = (x) => OF.keyOf({ kind: x.kind, store: x.store, provider: x.provider, price: x.price, percent: x.percent, amount: x.amount_usd != null ? x.amount_usd : x.amount, code: x.code, promoType: x.promo_type });
    if (rejSet.size) { const before = rawFindings.length; rawFindings = rawFindings.filter((x) => !(x && ['coupon', 'cashback', 'promo'].includes(x.kind) && rejSet.has(keyOfRaw(x)))); meter.rememberedRejects = before - rawFindings.length; }
    // Ids must stay unique after the filtering above.
    const norm = rawFindings.map((x, i) => R.normalizeFinding(x, i));

    // Judge. Store-data prices whose title names the exact model need no AI. Coupons, cashback and other savings (is the quote saying what is claimed?)
    // go to the small model. Prices from web pages and anything ambiguous go to the stronger one.
    let verdicts = {}; let didJudge = true;
    const easy = []; const hard = [];
    norm.forEach((f) => {
      if (f.verified && OF.modelMatches(product.name + ' ' + (product.variant || ''), f.title)) { verdicts[f.id] = { same_product: true, verdict: 'accept', reason: 'model number matches the store listing' }; meter.shortcut++; }
      else if (['coupon', 'cashback', 'promo'].includes(f.kind)) easy.push(f); else hard.push(f);
    });
    const judge = async (step, model, list) => {
      if (!list.length) return;
      const jr = await timed(step, model, ai.call({ model, system: P.JUDGE_SYSTEM, messages: [{ role: 'user', content: P.judgeUser(product, today, list.map(gatherView)) }], maxTokens: 6000, deadline: started + 54000 }));
      cost += jr.costUsd;
      const jj = ai.extractJson(jr.text);
      for (const v of (jj && Array.isArray(jj.verdicts) ? jj.verdicts : [])) {
        if (v && v.id) verdicts[clean(v.id, 12)] = { same_product: v.same_product !== false, verdict: v.verdict === 'accept' ? 'accept' : 'reject', reason: clean(v.reason, 100) };
      }
      for (const f of list) if (!verdicts[f.id]) verdicts[f.id] = { same_product: false, verdict: 'reject', reason: 'not confirmed by the second check' };
    };
    try { await Promise.all([judge('judge_easy', c.judgeEasyModel, easy), judge('judge_hard', c.judgeModel, hard)]); } catch (e) { didJudge = false; verdicts = {}; }
    await done();
    bump(source === 'watch' ? 'watch_ai' : 'check_ai'); bump('cost_micro', Math.round(cost * 1e6)); bump('searches', meter.searches); bump('tok_in', meter.tokensIn); bump('tok_out', meter.tokensOut);
    if (pass === 2 && source !== 'watch') bump('check_pass2');
    const out = R.evaluate(rawFindings, { now, maxAgeDays: c.maxAgeDays, staleMaxDays: c.staleMaxDays, cashbackMaxDays: c.cashbackMaxDays, results: gather.results.concat(api.results), judge: verdicts });

    // Bring back what is remembered (each item is re-checked by code: its own expiry and the age of its source), without repeating anything found just now.
    if (remembered.length) {
      const have = new Set(out.accepted.map((a) => OF.keyOf(a)));
      const add = remembered.filter((a) => !have.has(OF.keyOf(a)));
      add.forEach((a) => { a.status = OF.statusOf(a, now); });
      out.accepted = out.accepted.concat(add.filter((a) => a.status !== 'expired'));
    }
    // Remember what the extras search found, and what was rejected, so the next search of this product need not repeat it.
    if (c.memory && pass !== 2 && extrasOk && extrasParsed && didJudge) {
      const rejIds = new Set((out.rejected || []).map((x) => x.id));
      const rejKeys = norm.filter((f) => ['coupon', 'cashback', 'promo'].includes(f.kind) && rejIds.has(f.id)).map((f) => OF.keyOf(f));
      const items = out.accepted.filter((a) => OF.MEM_KINDS.has(a.kind)).slice(0, 20);
      try { await store.setJson(memKey, { at: now.getTime(), items, rej: Array.from(new Set((mem && mem.rej ? mem.rej : []).concat(rejKeys))).slice(-40) }, 7 * 86400); } catch (_) { /* memory is an optimisation only */ }
    }
    meter.ms = Date.now() - started; meter.usd = Math.round(meter.usd * 1e5) / 1e5;
    out.meter = meter;
    out.proof = { pages: gather.results.length, sites: new Set(gather.results.map((r) => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }).filter(Boolean)).size, rejected: out.rejected.length };
    await logDebug({ t: now.toISOString(), pass, source: source || 'check', product: product.name + (product.variant ? ' / ' + product.variant : ''), country, stop: gather.stop, blocks: gather.blockTypes, usage: gather.usage, searches: meter.searches, searchErrors: gather.searchErrors, meter,
      results: gather.results.length, resultUrls: gather.results.slice(0, 8).map((r) => r.url), textLen: gather.text.length, textHead: gather.text.slice(0, 700), textTail: gather.text.slice(-300),
      parsed: ok, findings: rawFindings.length, accepted: out.accepted.length, undated: (out.undated || []).length, rejected: out.rejected.slice(0, 8), judged: didJudge, costUsd: Math.round(cost * 10000) / 10000 });
    return { out, ok, didJudge, searchErr, hadResults: gather.results.length > 0 || api.findings.length > 0 || remembered.length > 0, costUsd: cost, meter };
  } catch (e) { await done(); throw e; }
}

// Combine a second pass with the first result without repeating anything.
function merge(ev, o) {
  const key = (x) => [x.kind, (x.store || '').toLowerCase(), x.price, x.percent, x.code].join('|');
  const seen = new Set(ev.accepted.map(key));
  const merged = {
    accepted: ev.accepted.concat(o.accepted.filter((x) => !seen.has(key(x)))),
    rejected: ev.rejected.concat(o.rejected).filter((x, i, arr) => arr.findIndex((y) => y.what === x.what && y.why === x.why) === i),
    stale: (ev.stale || []).concat(o.stale),
    undated: (ev.undated || []).concat(o.undated || []).filter((x, i, arr) => arr.findIndex((y) => y.key === x.key) === i).slice(0, 4),
    proof: { pages: ((ev.proof || {}).pages || 0) + o.proof.pages, sites: ((ev.proof || {}).sites || 0) + o.proof.sites, rejected: 0 },
    pass2: true,
  };
  merged.proof.rejected = merged.rejected.length;
  return merged;
}

module.exports = { OFFER_KINDS, hasOffers, cacheKeyFor, research, merge, logDebug };
