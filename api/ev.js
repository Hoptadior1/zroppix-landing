'use strict';
// POST /api/ev  {ev:'offer_click'|...}  -> counts one step of the funnel for the owner's stats page.
// Anonymous: only the event name, the page tag and the traffic-source tag are counted. Unknown names are ignored. Rate limited per network address.
const { send, readBody, sameSite, ipHash } = require('./_lib/util');
const { within } = require('./_lib/limits');
const { bump, trackFunnel } = require('./_lib/spend');

const EVENTS = new Set(['offer_click', 'pro_click', 'pro_view', 'checkout_loaded', 'checkout_paid', 'watch_added', 'signin_click', 'box_view', 'search', 'found', 'nothing', 'limit', 'return_after_limit']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readBody(req);
    const ev = String(body.ev || '');
    if (!EVENTS.has(ev)) return send(res, 200, { ok: true });
    if (!(await within('ev', ipHash(req), 200, 'hour'))) return send(res, 200, { ok: true });
    await bump('ev_' + ev);
    // Which page and which kind of visitor (first-touch traffic source) this step belongs to.
    const pg = String(body.pg || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'unknown';
    const tr = /^[a-z0-9:._-]{1,45}$/.test(String(body.tr || '')) ? String(body.tr) : 'unknown';
    await trackFunnel(pg, tr, ev, body.al === 1 || body.al === true);
  } catch (_) { /* never an error for a counter */ }
  return send(res, 200, { ok: true });
};
