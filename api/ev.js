'use strict';
// POST /api/ev  {ev:'offer_click'|...}  -> counts one step of the funnel for the owner's stats page.
// Anonymous: only the event name is counted. Unknown names are ignored. Rate limited per network address.
const { send, readBody, sameSite, ipHash } = require('./_lib/util');
const { within } = require('./_lib/limits');
const { bump } = require('./_lib/spend');

const EVENTS = new Set(['offer_click', 'pro_click', 'pro_view', 'checkout_loaded', 'checkout_paid', 'watch_added', 'signin_click']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readBody(req);
    const ev = String(body.ev || '');
    if (!EVENTS.has(ev)) return send(res, 200, { ok: true });
    if (!(await within('ev', ipHash(req), 200, 'hour'))) return send(res, 200, { ok: true });
    await bump('ev_' + ev);
  } catch (_) { /* never an error for a counter */ }
  return send(res, 200, { ok: true });
};
