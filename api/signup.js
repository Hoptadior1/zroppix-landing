'use strict';
// POST /api/signup
//   {action:'bonus',    email, visitor, hp}  -> sends a confirmation link; confirming adds extra free checks
//   {action:'waitlist', email, visitor, hp}  -> Pro waitlist, one email when Pro opens
//   {action:'claim',    token, visitor}      -> called by /find when the confirmation link is opened
const crypto = require('crypto');
const { cfg } = require('./_lib/config');
const store = require('./_lib/store');
const { send, readBody, sameSite, ipHash, clean, validVisitor, sha } = require('./_lib/util');
const { within, addBonus } = require('./_lib/limits');
const { bump } = require('./_lib/spend');
const { sendEmail, confirmEmail, waitlistEmail } = require('./_lib/email');

const EMAIL_RE = /^[^\s@<>()\[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Emails that hit a rate limit are retried later instead of being lost.
async function drainQueue() {
  for (let i = 0; i < 3; i++) {
    const raw = await store.rpop('mailq');
    if (!raw) return;
    let job; try { job = JSON.parse(raw); } catch (_) { continue; }
    const m = job.kind === 'waitlist' ? waitlistEmail() : confirmEmail(cfg().siteUrl + '/find?confirm=' + job.token, cfg().emailBonus);
    const r = await sendEmail({ to: job.to, subject: m.subject, html: m.html, text: m.text });
    if (!r.ok && r.retry) { await store.lpush('mailq', raw); return; }
  }
}

// One bonus per person, not per spelling: Gmail ignores dots and +tags, and most providers ignore +tags.
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'emailondeck.com', 'mohmal.com', 'tempail.com', 'burnermail.io', 'mailnesia.com', 'spamgourmet.com', 'moakt.com', 'tmpmail.org', 'inboxkitten.com']);
function canonEmail(email) {
  const at = email.lastIndexOf('@'); if (at < 1) return email;
  let local = email.slice(0, at), dom = email.slice(at + 1);
  if (dom === 'googlemail.com') dom = 'gmail.com';
  local = local.split('+')[0];
  if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + dom;
}
function isDisposable(email) { return DISPOSABLE.has(email.slice(email.lastIndexOf('@') + 1)); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!sameSite(req)) return send(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const action = clean(body.action, 12);
  const visitor = validVisitor(body.visitor);
  if (!visitor) return send(res, 400, { error: 'bad_visitor' });
  const c = cfg();
  try {
    const ip = ipHash(req);
    if (!(await within('signup', ip, c.signupPerIpHour, 'hour'))) return send(res, 429, { error: 'slow_down' });

    if (action === 'claim') {
      const token = clean(body.token, 64);
      if (!TOKEN_RE.test(token)) return send(res, 400, { error: 'bad_token' });
      const rec = await store.getJson('tok:' + token);
      if (!rec || rec.kind !== 'bonus') return send(res, 404, { error: 'expired' });
      if (rec.claimed) return send(res, 200, { ok: true, already: true });
      // One bonus per email address, ever.
      const first = await store.incrBy('emb:' + rec.h, 1);
      if (first !== 1) { await store.setJson('tok:' + token, Object.assign(rec, { claimed: true }), 7 * 86400); return send(res, 200, { ok: false, error: 'already_used' }); }
      await store.setJson('tok:' + token, Object.assign(rec, { claimed: true }), 7 * 86400);
      await addBonus(visitor, c.emailBonus);
      bump('bonus_claimed');
      return send(res, 200, { ok: true, added: c.emailBonus });
    }

    if (action !== 'bonus' && action !== 'waitlist') return send(res, 400, { error: 'bad_action' });
    if (body.hp) return send(res, 200, { ok: true }); // honeypot field filled in: pretend success
    const email = clean(body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'bad_email' });
    const h = sha(email);
    if (action === 'bonus' && isDisposable(email)) return send(res, 400, { error: 'disposable' });
    const hb = sha(canonEmail(email)); // identity used for the one-bonus-per-person rule

    await drainQueue();

    if (action === 'waitlist') {
      const isNew = await store.hget('wl', h);
      if (!isNew) {
        await store.hset('wl', h, JSON.stringify({ email, ts: new Date().toISOString() }));
        bump('waitlist');
        const m = waitlistEmail();
        const r = await sendEmail({ to: email, subject: m.subject, html: m.html, text: m.text });
        if (!r.ok && r.retry) await store.lpush('mailq', JSON.stringify({ kind: 'waitlist', to: email }));
      }
      return send(res, 200, { ok: true }); // same answer whether or not the address was already listed
    }

    // bonus: send a confirmation link. The bonus is granted only when the link is opened.
    const token = crypto.randomBytes(24).toString('base64url');
    await store.setJson('tok:' + token, { kind: 'bonus', h: hb, ts: Date.now() }, 7 * 86400);
    await store.hset('emails', h, JSON.stringify({ email, ts: new Date().toISOString() }));
    bump('bonus_requested');
    const link = c.siteUrl + '/find?confirm=' + token;
    const m = confirmEmail(link, c.emailBonus);
    const r = await sendEmail({ to: email, subject: m.subject, html: m.html, text: m.text });
    if (!r.ok && r.retry) { await store.lpush('mailq', JSON.stringify({ kind: 'bonus', to: email, token })); return send(res, 200, { ok: true, queued: true }); }
    if (!r.ok) return send(res, 503, { error: 'email_unavailable' });
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, 503, { error: 'unavailable' });
  }
};
