'use strict';
// Pro customers: who they are (asked of the Zroppix backend), sign-in links, sessions.
// Security rules in this file:
//  - a plan is only trusted from the backend, never from the browser
//  - sign-in needs a one-time link sent to the paid email, so typing someone else's email gets nothing
//  - the browser holds only a random session token in an HttpOnly cookie; we store its hash
//  - at most N devices per customer (oldest is signed out), and plan changes are picked up within an hour
const crypto = require('crypto');
const { cfg } = require('./config');
const store = require('./store');
const { sha, clean } = require('./util');

const EMAIL_RE = /^[^\s@<>()\[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE = 'zx_pro';

const newToken = (bytes) => crypto.randomBytes(bytes || 32).toString('base64url');
const normEmail = (e) => clean(e, 254).toLowerCase();
const mask = (e) => { const [u, d] = String(e).split('@'); return (u ? u[0] : '') + '***@' + (d || ''); };

// Ask the backend what plan an email has. Returns {ok, pro, plan}. ok=false means "could not find out".
async function lookupPlan(email) {
  const c = cfg();
  const eh = sha(email);
  const ck = 'pplan:' + eh;
  const cached = await store.getJson(ck);
  if (cached) return cached;
  let data;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4500);
    const r = await fetch(c.backendUrl + '/api/payments/plan?email=' + encodeURIComponent(email), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return { ok: false };
    data = await r.json();
  } catch (_) { return { ok: false }; }
  if (!data || typeof data !== 'object') return { ok: false };
  const plan = clean(data.plan, 20).toLowerCase();
  const exp = data.expires_at ? Date.parse(data.expires_at) : null;
  const expired = exp != null && Number.isFinite(exp) && exp < Date.now();
  // If the backend names an email, it must be the one we asked about.
  const mismatch = data.email && normEmail(data.email) !== email;
  const pro = !mismatch && !expired && c.proPlans.includes(plan);
  const out = { ok: true, pro, plan: pro ? plan : 'free' };
  await store.setJson(ck, out, pro ? 3600 : 300);
  return out;
}

function readCookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function cookieHeader(req, value, maxAgeSec) {
  const host = String((req.headers && req.headers.host) || '');
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  return COOKIE + '=' + value + '; Path=/api; Max-Age=' + maxAgeSec + '; HttpOnly; SameSite=Lax' + (local ? '' : '; Secure');
}

async function createSession(email) {
  const c = cfg();
  const token = newToken(32); const th = sha(token); const eh = sha(email);
  const ttl = Math.round(c.proSessionDays * 86400);
  await store.setJson('ps:' + th, { eh, email, ts: Date.now() }, ttl);
  await store.lpush('psl:' + eh, th);
  await store.expire('psl:' + eh, ttl);
  const list = (await store.lrange('psl:' + eh, 0, -1)) || [];
  if (list.length > c.proDevices) {
    for (const old of list.slice(c.proDevices)) await store.del('ps:' + old);
    await store.ltrim('psl:' + eh, 0, c.proDevices - 1);
  }
  return { token, maxAge: ttl };
}

async function endSession(req) {
  const token = readCookie(req, COOKIE);
  if (!SESSION_RE.test(token)) return;
  const th = sha(token);
  const rec = await store.getJson('ps:' + th);
  await store.del('ps:' + th);
  if (rec && rec.eh) {
    const list = ((await store.lrange('psl:' + rec.eh, 0, -1)) || []).filter((x) => x !== th);
    await store.del('psl:' + rec.eh);
    for (const x of list.slice().reverse()) await store.lpush('psl:' + rec.eh, x);
  }
}

// Who is this request? {signedIn, pro, email, eh, unverified, expired}
async function whoIs(req) {
  const token = readCookie(req, COOKIE);
  if (!SESSION_RE.test(token)) return { signedIn: false, pro: false };
  const rec = await store.getJson('ps:' + sha(token));
  if (!rec || !rec.email) return { signedIn: false, pro: false };
  const plan = await lookupPlan(rec.email);
  if (!plan.ok) return { signedIn: true, pro: false, unverified: true, email: rec.email, eh: rec.eh };
  return { signedIn: true, pro: plan.pro, expired: !plan.pro, plan: plan.plan, email: rec.email, eh: rec.eh };
}

module.exports = { EMAIL_RE, SESSION_RE, COOKIE, newToken, normEmail, mask, lookupPlan, readCookie, cookieHeader, createSession, endSession, whoIs };
