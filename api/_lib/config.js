'use strict';
// All tunable settings live here and come from environment variables.
// Nothing secret is hard-coded. Read at call time so tests can change env.

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

function cfg() {
  const e = process.env;
  return {
    // secrets / services
    anthropicKey: e.ANTHROPIC_API_KEY || '',
    resendKey: e.RESEND_API_KEY || '',
    kvUrl: (e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    kvToken: e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN || '',
    salt: e.FIND_SALT || '',
    adminToken: e.FIND_ADMIN_TOKEN || '',
    ownerKey: e.FIND_OWNER_KEY || '', // lets the owner see the Pro view for testing
    fromEmail: e.FIND_FROM || 'Zroppix <hello@zroppix.com>',
    siteUrl: (e.FIND_SITE_URL || 'https://zroppix.com').replace(/\/+$/, ''),

    // models
    matchModel: e.FIND_MATCH_MODEL || 'claude-haiku-5-5',
    gatherModel: e.FIND_GATHER_MODEL || 'claude-haiku-5-5',
    judgeModel: e.FIND_JUDGE_MODEL || 'claude-sonnet-5-5',

    // how hard the models think (they count thinking against the output limit). 'none' sends no setting.
    effort: e.FIND_EFFORT || 'low',

    // limits and rules
    dailyCapUsd: num(e.FIND_DAILY_CAP_USD, 5),
    maxAgeDays: num(e.FIND_MAX_AGE_DAYS, 30),
    staleMaxDays: num(e.FIND_STALE_MAX_DAYS, 180),
    freeChecks: num(e.FIND_FREE_CHECKS, 1),
    emailBonus: num(e.FIND_EMAIL_BONUS, 2),
    maxSearches: Math.min(8, Math.max(1, num(e.FIND_MAX_SEARCHES, 4))),
    cacheHours: num(e.FIND_CACHE_HOURS, 6),
    matchPerHour: num(e.FIND_MATCH_PER_HOUR, 20),
    matchPerDay: num(e.FIND_MATCH_PER_DAY, 60),
    checkPerIpDay: num(e.FIND_CHECK_PER_IP_DAY, 6),
    signupPerIpHour: num(e.FIND_SIGNUP_PER_IP_HOUR, 5),
    // worst-case reservations used by the spend cap (USD)
    reserveMatchUsd: num(e.FIND_RESERVE_MATCH_USD, 0.01),
    reserveCheckUsd: num(e.FIND_RESERVE_CHECK_USD, 0.25),
    killEnv: e.FIND_KILL === '1' || e.FIND_KILL === 'true',
  };
}

// USD per million tokens. Source: Anthropic pricing page, checked 2026-10-22.
// Haiku has a higher tier for prompts over 100k tokens. Override with FIND_PRICES (JSON) if prices change.
const DEFAULT_PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, inLong: 0.50, outLong: 2.50, longAt: 100000 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
const SEARCH_USD = 0.01;

function prices() {
  let p = DEFAULT_PRICES;
  try {
    if (process.env.FIND_PRICES) p = Object.assign({}, DEFAULT_PRICES, JSON.parse(process.env.FIND_PRICES));
  } catch (_) { /* keep defaults */ }
  return p;
}

module.exports = { cfg, prices, SEARCH_USD, num };
