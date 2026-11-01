'use strict';
// GET /api/official?name=<product>&url=<brand page>   (header: Authorization: Bearer <FIND_ADMIN_TOKEN>)
// Owner-only dry run of the manufacturer-page reader: loads the page now and shows what would (or would not) be accepted, and why. Nothing is stored or emailed.
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const { send, sha, clean } = require('./_lib/util');
const OFC = require('./_lib/official');
const ai = require('./_lib/anthropic');

module.exports = async (req, res) => {
  const c = cfg();
  if (!c.adminToken) return send(res, 404, { error: 'not_found' });
  const got = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!got || !crypto.timingSafeEqual(Buffer.from(sha(got)), Buffer.from(sha(c.adminToken)))) return send(res, 401, { error: 'unauthorized' });
  const q = new URL(req.url, 'https://x').searchParams;
  const name = clean(q.get('name'), 120), url = clean(q.get('url'), 500);
  if (!name || !url) return send(res, 400, { error: 'need name and url' });
  const t0 = Date.now();
  const out = await OFC.collect({ product: { name, variant: '' }, country: 'US', results: [{ url, title: '' }], forceUrls: [url], now: new Date(), maxPages: 1, budgetMs: 9000,
    callAi: async ({ system, user }) => { const r = await ai.call({ model: c.matchModel, system, messages: [{ role: 'user', content: user }], maxTokens: 500, deadline: Date.now() + 15000 }); return { text: r.text, costUsd: r.costUsd }; } });
  return send(res, 200, { brand: OFC.brandOf(name), ms: Date.now() - t0, costUsd: out.costUsd, findings: out.findings, tried: out.tried });
};
