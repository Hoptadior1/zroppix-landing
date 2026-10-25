'use strict';
// Looks at one day (UTC) of counters and says what, if anything, looks wrong. Shown on the owner's stats page.
const { cfg } = require('./config');
const store = require('./store');

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

module.exports = { build };
