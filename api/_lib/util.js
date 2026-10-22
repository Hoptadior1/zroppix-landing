'use strict';
const crypto = require('crypto');
const { cfg } = require('./config');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// One-way hash of an IP address with a secret salt. The raw IP is never stored.
function ipHash(req) {
  const xf = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '');
  const ip = xf.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return sha((cfg().salt || 'unsalted') + '|' + ip).slice(0, 24);
}

function today() { return new Date().toISOString().slice(0, 10); }
function hourKey() { return new Date().toISOString().slice(0, 13); }

// Strip control chars and collapse whitespace; cap length. Used on EVERYTHING from users or from the web.
function clean(s, max) {
  if (s == null) return '';
  return String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

function validVisitor(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null; }

const COUNTRIES = new Set(('AE AR AT AU BD BE BR CA CH CL CN CO CZ DE DK EG ES FI FR GB GH GR HK HU ID IE IL IN IT JP KE KR LK MX MY NG NL NO NZ PE PH PK PL PT RO SA SE SG TH TR TW TZ UA UG US VN ZA ZM ZW').split(' '));
function pickCountry(req, body) {
  const asked = body && typeof body.country === 'string' ? body.country.toUpperCase() : '';
  if (COUNTRIES.has(asked)) return asked;
  const h = String((req.headers && req.headers['x-vercel-ip-country']) || '').toUpperCase();
  return COUNTRIES.has(h) ? h : 'US';
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 20000) return {}; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}

// Same-site requests only (browsers send Origin on POST). Blocks other websites from using our API.
function sameSite(req) {
  const o = req.headers && req.headers.origin;
  if (!o) return true; // non-browser callers are still rate limited
  try {
    const h = new URL(o).hostname;
    return h === 'zroppix.com' || h === 'www.zroppix.com' || h.endsWith('.vercel.app') || h === 'localhost' || h === '127.0.0.1';
  } catch (_) { return false; }
}

function isOwner(req) {
  const k = cfg().ownerKey;
  const got = req.headers && req.headers['x-find-owner'];
  if (!k || !got) return false;
  const a = Buffer.from(sha(k)); const b = Buffer.from(sha(String(got)));
  return crypto.timingSafeEqual(a, b);
}

function normName(s) {
  return clean(s, 200).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { sha, ipHash, today, hourKey, clean, validVisitor, pickCountry, send, readBody, sameSite, isOwner, normName, COUNTRIES };
