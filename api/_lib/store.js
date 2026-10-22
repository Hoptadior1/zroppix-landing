'use strict';
// Minimal Upstash/Vercel-KV REST client using fetch. No npm packages.
// Fails closed: if the store is not configured, callers get an error and the tool refuses to spend money.
const { cfg } = require('./config');

class StoreError extends Error {}

async function exec(commands) {
  const c = cfg();
  if (!c.kvUrl || !c.kvToken) throw new StoreError('store_not_configured');
  const r = await fetch(c.kvUrl + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.kvToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new StoreError('store_http_' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x && x.error) throw new StoreError('store_cmd_error');
    return x ? x.result : null;
  });
}

const one = async (...cmd) => (await exec([cmd]))[0];

module.exports = {
  StoreError,
  exec,
  get: (k) => one('GET', k),
  set: (k, v, ttlSec) => (ttlSec ? one('SET', k, v, 'EX', String(Math.max(1, Math.floor(ttlSec)))) : one('SET', k, v)),
  del: (k) => one('DEL', k),
  incrBy: (k, n) => one('INCRBY', k, String(Math.round(n))),
  expire: (k, s) => one('EXPIRE', k, String(Math.floor(s))),
  hset: (k, f, v) => one('HSET', k, f, v),
  hget: (k, f) => one('HGET', k, f),
  hlen: (k) => one('HLEN', k),
  hincrby: (k, f, n) => one('HINCRBY', k, f, String(Math.round(n))),
  hgetall: (k) => one('HGETALL', k),
  lpush: (k, v) => one('LPUSH', k, v),
  rpop: (k) => one('RPOP', k),
  llen: (k) => one('LLEN', k),
  lrange: (k, a, b) => one('LRANGE', k, String(a), String(b)),
  ltrim: (k, a, b) => one('LTRIM', k, String(a), String(b)),
  getJson: async (k) => {
    const v = await one('GET', k);
    if (v == null) return null;
    try { return JSON.parse(v); } catch (_) { return null; }
  },
  setJson: (k, o, ttl) => (ttl
    ? one('SET', k, JSON.stringify(o), 'EX', String(Math.max(1, Math.floor(ttl))))
    : one('SET', k, JSON.stringify(o))),
};
