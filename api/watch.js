'use strict';
// Price watches.
//   POST /api/watch  {action:'add', candidate, email?, marketing?, visitor, country?, hp}   start watching a product
//   POST /api/watch  {action:'list'} | {action:'remove', id}                                 Pro: my watches
//   GET|POST /api/watch?a=confirm&t=<token>                                                  confirm a watch (GET shows a page with a button, POST does it)
//   GET|POST /api/watch?a=stop&w=<id>&i=<item>&s=<sig>                                       stop one watch (signed link from the alert email)
//   GET|POST /api/watch?a=unsub&w=<id>&s=<sig>                                               stop all alerts (also the List-Unsubscribe one-click target)
// A free watch needs the email owner to confirm (double opt-in). A signed-in Pro customer is already verified, so it starts at once.
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, pickCountry } = require('./_lib/util');
const { within } = require('./_lib/limits');
const { bump, isKilled } = require('./_lib/spend');
const { sendEmail, watchConfirmEmail } = require('./_lib/email');
const PRO = require('./_lib/pro');
const W = require('./_lib/watch');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const ID_RE = /^[a-f0-9]{32}$/;
const ITEM_RE = /^[a-f0-9]{10}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, code, title, body, form) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(title) + ' | Zroppix</title></head>'
    + '<body style="margin:0;background:#0D0D14;color:#eee;font-family:system-ui,sans-serif"><div style="max-width:480px;margin:12vh auto;padding:0 20px"><div style="font-weight:800;color:#C9A84C;font-size:20px;margin-bottom:18px">Zroppix</div>'
    + '<h1 style="font-size:22px;margin:0 0 12px">' + esc(title) + '</h1><p style="line-height:1.6;color:#ccc">' + body + '</p>'
    + (form ? '<form method="post" action="' + esc(form.action) + '"><button type="submit" style="background:#C9A84C;color:#0D0D14;font-weight:700;border:0;border-radius:8px;padding:13px 20px;font-size:16px;cursor:pointer">' + esc(form.label) + '</button></form>' : '')
    + '<p style="margin-top:28px"><a href="/find" style="color:#C9A84C">Back to Find it for less</a></p></div></body></html>');
}

