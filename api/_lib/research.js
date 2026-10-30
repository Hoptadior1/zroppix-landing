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
async function research({ product, country, pass, started, now, source }) {
  const c = cfg();
  now = now || new Date(); started = started || Date.now();
  const ticket = await reserve(c.reserveCheckUsd);
  if (!ticket) return { busy: true };
  let cost = 0; let settled = false;
  const done = async () => { if (!settled) { settled = true; await settle(ticket, cost); } };
  try {
    // The searches, and the stores' own product data, all start at the same moment.
    const today = now.toISOString().slice(0, 10);
    const split = c.parallelGather && pass !== 2 && c.maxSearches >= 2; // pass 2 keeps its own wording
    const per = split ? Math.max(2, Math.ceil(c.maxSearches / 2)) : c.maxSearches;
    const userMsg = (pass === 2 ? P.gatherUser2 : P.gatherUser)(product, country, today);
    const run = (focus) => ai.call({
      model: c.gatherModel, system: P.GATHER_SYSTEM,
      messages: [{ role: 'user', content: userMsg + (focus || '') }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: per, user_location: { type: 'approximate', country } }],
      maxTokens: 12000, deadline: started + 38000,
    });
    const apiP = pass === 2 ? Promise.resolve({ findings: [], results: [] }) : S.fetchAll(product, country, now);
    const runs = await Promise.allSettled(split ? [run(P.FOCUS_PRICES), run(P.FOCUS_EXTRAS)] : [run('')]);
    const api = await apiP;
    const okRuns = runs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
    if (!okRuns.length) { await done(); bump('check_ai_error'); return { failed: true }; }
    const gather = {
      text: okRuns.map((g) => g.text).join('\n'), costUsd: okRuns.reduce((n, g) => n + g.costUsd, 0),
      results: okRuns.reduce((a, g) => a.concat(g.results), []), searchErrors: okRuns.reduce((n, g) => n + g.searchErrors, 0) + (split ? runs.length - okRuns.length : 0),
      stop: okRuns[0].stop, blockTypes: okRuns[0].blockTypes,
      usage: { server_tool_use: { web_search_requests: okRuns.reduce((n, g) => n + ((g.usage.server_tool_use || {}).web_search_requests || 0), 0) } },
    };
    cost += gather.costUsd;
    const searchErr = gather.searchErrors > 0;
    let ok = false; let rawFindings = [];
    okRuns.forEach((g, k) => {
      const gj = ai.extractJson(g.text);
      if (gj && Array.isArray(gj.findings)) {
        ok = true;
        gj.findings.slice(0, split ? 8 : 12).forEach((x, n) => rawFindings.push(x && typeof x === 'object' ? Object.assign({}, x, { id: (pass === 2 ? 'p2_' : split ? 'w' + (k + 1) + '_' : '') + (n + 1) }) : x));
      }
    });
    if (api.findings.length) { ok = true; rawFindings = rawFindings.concat(api.findings); bump('api_findings', api.findings.length); }
    const norm = rawFindings.map((x, i) => R.normalizeFinding(x, i));
    let verdicts = {}; let didJudge = true;
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
        for (const f of norm) if (!verdicts[f.id]) verdicts[f.id] = { same_product: false, verdict: 'reject', reason: 'not confirmed by the second check' };
      } catch (e) { didJudge = false; verdicts = {}; }
    }
    await done();
    bump(source === 'watch' ? 'watch_ai' : 'check_ai'); bump('cost_micro', Math.round(cost * 1e6)); bump('searches', (gather.usage.server_tool_use || {}).web_search_requests || 0);
    if (pass === 2 && source !== 'watch') bump('check_pass2');
    const out = R.evaluate(rawFindings, { now, maxAgeDays: c.maxAgeDays, staleMaxDays: c.staleMaxDays, cashbackMaxDays: c.cashbackMaxDays, results: gather.results.concat(api.results), judge: verdicts });
    out.proof = { pages: gather.results.length, sites: new Set(gather.results.map((r) => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }).filter(Boolean)).size, rejected: out.rejected.length };
    await logDebug({ t: now.toISOString(), pass, source: source || 'check', product: product.name + (product.variant ? ' / ' + product.variant : ''), country, stop: gather.stop, blocks: gather.blockTypes, usage: gather.usage, searches: (gather.usage.server_tool_use || {}).web_search_requests || 0, searchErrors: gather.searchErrors,
      results: gather.results.length, resultUrls: gather.results.slice(0, 8).map((r) => r.url), textLen: gather.text.length, textHead: gather.text.slice(0, 700), textTail: gather.text.slice(-300),
      parsed: ok, findings: rawFindings.length, accepted: out.accepted.length, undated: (out.undated || []).length, rejected: out.rejected.slice(0, 8), judged: didJudge, costUsd: Math.round(cost * 10000) / 10000 });
    return { out, ok, didJudge, searchErr, hadResults: gather.results.length > 0, costUsd: cost };
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
