'use strict';
// POST /api/pro
//   {action:'status'}                 -> who is signed in on this browser (cookie), and whether they have Pro
//   {action:'login', email, hp, q, v} -> emails a one-time sign-in link, but only if the email has an active plan.
//                                        q/v (optional) = the product being looked at; the link then searches it again after sign-in.
//                                        The answer is the same either way, so this cannot be used to find customers.
//   {action:'claim', token}           -> the sign-in link was opened: one use, 15 minutes, starts a session (HttpOnly cookie)
//   {action:'logout'}                 -> ends this browser's session
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, sha } = require('./_lib/util');
const { within } = require('./_lib/limits');
const { bump } = require('./_lib/spend');
const { sendEmail, proLoginEmail } = require('./_lib/email');
const P = require('./_lib/pro');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const action = clean(body.action, 10);
  const c = cfg();
  try {
    const ip = ipHash(req);

    if (action === 'status') {
      if (!(await within('prostatus', ip, 200, 'hour'))) return send(res, 429, { error: 'slow_down' });
      const w = await P.whoIs(req);
      if (!w.signedIn) return send(res, 200, { pro: false, signedIn: false });
      return send(res, 200, { pro: !!w.pro, signedIn: true, expired: !!w.expired, unverified: !!w.unverified, email: P.mask(w.email), plan: w.plan || null });
    }

    if (action === 'logout') {
      await P.endSession(req);
      res.setHeader('Set-Cookie', P.cookieHeader(req, '', 0));
      return send(res, 200, { ok: true });
    }

    if (action === 'login') {
      if (!(await within('prologin', ip, c.proLoginPerIpHour, 'hour'))) return send(res, 429, { error: 'slow_down' });
      if (body.hp) return send(res, 200, { ok: true }); // honeypot: pretend success
      const email = P.normEmail(body.email);
      if (!P.EMAIL_RE.test(email)) return send(res, 400, { error: 'bad_email' });
      const eh = sha(email);
      if (!(await within('prologine', eh, c.proLoginPerEmailHour, 'hour'))) return send(res, 429, { error: 'slow_down' });
      const plan = await P.lookupPlan(email, !!body.afterPay);
      if (!plan.ok) return send(res, 503, { error: 'unavailable' });
      if (plan.pro) {
        // Retries right after payment (the plan can take a few seconds to appear) must not send the same email twice.
        if (body.afterPay && await store.getJson('plsent:' + eh)) return send(res, 200, { ok: true });
        const q = clean(body.q, 120).replace(/[<>"`]/g, ''), v = clean(body.v, 60).replace(/[<>"`]/g, '');
        const token = P.newToken(24);
        await store.setJson('ptok:' + token, { eh, email, ts: Date.now() }, 900);
        const qs = q.length > 1 ? '?q=' + encodeURIComponent(q) + (v ? '&v=' + encodeURIComponent(v) : '') + '&go=1' : '';
        const m = proLoginEmail(c.siteUrl + '/find' + qs + '#pro=' + token, q.length > 1 ? q + (v ? ' ' + v : '') : '');
        const r = await sendEmail({ to: email, subject: m.subject, html: m.html, text: m.text });
        if (!r.ok) return send(res, 503, { error: 'email_unavailable' });
        if (body.afterPay) await store.setJson('plsent:' + eh, { ts: Date.now() }, 60);
        bump('pro_login_sent');
      } else bump('pro_login_nopro');
      return send(res, 200, { ok: true });
    }

    if (action === 'claim') {
      if (!(await within('proclaim', ip, 20, 'hour'))) return send(res, 429, { error: 'slow_down' });
      const token = clean(body.token, 64);
      if (!TOKEN_RE.test(token)) return send(res, 400, { error: 'bad_token' });
      const rec = await store.getJson('ptok:' + token);
      if (!rec || !rec.email) return send(res, 404, { error: 'expired' });
      // One use only. Increment first so two simultaneous requests cannot both win.
      const n = await store.incrBy('ptu:' + token, 1);
      if (n === 1) await store.expire('ptu:' + token, 1800);
      if (n !== 1) return send(res, 409, { error: 'already_used' });
      const plan = await P.lookupPlan(rec.email);
      if (!plan.ok) return send(res, 503, { error: 'unavailable' });
      if (!plan.pro) { bump('pro_claim_nopro'); return send(res, 403, { error: 'not_pro' }); }
      const s = await P.createSession(rec.email);
      res.setHeader('Set-Cookie', P.cookieHeader(req, s.token, s.maxAge));
      bump('pro_signin');
      return send(res, 200, { ok: true, pro: true, email: P.mask(rec.email), plan: plan.plan });
    }

    return send(res, 400, { error: 'bad_action' });
  } catch (e) {
    return send(res, 503, { error: 'unavailable' });
  }
};