async function linkActions(req, res, q) {
  const c = cfg();
  const post = req.method === 'POST';
  const a = clean(q.a, 8);
  const here = '/api/watch?' + Object.entries(q).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  if (a === 'confirm') {
    const t = clean(q.t, 64);
    if (!TOKEN_RE.test(t)) return page(res, 400, 'This link does not work', 'The link is incomplete. Open it again from the email.');
    const rec = await store.getJson('wpend:' + t);
    if (!rec) return page(res, 404, 'This link has expired', 'Confirmation links work for 7 days and once. Start the watch again from the Find it for less page.');
    if (!post) return page(res, 200, 'Start watching ' + rec.item.name + '?', 'We will search for it again every day for ' + (c.watchDaysFree) + ' days and email <b>' + esc(rec.email) + '</b> once when a dated offer passes our checks.', { action: here, label: 'Yes, watch it' });
    await store.del('wpend:' + t);
    const id = W.subId(rec.email); const now = Date.now();
    const sub = (await W.getSub(id)) || { email: rec.email, plan: 'free', created: now, items: [] };
    sub.unsubscribed = false;
    const r = await W.addItem(sub, rec.item, now);
    if (r.error === 'limit') return page(res, 200, 'You are already watching a product', 'The free plan watches ' + c.watchFreeItems + ' product at a time. Stop the other one with the link in its emails, or <a href="/lifetime" style="color:#C9A84C">get Pro to watch up to ' + c.watchProItems + '</a>.');
    if (rec.marketing && !sub.marketing) sub.marketing = { ts: new Date().toISOString() };
    await W.saveSub(id, sub);
    bump('watch_confirmed');
    return page(res, 200, 'We are watching ' + rec.item.name, 'Nothing is sent until a real, dated offer passes our checks. Every email has a link to stop.');
  }
  const id = clean(q.w, 40); const s = clean(q.s, 64);
  if (a === 'stop' || a === 'unsub') {
    const item = clean(q.i, 20);
    const valid = ID_RE.test(id) && (a === 'unsub' ? W.sigOk(s, 'unsub', id) : ITEM_RE.test(item) && W.sigOk(s, 'stop', id, item));
    if (!valid) return page(res, 400, 'This link does not work', 'The link is incomplete or was changed. Use the link from the email.');
    if (!post) return page(res, 200, a === 'unsub' ? 'Stop all alerts?' : 'Stop watching this product?', a === 'unsub' ? 'You will not get any more Zroppix price alerts.' : 'You will not get any more emails about this product.', { action: here, label: a === 'unsub' ? 'Unsubscribe from all alerts' : 'Stop watching' });
    const sub = await W.getSub(id);
    if (sub) {
      if (a === 'unsub') { sub.unsubscribed = true; sub.items = []; sub.marketing = null; } else { sub.items = (sub.items || []).map((it) => (it.id === item ? Object.assign({}, it, { stopped: true }) : it)); }
      await W.saveSub(id, sub);
    }
    bump(a === 'unsub' ? 'watch_unsub' : 'watch_stop');
    return page(res, 200, a === 'unsub' ? 'You are unsubscribed' : 'Stopped', a === 'unsub' ? 'No more price alerts will be sent to this address.' : 'We stopped watching that product.');
  }
  return page(res, 404, 'Not found', 'This page does not exist.');
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams.entries());
  try {
    if (q.a) {
      if (req.method !== 'GET' && req.method !== 'POST') return page(res, 405, 'Not allowed', '');
      if (!(await within('watchlink', ipHash(req), 60, 'hour'))) return page(res, 429, 'Slow down', 'Too many requests. Please try again in a little while.');
      return await linkActions(req, res, q);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const action = clean(body.action, 10);
    const c = cfg();
    if (!c.salt) return send(res, 503, { error: 'unavailable' });
    const who = await PRO.whoIs(req).catch(() => null);
    const pro = !!(who && who.pro);

    if (action === 'list' || action === 'remove') {
      if (!pro) return send(res, 401, { error: 'not_pro' });
      const id = W.subId(who.email); const sub = await W.getSub(id);
      if (action === 'remove') {
        const item = clean(body.id, 20);
        if (sub && ITEM_RE.test(item)) { sub.items = (sub.items || []).map((it) => (it.id === item ? Object.assign({}, it, { stopped: true }) : it)); await W.saveSub(id, sub); }
      }
      const items = W.activeItems(sub, Date.now()).map((it) => ({ id: it.id, name: it.name, variant: it.variant, created: it.created, expires: it.expires, last: it.last ? { price: it.last.price, store: it.last.store, ts: it.last.ts } : null }));
      return send(res, 200, { ok: true, items, limit: c.watchProItems });
    }
    if (action !== 'add') return send(res, 400, { error: 'bad_action' });

    if (await isKilled()) return send(res, 503, { error: 'paused' });
    const visitor = validVisitor(body.visitor);
    if (!visitor) return send(res, 400, { error: 'bad_visitor' });
    const ip = ipHash(req);
    if (!(await within('watchadd', ip, c.watchAddPerIpHour, 'hour'))) return send(res, 429, { error: 'slow_down' });
    if (body.hp) return send(res, 200, { ok: true, mode: 'confirm' }); // honeypot
    const cand = body.candidate && typeof body.candidate === 'object' ? body.candidate : {};
    const name = clean(cand.name, 100); const variant = clean(cand.variant, 50);
    if (name.length < 2) return send(res, 400, { error: 'no_product' });
    const country = pickCountry(req, body);
    const base = await W.baselineFor({ name, variant }, country);
    const now = Date.now();
    const label = name + (variant ? ' (' + variant + ')' : '');

    if (pro) {
      const id = W.subId(who.email);
      const sub = (await W.getSub(id)) || { email: who.email, created: now, items: [] };
      sub.plan = 'pro'; sub.unsubscribed = false;
      const r = await W.addItem(sub, { name, variant, country, base }, now);
      if (r.error === 'limit') return send(res, 200, { ok: false, error: 'limit', limit: c.watchProItems });
      await W.saveSub(id, sub);
      bump('watch_added_pro');
      return send(res, 200, { ok: true, mode: 'direct', already: !!r.already, email: PRO.mask(who.email) });
    }

    const email = PRO.normEmail(body.email);
    if (!PRO.EMAIL_RE.test(email)) return send(res, 400, { error: 'bad_email' });
    if (!(await within('watchmail', W.subId(email), 3, 'hour')) || !(await within('watchmaild', W.subId(email), 5, 'day'))) return send(res, 200, { ok: true, mode: 'confirm' }); // same answer; no extra emails to one address
    const token = crypto.randomBytes(24).toString('base64url');
    await store.setJson('wpend:' + token, { email, item: { name, variant, country, base }, marketing: body.marketing === true }, 7 * 86400);
    bump('watch_requested');
    const m = watchConfirmEmail({ link: c.siteUrl + '/api/watch?a=confirm&t=' + token, name: label, days: c.watchDaysFree });
    const r = await sendEmail({ to: email, subject: m.subject, html: m.html, text: m.text });
    if (!r.ok) return send(res, 503, { error: 'email_unavailable' });
    return send(res, 200, { ok: true, mode: 'confirm' });
  } catch (e) {
    return send(res, 503, { error: 'unavailable' });
  }
};
