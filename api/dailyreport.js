'use strict';
// GET|POST /api/dailyreport   Vercel Cron calls this once a day (Authorization: Bearer <CRON_SECRET>).
// Emails the owner a summary of yesterday (UTC) and flags anything that looks wrong.
//   ?preview=1  returns the report without sending it (owner token required)
//   ?force=1    sends even if yesterday's report was already sent
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, sha } = require('./_lib/util');
const { sendEmail } = require('./_lib/email');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const eq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
function authorised(req) {
  const c = cfg();
  const got = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  return (c.cronSecret && eq(got, c.cronSecret)) || (c.adminToken && eq(got, c.adminToken));
}
function pairs(arr) { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0; return o; }

async function build(day) {
  const c = cfg();
  const s = pairs(await store.hgetall('stat:' + day));
  const l = pairs(await store.hgetall('lat:' + day));
  const spend = (Number(await store.get('spend:' + day)) || 0) / 1e6;
  const people = await store.hlen('uv:' + day);
  const shown = s.check_ok || 0;
  const checks = shown + (s.check_fallback || 0) + (s.check_unreadable || 0);
  const found = checks ? Math.round((100 * shown) / checks) : null;
  const avg = l.n ? Math.round(l.sum / l.n / 100) / 10 : null;
  const slow = Math.round((l.max || 0) / 100) / 10;
  const why = { nothing: s.why_nooffers || 0, searchError: s.why_searcherr || 0, unreadable: s.why_unreadable || 0, busy: s.why_busy || 0 };
  const wanted = (s.limit_checks || 0) + (s.limit_ip || 0);
  const funnel = { searches: s.searches || 0, checks, found: shown, offerClicks: s.ev_offer_click || 0, proClicks: s.ev_pro_click || 0, checkoutOpened: s.ev_checkout_loaded || 0, paid: s.ev_checkout_paid || 0 };
  const flags = [];
  if (spend >= c.dailyCapUsd * 0.8) flags.push('AI spend reached ' + Math.round((100 * spend) / c.dailyCapUsd) + '% of the daily cap ($' + spend.toFixed(2) + ' of $' + c.dailyCapUsd + ').');
  if (why.busy > 0) flags.push(why.busy + ' check(s) were refused because the daily spend cap was reached. Visitors saw "busy".');
  const failed = why.searchError + why.unreadable;
  if (checks >= 5 && failed / checks > 0.2) flags.push('More than 20% of checks failed on our side (' + failed + ' of ' + checks + '). Check the Anthropic key and credit.');
  if (avg != null && avg > 30) flags.push('Checks are slow: average ' + avg + ' s. Visitors tend to leave before 30 s.');
  if (checks >= 8 && found != null && found < 35) flags.push('Only ' + found + '% of checks found offers.');
  if ((s.searches || 0) === 0) flags.push('No searches at all yesterday. Check the site and the tool are up.');
  if (funnel.paid > 0) flags.push('Good news: ' + funnel.paid + ' checkout(s) reported as completed. Confirm in Paddle.');
  return { day, people, funnel, found, spend, avg, slow, why, wanted, bonus: { asked: s.bonus_requested || 0, confirmed: s.bonus_claimed || 0 }, flags, bad: flags.some((f) => !/^Good news/.test(f)) };
}

function render(r) {
  const c = cfg();
  const row = (a, b) => '<tr><td style="padding:4px 12px 4px 0;color:#555">' + esc(a) + '</td><td style="padding:4px 0;font-weight:700">' + esc(b) + '</td></tr>';
  const f = r.funnel;
  const html = '<div style="font-family:system-ui,sans-serif;max-width:520px;color:#222"><h2 style="margin:0 0 4px">Find: ' + esc(r.day) + '</h2>'
    + (r.flags.length ? '<div style="background:#fff4e5;border:1px solid #f0b560;border-radius:10px;padding:10px 14px;margin:12px 0"><b>' + (r.bad ? 'Needs a look' : 'Note') + '</b><ul style="margin:6px 0 0;padding-left:18px">' + r.flags.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '<p style="color:#2a7">Nothing looks wrong.</p>')
    + '<table style="border-collapse:collapse;margin:8px 0">'
    + row('People who searched', r.people) + row('Searches', f.searches) + row('Checks finished', f.checks) + row('Found offers', r.found == null ? '-' : r.found + '%')
    + row('Offer clicks', f.offerClicks) + row('Pro button clicks', f.proClicks) + row('Checkout opened', f.checkoutOpened) + row('Checkout completed (browser-reported)', f.paid)
    + row('Ran out of checks / hit daily cap', r.wanted) + row('Asked for bonus / confirmed', r.bonus.asked + ' / ' + r.bonus.confirmed)
    + row('No offers / search failed / unreadable / busy', r.why.nothing + ' / ' + r.why.searchError + ' / ' + r.why.unreadable + ' / ' + r.why.busy)
    + row('Check speed (avg / slowest)', (r.avg == null ? '-' : r.avg + ' s') + ' / ' + r.slow + ' s') + row('AI spend', '$' + r.spend.toFixed(2))
    + '</table><p><a href="' + esc(c.siteUrl) + '/find-stats">Open the full stats page</a></p><p style="color:#888;font-size:12px">Days are in UTC. Payments: check Paddle for the real numbers.</p></div>';
  const text = 'Find ' + r.day + '\n' + (r.flags.length ? r.flags.map((x) => '- ' + x).join('\n') + '\n' : 'Nothing looks wrong.\n')
    + 'People ' + r.people + ' | searches ' + f.searches + ' | checks ' + f.checks + ' | found ' + (r.found == null ? '-' : r.found + '%') + ' | spend $' + r.spend.toFixed(2) + '\n' + c.siteUrl + '/find-stats';
  const subject = (r.bad ? '⚠ ' : '') + 'Find ' + r.day + ': ' + f.searches + ' searches, ' + (r.found == null ? 'no checks' : r.found + '% found') + ', $' + r.spend.toFixed(2);
  return { subject, html, text };
}

module.exports = async (req, res) => {
  if (!authorised(req)) return send(res, 401, { error: 'unauthorized' });
  try {
    const c = cfg();
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const r = await build(day);
    const mail = render(r);
    const url = req.url || '';
    if (/[?&]preview=1/.test(url)) return send(res, 200, { report: r, subject: mail.subject, configured: !!c.alertEmail });
    if (!c.alertEmail) return send(res, 200, { ok: false, error: 'FIND_ALERT_EMAIL is not set' });
    if (!/[?&]force=1/.test(url) && (await store.get('report:' + day))) return send(res, 200, { ok: true, skipped: 'already_sent' });
    const out = await sendEmail({ to: c.alertEmail, subject: mail.subject, html: mail.html, text: mail.text });
    if (out.ok) await store.set('report:' + day, '1', 3 * 86400);
    return send(res, 200, { ok: !!out.ok, error: out.error || undefined, day });
  } catch (e) { return send(res, 503, { error: 'unavailable', detail: String(e && e.message).slice(0, 120) }); }
};
