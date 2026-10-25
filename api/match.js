'use strict';
// POST /api/match  {q, visitor}  ->  up to 3 candidate products. Free for the user; costs us a fraction of a cent.
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, normName, sha, pickCountry } = require('./_lib/util');
const { isKilled, reserve, settle, bump, trackSource, trackVisitor, trackCountry } = require('./_lib/spend');
const { within, allowance } = require('./_lib/limits');
const ai = require('./_lib/anthropic');
const P = require('./_lib/prompts');

function cleanCandidates(j) {
  const out = [];
  for (const c of (j && Array.isArray(j.candidates) ? j.candidates : []).slice(0, 3)) {
    const name = clean(c && c.name, 90);
    if (name.length < 2) continue;
    out.push({ name, variant: clean(c.variant, 50), kind: clean(c.kind, 40), note: clean(c.note, 70) });
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const q = clean(body.q, 200);
  const visitor = validVisitor(body.visitor);
  if (q.length < 2) return send(res, 400, { error: 'too_short' });
  if (!visitor) return send(res, 400, { error: 'bad_visitor' });
  const c = cfg();
  try {
    if (await isKilled()) return send(res, 503, { error: 'paused' });
    const ip = ipHash(req);
    if (!(await within('match', ip, c.matchPerHour, 'hour')) || !(await within('matchd', ip, c.matchPerDay, 'day'))) return send(res, 429, { error: 'slow_down' });

    bump('queries'); await trackSource(body.ref); await trackVisitor('uv', visitor); await trackCountry(pickCountry(req, body), 's');
    // Every answer also says how many checks this visitor has left and which country we guessed.
    const al = await allowance(visitor);
    const meta = { remaining: { left: al.left, total: al.total }, country: pickCountry(req, body) };
    const reply = (code, obj) => send(res, code, Object.assign({}, obj, meta));
    const key = 'm:' + sha(normName(q));
    const hit = await store.getJson(key);
    if (hit) { bump('match_cache'); return reply(200, Object.assign({ cached: true }, hit)); }

    // The shopper's own words are always a valid last-resort candidate, so the flow never dead-ends.
    const asTyped = [{ name: clean(q, 90), variant: '', kind: '', note: 'As you typed it' }];
    const ticket = await reserve(c.reserveMatchUsd);
    if (!ticket) return reply(200, { candidates: asTyped, degraded: true });
    let r;
    try {
      r = await ai.call({ model: c.matchModel, system: P.MATCH_SYSTEM, messages: [{ role: 'user', content: P.matchUser(q) }], maxTokens: 2000, deadline: Date.now() + 20000 });
    } catch (e) {
      await settle(ticket, 0);
      bump('match_ai_error');
      return reply(200, { candidates: asTyped, degraded: true });
    }
    await settle(ticket, r.costUsd);
    bump('match_ai'); bump('cost_micro', Math.round(r.costUsd * 1e6));
    const j = ai.extractJson(r.text);
    if (!j) return reply(200, { candidates: asTyped, degraded: true });
    const out = { candidates: cleanCandidates(j), notProduct: j.not_a_product === true, ambiguous: j.ambiguous === true, vague: j.vague === true };
    if (out.candidates.length < 2) out.vague = false;
    if (!out.candidates.length && !out.notProduct) out.candidates = asTyped;
    await store.setJson(key, out, 24 * 3600);
    return reply(200, out);
  } catch (e) {
    return send(res, 503, { error: 'unavailable' });
  }
};
