'use strict';
// The hard rules. Pure functions, no network. The AI proposes; this code decides what may be shown.
const { clean, normName } = require('./util');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const DAY = 86400000;

// Parse a date as printed on a page. Month-only dates count as the 1st (older, so the stricter reading).
// Returns a Date (UTC midnight) or null. Never guesses.
function parseDate(s, now) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  now = now || new Date();
  let m;
  let d = null;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  else if ((m = t.match(/^(\d{4})-(\d{2})$/))) d = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
  else if ((m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/))) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo !== undefined) d = new Date(Date.UTC(+m[3], mo, +m[2])); }
  else if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/))) { const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo !== undefined) d = new Date(Date.UTC(+m[3], mo, +m[1])); }
  else if ((m = t.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo !== undefined) d = new Date(Date.UTC(+m[2], mo, 1)); }
  else if (/^today$/i.test(t)) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  else if (/^yesterday$/i.test(t)) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  else if ((m = t.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/i))) {
    const n = +m[1]; const u = m[2].toLowerCase();
    const days = u === 'day' ? n : u === 'week' ? n * 7 : u === 'month' ? n * 30 : n * 365;
    d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * DAY);
  }
  if (!d || isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime() + 2 * DAY) return null; // a date in the future is not a report date
  if (d.getUTCFullYear() < 2000) return null;
  return d;
}

function ageDays(d, now) { return Math.floor(((now || new Date()).getTime() - d.getTime()) / DAY); }
function iso(d) { return d.toISOString().slice(0, 10); }
function human(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }

const KINDS = new Set(['price', 'coupon', 'cashback', 'refurb', 'newer_model']);
const SELLERS = new Set(['manufacturer', 'retailer', 'third_party', 'unknown']);
const PREDICT = /\b(will (drop|fall|go down|be cheaper|get cheaper)|expected to (drop|fall)|going to (drop|fall)|predict(ed|s|ion)?|forecast|hurry|act now|last chance|selling fast|don'?t miss|guaranteed|best price ever|lowest ever)\b/i;

function num(x) {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Turn one raw AI finding into a clean, bounded object. Everything is length-capped and stripped of control characters.
function normalizeFinding(raw, i) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const kind = clean(raw.kind, 20).toLowerCase();
  const seller = clean(raw.seller, 20).toLowerCase();
  return {
    id: clean(raw.id, 12) || 'f' + (i + 1),
    kind,
    store: clean(raw.store, 60),
    title: clean(raw.title, 140),
    price: num(raw.price),
    listPrice: num(raw.list_price),
    currency: (clean(raw.currency, 3) || 'USD').toUpperCase(),
    percent: num(raw.percent),
    code: clean(raw.code, 40).replace(/[^A-Za-z0-9_\-]/g, ''),
    expires: clean(raw.expires, 40),
    pageDate: clean(raw.page_date, 40),
    sourceUrl: clean(raw.source_url, 500),
    sourceTitle: clean(raw.source_title, 120),
    quote: clean(raw.quote, 160),
    condition: clean(raw.condition, 40),
    seller: SELLERS.has(seller) ? seller : 'unknown',
    ships: ['yes', 'no', 'unknown'].includes(clean(raw.ships, 8).toLowerCase()) ? clean(raw.ships, 8).toLowerCase() : 'unknown',
    note: clean(raw.note, 140),
    shipping: shipInfo(raw),
    delivery: clean(raw.delivery, 40),
  };
}

// Shipping only counts when a page states it. A "paid" claim without an amount is treated as not stated.
function shipInfo(raw) {
  const s = clean(raw.shipping, 12).toLowerCase();
  if (s === 'free') return { state: 'free', cost: 0 };
  const c = num(raw.shipping_cost);
  if (s === 'paid' && c != null && c >= 0 && c < 2000) return { state: 'paid', cost: c };
  return { state: 'not_stated', cost: null };
}

function normUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '');
  } catch (_) { return null; }
}

function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; }

function shortTitle(t) { t = String(t || ''); if (t.length <= 44) return t; const cut = t.slice(0, 44); return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)) + '…'; }

// Apply every hard rule. `judge` is a map id -> {same_product, verdict, reason} from the AI judge (optional).
// Returns { accepted, rejected, stale } where each accepted item is client-safe.
function evaluate(rawFindings, ctx) {
  const now = ctx.now || new Date();
  const maxAge = ctx.maxAgeDays;
  const staleMax = ctx.staleMaxDays;
  const results = ctx.results || [];
  const byUrl = new Map();
  for (const r of results) { const k = normUrl(r.url); if (k && !byUrl.has(k)) byUrl.set(k, r); }
  const judge = ctx.judge || {};
  const accepted = []; const rejected = []; const stale = []; const undated = [];

  (rawFindings || []).slice(0, 20).forEach((raw, i) => {
    const f = normalizeFinding(raw, i);
    const who = f.store || 'Unnamed store';
    const what = f.kind === 'price' || f.kind === 'refurb' ? (f.price != null ? who + ' ' + f.currency + ' ' + f.price : who)
      : f.kind === 'cashback' ? who + (f.percent != null ? ' ' + f.percent + '% cashback' : ' cashback')
      : f.kind === 'coupon' ? who + (f.code ? ' code ' + f.code : ' coupon')
      : (f.title ? (f.title.toLowerCase().startsWith(who.toLowerCase()) ? '' : who + ' ') + shortTitle(f.title) : who);
    const rej = (why) => rejected.push({ id: f.id, what: clean(what, 90), why: clean(why, 140) });

    if (!KINDS.has(f.kind)) return rej('unrecognised offer type');
    const src = byUrl.get(normUrl(f.sourceUrl));
    if (!src) return rej('source page was not in the search results');
    if (!f.store && f.kind !== 'newer_model') return rej('no store named');
    if (PREDICT.test(f.title) || PREDICT.test(f.note)) f.note = ''; // never show predictions or pressure
    if (PREDICT.test(f.title)) return rej('contained a prediction or pressure claim');

    // Date: the page date the AI read, or the search tool's page_age. If both exist and differ, use the OLDER one.
    const d1 = parseDate(f.pageDate, now);
    const d2 = parseDate(src.page_age, now);
    const d = d1 && d2 ? (d1 < d2 ? d1 : d2) : d1 || d2;
    let noDate = false;
    // A cashback rate is a standing rate, so a missing date is allowed for it. It is labelled "no date on the page" wherever it is shown.
    if (!d && f.kind === 'cashback') noDate = true;
    else if (!d) {
      // A store listing with a usable price but no printed date is never shown as an offer. Pro lists it separately and says so.
      if ((f.kind === 'price' || f.kind === 'refurb') && f.price > 0 && f.price <= 100000) {
        const j0 = judge[f.id];
        const key = (f.store + '|' + f.price + '|' + f.kind).toLowerCase();
        if (!(j0 && (j0.same_product === false || j0.verdict === 'reject')) && !undated.some((u) => u.key === key) && undated.length < 4) undated.push({ key, id: f.id, kind: f.kind, store: f.store, price: f.price, listPrice: (f.listPrice > f.price && f.price >= 0.2 * f.listPrice && f.listPrice < 100000) ? f.listPrice : null, currency: f.currency, condition: f.condition, sourceUrl: f.sourceUrl, sourceTitle: f.sourceTitle });
      }
      return rej('no date on the page');
    }
    const age = noDate ? null : ageDays(d, now);

    // Kind-specific facts
    let limit = maxAge;
    if (f.kind === 'newer_model') limit = 365;
    if (f.kind === 'cashback') limit = ctx.cashbackMaxDays || 120; // a cashback rate changes slowly; the page shows its age
    if (f.kind === 'price' || f.kind === 'refurb') {
      if (!(f.price > 0) || f.price > 100000) return rej('no usable price');
    }
    // A list price only counts if it is higher than the offer and not absurdly higher (that is usually a different item or a misread).
    if (f.listPrice != null && !(f.price > 0 && f.listPrice > f.price && f.price >= 0.2 * f.listPrice && f.listPrice < 100000)) f.listPrice = null;
    if (f.kind === 'cashback' && !(f.percent > 0 && f.percent <= 40)) return rej(f.percent > 40 ? 'implausible cashback rate' : 'no cashback rate');
    if (f.kind === 'coupon') {
      const exd = parseExpiry(f.expires); // an expiry is normally in the future, so it skips the future-date guard
      if (!exd) return rej('coupon has no expiry date, so it may already be dead');
      if (exd.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) return rej('coupon expired ' + human(exd));
      f.expiresIso = iso(exd);
    }
    if (f.kind === 'newer_model' && !f.title) return rej('no model named');

    // AI judge (advisory but binding on rejection)
    const j = judge[f.id];
    // A newer model is by definition not the same product, so only its verdict counts; it needs no price.
    if (j && ((f.kind !== 'newer_model' && j.same_product === false) || j.verdict === 'reject')) return rej(j.reason || 'not the same product');

    const item = Object.assign({}, f, { date: noDate ? null : iso(d), dateHuman: noDate ? null : human(d), ageDays: age, expiresIso: f.expiresIso || null });
    if (age != null && age > limit) {
      rej('page dated ' + human(d) + ', ' + age + ' days old (limit ' + limit + ')');
      if (age <= staleMax && (f.kind === 'price' || f.kind === 'refurb')) stale.push(item);
      return;
    }
    accepted.push(item);
  });

  // Implausibly cheap relative to the rest (probably a different item). Needs 3+ prices to judge.
  const prices = accepted.filter((a) => a.kind === 'price').map((a) => a.price);
  if (prices.length >= 3) {
    const med = median(prices);
    for (let i = accepted.length - 1; i >= 0; i--) {
      const a = accepted[i];
      if (a.kind === 'price' && a.price < med * 0.25) {
        rejected.push({ id: a.id, what: clean(a.store + ' ' + a.currency + ' ' + a.price, 90), why: 'far below every other price, likely a different item' });
        accepted.splice(i, 1);
      }
    }
  }
  return { accepted, rejected, stale, undated };
}

// Coupon expiry may be in the future; accept ISO and "Month D, YYYY" without the future guard.
function parseExpiry(s) {
  if (!s) return null;
  const far = new Date(Date.UTC(2100, 0, 1));
  const d = parseDate(s, far);
  return d && d.getUTCFullYear() < 2100 ? d : null;
}

// Pick the headline offer. Lowest price in the most common currency; otherwise the first coupon, then cashback.
function pickBest(accepted) {
  const prices = accepted.filter((a) => a.kind === 'price');
  if (prices.length) {
    const cnt = {}; prices.forEach((p) => { cnt[p.currency] = (cnt[p.currency] || 0) + 1; });
    const cur = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    return prices.filter((p) => p.currency === cur).sort((a, b) => a.price - b.price)[0];
  }
  return accepted.find((a) => a.kind === 'coupon') || accepted.find((a) => a.kind === 'cashback') || accepted.find((a) => a.kind === 'refurb') || null;
}

// What the browser may receive. Locked details for free users are reduced to counts only.
// Where the "Open" button should go. If the source page is the store's own site, use it.
// If it is an article or deals roundup, send the shopper to that store's search for the product instead
// (never a link we made up for a specific product page), and keep the article as "Read the report".
function storeTarget(a, productName, country) {
  let host = '';
  try { host = new URL(a.sourceUrl).hostname.toLowerCase(); } catch (_) { /* none */ }
  const key = normName(a.store || '').replace(/[^a-z0-9]/g, '');
  const hostKey = host.replace(/[^a-z0-9]/g, '');
  const isStoreSite = !!key && key.length >= 3 && hostKey.includes(key);
  const looksEditorial = /\/(blog|news|deals?|article|articles|guide|guides|review|reviews)\b/i.test(a.sourceUrl) || /\d{4}\/\d{2}\//.test(a.sourceUrl);
  if (isStoreSite && !looksEditorial) return { url: a.sourceUrl, kind: 'store' };
  const list = STORE_LINKS[country] || INTL;
  const hit = list.find(([name]) => { const n = normName(name).replace(/[^a-z0-9]/g, ''); return key && (n.startsWith(key) || key.startsWith(n)); });
  if (hit && productName) return { url: hit[1] + encodeURIComponent(clean(productName, 100)), kind: 'search', store: hit[0] };
  return { url: a.sourceUrl, kind: 'article' };
}

const r2 = (n) => Math.round(n * 100) / 100;

// What a shopper could save, in money, against the headline price. Only when the rate is stated.
function valueOf(a, base) {
  if (!base || !(base > 0)) return null;
  if ((a.kind === 'coupon' || a.kind === 'cashback') && a.percent > 0) return r2(base * a.percent / 100);
  if (a.kind === 'coupon' && a.price > 0 && a.price < base) return r2(a.price); // a fixed amount off
  return null;
}

function totalOf(a) {
  if (a.price == null || !a.shipping || a.shipping.cost == null) return null;
  return r2(a.price + a.shipping.cost);
}

// What the browser may receive. For free users every locked detail (code, store, link, shipping) stays on the server.

// Rejected pages: free users get only counts by reason (no stores or prices); Pro gets the full list.
function rejCat(why) {
  const w = String(why || '');
  if (/days old|expired/.test(w)) return 'old';
  if (/no date on the page|no expiry/.test(w)) return 'undated';
  if (/not in the search results|no store named|unrecognised|prediction|no usable price|implausible|no cashback rate|no model named|second check|not https|not a valid/i.test(w)) return 'other';
  return 'match';
}
function rejectedOut(rejected, pro) {
  const list = rejected || [];
  const sum = { count: list.length, old: 0, undated: 0, match: 0, other: 0 };
  list.forEach((r) => { sum[rejCat(r.why)]++; });
  const out = { rejectedSummary: sum };
  if (pro) out.rejected = list.slice(0, 12).map((r) => ({ what: r.what, why: r.why }));
  return out;
}


// ---- Buy Report: the free offer, the verdict, and what Pro would add ----
// Free users see ONE offer. It is chosen by a fixed rule (not "the cheapest"), so the page can say honestly when Pro found a lower total.
const STORE_RANK = ['amazon', 'walmart', 'best buy', 'target', 'costco', 'apple', 'ebay'];
function storeRank(s) { const n = normName(s || ''); const i = STORE_RANK.findIndex((r) => n.includes(r)); return i < 0 ? 50 : i; }
const comparable = (a) => (a && a.price != null ? r2(a.price + (a.shipping && a.shipping.cost ? a.shipping.cost : 0)) : null);
function pickFree(accepted, ctx) {
  const prices = accepted.filter((a) => a.kind === 'price' && a.price > 0);
  if (!prices.length) return pickBest(accepted);
  const cnt = {}; prices.forEach((p) => { cnt[p.currency] = (cnt[p.currency] || 0) + 1; });
  const cur = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  const list = prices.filter((p) => p.currency === cur);
  const fresh = list.filter((a) => a.ageDays != null && a.ageDays <= 14);
  const pool = fresh.length ? fresh : list;
  const kindOf = (a) => (ctx && ctx.productName ? storeTarget(a, ctx.productName, ctx.country).kind : 'article');
  const stores = pool.filter((a) => kindOf(a) !== 'article');
  const use = stores.length ? stores : pool;
  return use.slice().sort((a, b) => storeRank(a.store) - storeRank(b.store) || a.price - b.price)[0];
}
function modeOf(list) { const c = {}; list.forEach((x) => { c[x] = (c[x] || 0) + 1; }); const k = Object.keys(c).sort((a, b) => c[b] - c[a] || Number(b) - Number(a))[0]; return k == null ? null : Number(k); }
// A coupon counts toward an offer's total only when it is for the same store, states an amount, and has not ended.
function couponOff(a, accepted) {
  if (!a || !(a.price > 0)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const mine = normName(a.store || '');
  let best = 0;
  for (const c of accepted) {
    if (c.kind !== 'coupon' || !c.store || !mine) continue;
    const cs = normName(c.store);
    if (!(cs && (mine.includes(cs) || cs.includes(mine)))) continue;
    if (c.expiresIso && c.expiresIso < today) continue;
    const v = valueOf(c, a.price);
    if (v && v > best) best = v;
  }
  return best;
}
const totalAfter = (a, accepted) => (a && a.price != null ? r2(Math.max(0, comparable(a) - couponOff(a, accepted))) : null);
const MIN_SAVING_USD = 5;
const minGap = (total) => Math.max(MIN_SAVING_USD, (total || 0) * 0.02);
// How much a shopper could still save against the first offer: the spread between offers, plus a stated coupon. Used to decide on a second search.
function savingPotential(accepted) {
  const prices = accepted.filter((a) => a.kind === 'price' && a.price > 0);
  if (!prices.length) return 0;
  const cnt = {}; prices.forEach((p) => { cnt[p.currency] = (cnt[p.currency] || 0) + 1; });
  const cur = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  const t = prices.filter((p) => p.currency === cur).map((p) => totalAfter(p, accepted));
  const spread = t.length > 1 ? Math.max.apply(null, t) - Math.min.apply(null, t) : 0;
  const low = prices.filter((p) => p.currency === cur).sort((a, b) => totalAfter(a, accepted) - totalAfter(b, accepted))[0];
  return r2(spread + (low ? couponOff(low, accepted) : 0));
}
function buildReport(accepted, shown, ctx, hist) {
  const cur = shown ? shown.currency : null;
  const pool = accepted.filter((a) => a.kind === 'price' && a.price > 0 && a.currency === cur);
  const tot = (a) => totalAfter(a, accepted);
  const sorted = pool.slice().sort((a, b) => tot(a) - tot(b));
  const low = sorted[0] || null;
  const freeTotal = shown && shown.kind === 'price' ? comparable(shown) : null; // the free offer's own total: coupons are Pro's, so they never lower it
  const held = pool.filter((a) => a !== shown);
  const lowTotal = low ? tot(low) : null;
  const gapRaw = freeTotal != null && lowTotal != null && lowTotal < freeTotal ? r2(freeTotal - lowTotal) : 0;
  const lowShip = low && low.shipping ? low.shipping.state : 'not_stated';
  // A gap is claimed only when it is worth the name, and when the cheaper offer's own shipping is known.
  const gap = gapRaw >= minGap(freeTotal) ? gapRaw : 0;
  const gapUncertain = gap > 0 && low !== shown && !(lowShip === 'free' || lowShip === 'paid'); // the cheaper offer's shipping is not stated: the gap is before shipping
  const listPrice = modeOf(pool.map((a) => a.listPrice).filter(Boolean));
  const srcKind = shown ? (ctx && ctx.productName ? storeTarget(shown, ctx.productName, ctx.country).kind : 'article') : null;
  const refs = accepted.filter((a) => a.kind === 'refurb');
  const coupons = accepted.filter((a) => a.kind === 'coupon');
  const exp = coupons.map((c) => c.expiresIso).filter(Boolean).sort()[0] || null;
  const rep = {
    currency: cur, listPrice, freeTotal,
    lowest: low ? { total: lowTotal, price: low.price, dateHuman: low.dateHuman, ageDays: low.ageDays, shipState: (low.shipping && low.shipping.state) || 'not_stated' } : null,
    gap, freeIsLowest: !gap,
    spread: sorted.length > 1 ? r2((tot(sorted[sorted.length - 1]) - lowTotal) / tot(sorted[sorted.length - 1])) : null,
    freeCouponOff: shown && shown.kind === 'price' ? couponOff(shown, accepted) : 0, gapUncertain, nearlyEqual: gapRaw > 0 && gap === 0, smallGap: gapRaw > 0 && gap === 0 ? gapRaw : 0, afterCoupon: !!(low && couponOff(low, accepted) > 0), couponOff: low ? couponOff(low, accepted) : 0,
    heldStores: held.length, heldCheaper: gap ? held.filter((a) => tot(a) < freeTotal).length : 0,
    openbox: refs.length, coupons: coupons.length, cashback: accepted.filter((a) => a.kind === 'cashback').length, couponEnds: exp,
    weakSource: srcKind === 'article' ? 'price_site' : null,
    histLowest: hist && hist.lowest && (!cur || cur === 'USD') ? hist.lowest : null,
    histAverage: hist && hist.average && (!cur || cur === 'USD') ? hist.average : null,
    regularPrice: !!(listPrice && lowTotal != null && lowTotal >= listPrice * 0.995),
    rows: sorted.map((a) => ({ free: a === shown, dateHuman: a.dateHuman, ageDays: a.ageDays, shipState: (a.shipping && a.shipping.state) || 'not_stated' })),
  };
  rep.verdict = verdictOf(lowTotal, rep, hist, cur);
  if (rep.verdict && /earlier version/.test(rep.verdict.text || '')) { rep.histLowest = null; rep.histAverage = null; }
  rep.timeline = hist && Array.isArray(hist.points) ? hist.points.slice(0, 4).map((x) => ({ d: x.d, t: x.t, s: x.s })) : null;
  return rep;
}
// BUY / FAIR / WAIT is a call about THIS price, never a forecast. It always says what it is based on:
// dated price history we hold, the list price a page states, how far the stores differ, or (when there is nothing to compare) "compare first".
function verdictOf(L, rep, hist, cur) {
  if (L == null) return { call: 'WAIT', chip: 'No store price', text: 'No store price passed our checks, so there is nothing to buy at yet. Coupons, cashback or open-box offers are listed below, or set a watch and we search again every day.' };
  const usd = !cur || cur === 'USD';
  const lower = rep.freeIsLowest ? '' : ' It is judged on the lowest offer we found, not the free one.';
  let weak = rep.weakSource ? ' The price comes from a price-listing site, not a store page, so check the live price first.' : '';
  const cap = (call) => (rep.weakSource && call === 'BUY' ? 'FAIR' : call);
  let hasL = !!(hist && hist.lowest && usd), hasA = !!(hist && hist.average && usd);
  // A price far above the whole history usually means the history is for an earlier version of the product, so it is not used.
  if ((hasA && L > hist.average * 1.6) || (hasL && !hasA && L > hist.lowest * 1.8)) { hasL = false; hasA = false; weak += ' Our price history is far below this price, so it may be for an earlier version, and we did not use it.'; }
  const upd = hist && hist.updated && /^\d{4}-\d{2}-\d{2}$/.test(hist.updated) ? ' (history updated ' + new Date(hist.updated + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) + ')' : '';
  if (hasL && hasA) {
    const lo = hist.lowest, av = hist.average;
    const right = rep.listPrice && rep.listPrice > av ? rep.listPrice : null;
    const max = right || av; const min = Math.min(lo, L);
    const pos = Math.max(0, Math.min(1, (L - min) / ((max - min) || 1)));
    const bar = { pos: Math.round(pos * 100), lowLabel: money0(lo) + ' lowest on record', highLabel: right ? money0(right) + ' list' : money0(av) + ' average', pin: money0(L) + ' lowest found' };
    if (L <= lo * 1.03) return { call: cap('BUY'), chip: 'Near its lowest on record', basis: 'history', text: 'The lowest total we found is at or near the lowest price in our dated history.' + lower + ' If you need it, this is a good point to buy.' + weak + upd, bar };
    if (L <= av * 1.02) return { call: 'FAIR', chip: 'Lower prices have been reported', basis: 'history', text: (L < av * 0.95 ? 'Below its usual price in our dated history' : 'About its usual price in our dated history') + ', but lower prices have been reported before.' + lower + ' Buy now if you need it, or set an alert.' + weak + upd, bar };
    return { call: 'WAIT', chip: 'Above its usual price', basis: 'history', text: 'Above its usual price in our dated history, and lower prices have been reported before.' + lower + ' If you can wait, set an alert.' + weak + upd, bar };
  }
  // With only one reference point the bar shows it as a tick and the pin shows where the lowest we found sits against it.
  const oneRef = (ref, label) => { const lo = Math.min(L, ref) * 0.85, hi = Math.max(L, ref) * 1.15; const at = (x) => Math.max(0, Math.min(100, Math.round(((x - lo) / ((hi - lo) || 1)) * 100))); return { pos: at(L), lowLabel: 'lower', highLabel: 'higher', pin: money0(L) + ' lowest found', mid: { pos: at(ref), label: money0(ref) + ' ' + label } }; };
  if (hasL) {
    const lo = hist.lowest, pct = Math.round(((L - lo) / lo) * 100);
    var barL = oneRef(lo, 'lowest on record');
    if (L <= lo * 1.05) return { call: cap('BUY'), chip: 'Near its lowest on record', basis: 'history', text: 'The lowest price in our dated history is ' + money0(lo) + ', and the lowest we found is within 5% of it.' + lower + weak + upd, bar: barL };
    if (L >= lo * 1.35) return { call: 'WAIT', chip: 'Well above its lowest', basis: 'history', text: 'The lowest price in our dated history is ' + money0(lo) + '. The lowest we found is about ' + pct + '% above it.' + lower + ' If you can wait, set an alert.' + weak + upd, bar: barL };
    return { call: 'FAIR', chip: 'Above its lowest on record', basis: 'history', text: 'The lowest price in our dated history is ' + money0(lo) + '. The lowest we found is about ' + pct + '% above it.' + lower + ' Buy now if you need it, or set an alert.' + weak + upd, bar: barL };
  }
  if (hasA) {
    const av = hist.average, pct = Math.round(((L - av) / av) * 100);
    const barA = oneRef(av, 'average');
    if (L <= av * 0.9) return { call: cap('BUY'), chip: 'Below its usual price', basis: 'history', text: 'The average price in our dated history is ' + money0(av) + ', and the lowest we found is about ' + Math.abs(pct) + '% below it.' + lower + weak + upd, bar: barA };
    if (L <= av * 1.05) return { call: 'FAIR', chip: 'About its usual price', basis: 'history', text: 'The average price in our dated history is ' + money0(av) + ', and the lowest we found is about the same.' + lower + ' Buy now if you need it, or set an alert.' + weak + upd, bar: barA };
    return { call: 'WAIT', chip: 'Above its usual price', basis: 'history', text: 'The average price in our dated history is ' + money0(av) + ', and the lowest we found is about ' + pct + '% above it.' + lower + ' If you can wait, set an alert.' + weak + upd, bar: barA };
  }
  if (rep.listPrice) {
    const d = 1 - L / rep.listPrice, pct = Math.round(d * 100);
    const bar = { pos: Math.max(0, Math.min(100, Math.round((L / rep.listPrice) * 100))), lowLabel: '', highLabel: money0(rep.listPrice) + ' list', pin: money0(L) + ' lowest found' };
    if (d >= 0.25) return { call: cap('BUY'), chip: 'Based on the list price', basis: 'list', text: 'The lowest we found is about ' + pct + '% below the ' + money0(rep.listPrice) + ' list price the pages state. We have no price history for this product yet.' + lower + weak, bar };
    if (d >= 0.10) return { call: 'FAIR', chip: 'Based on the list price', basis: 'list', text: 'The lowest we found is about ' + pct + '% below the ' + money0(rep.listPrice) + ' list price the pages state. We have no price history for this product yet.' + lower + ' Buy now if you need it, or set an alert.' + weak, bar };
    return { call: 'WAIT', chip: 'Little or no discount', basis: 'list', text: d > 0.005 ? 'The lowest we found is only about ' + pct + '% below the ' + money0(rep.listPrice) + ' list price the pages state.' + lower + ' If you can wait, set an alert.' + weak : 'The prices we found match the ' + money0(rep.listPrice) + ' list price. We found no discount.' + lower + ' If you can wait, set an alert.' + weak, bar };
  }
  const n = (rep.rows || []).length;
  if (n >= 2 && rep.spread != null) {
    if (rep.spread <= 0.10) return { call: 'FAIR', chip: 'Limited data', basis: 'stores', text: 'The ' + n + ' dated store prices we found are within ' + Math.max(1, Math.round(rep.spread * 100)) + '% of each other, so no store looks like an overcharge. We have no price history or list price to say if it is low.' + lower + ' Buy now if you need it, or set an alert.' + weak };
    return { call: 'WAIT', chip: 'Limited data', basis: 'stores', text: 'The ' + n + ' dated store prices we found differ by about ' + Math.round(rep.spread * 100) + '%, and we have no price history or list price to say which is fair.' + lower + ' Compare the stores below, or set an alert before you buy.' + weak };
  }
  return { call: 'WAIT', chip: 'Compare first', basis: 'none', text: 'We found one dated store price and nothing to compare it with: no price history and no list price. Compare the stores or set an alert before you buy.' + weak };
}
const money0 = (n) => '$' + (n % 1 ? n.toFixed(2) : String(n));

function shape(ev, tier, extras, ctx) {
  const pro = tier === 'pro';
  const best = pro ? pickBest(ev.accepted) : pickFree(ev.accepted, ctx);
  const rest = ev.accepted.filter((a) => a !== best && a.kind !== 'newer_model');
  const newer = ev.accepted.filter((a) => a.kind === 'newer_model').slice(0, 1);
  const base = best && best.kind === 'price' ? best.price : null;
  const pub = (a, full) => {
    const o = {
      id: a.id, kind: a.kind, store: a.store, title: a.title, price: a.price, currency: a.currency, percent: a.percent,
      listPrice: a.listPrice || null, saveUsd: a.listPrice ? r2(a.listPrice - a.price) : null, savePct: a.listPrice ? Math.round((1 - a.price / a.listPrice) * 100) : null,
      expires: a.expiresIso, date: a.date, dateHuman: a.dateHuman, ageDays: a.ageDays,
      sourceUrl: a.sourceUrl, sourceTitle: a.sourceTitle, seller: a.seller, condition: a.condition, ships: a.ships, note: a.note,
      target: ctx && ctx.productName ? storeTarget(a, ctx.productName, ctx.country) : { url: a.sourceUrl, kind: 'article' },
    };
    if (full) {
      o.code = a.code; o.shipping = a.shipping; o.delivery = a.delivery; o.total = totalOf(a); o.valueUsd = valueOf(a, base);
    }
    return o;
  };
  const out = {
    best: best ? pub(best, pro || best.kind === 'price') : null,
    report: buildReport(ev.accepted, best, ctx, extras && extras.history),
    newer: newer.map((a) => pub(a, false)),
    ...rejectedOut(ev.rejected, pro),
    warnings: [],
    counts: { coupon: ev.accepted.filter((a) => a.kind === 'coupon').length, cashback: ev.accepted.filter((a) => a.kind === 'cashback').length },
    proof: ev.proof || null,
  };
  // Old reports (past the freshness limit) that were priced below today's lowest total: a real price some store has charged before.
  if (out.report && out.report.lowest) {
    const lowT = out.report.lowest.total, cur0 = out.report.currency;
    const lower = (ev.stale || []).filter((x) => x.kind === 'price' && x.price > 0 && (!x.currency || x.currency === cur0) && x.price < lowT * 0.97);
    if (lower.length) {
      const d = lowT - Math.min.apply(null, lower.map((x) => x.price));
      const rough = d >= 20 ? Math.floor(d / 5) * 5 : Math.floor(d);
      if (rough >= 5) out.oldLower = { n: lower.length, usd: rough, currency: cur0 };
    }
  }
  // Safety information is never locked.
  if (best && best.seller === 'third_party') out.warnings.push('This offer is from a third-party seller, not the manufacturer or the store itself. Check the seller rating and return terms before you buy.');
  if (best && best.ships === 'no') out.warnings.push('The store may not ship to your country. Check before you rely on this price.');

  if (pro) {
    // Every offer, cheapest total first. Offers with no stated shipping have an unknown total and go last.
    const offers = ev.accepted.filter((a) => a.kind === 'price' || a.kind === 'refurb').map((a) => pub(a, true));
    offers.sort((x, y) => {
      const tx = x.total, ty = y.total;
      if (tx != null && ty != null) return tx - ty;
      if (tx != null) return -1;
      if (ty != null) return 1;
      return (x.price || 0) - (y.price || 0);
    });
    out.offers = offers;
    out.coupons = ev.accepted.filter((a) => a.kind === 'coupon').map((a) => pub(a, true));
    out.cashbacks = ev.accepted.filter((a) => a.kind === 'cashback').map((a) => pub(a, true));
  } else {
    // Teasers: what exists and what it is worth, with the code, store, link and shipping withheld.
    const teasers = [];
    rest.forEach((a) => {
      if (a.kind === 'coupon') teasers.push({ kind: 'coupon', percent: a.percent, valueUsd: valueOf(a, base), expires: a.expiresIso, ageDays: a.ageDays });
      else if (a.kind === 'cashback') teasers.push({ kind: 'cashback', percent: a.percent, valueUsd: valueOf(a, base), ageDays: a.ageDays });
      else if (a.kind === 'refurb') teasers.push({ kind: 'refurb', backed: a.seller === 'manufacturer', ageDays: a.ageDays });
      else if (a.kind === 'price') teasers.push({ kind: 'price', ageDays: a.ageDays });
    });
    out.teasers = teasers.slice(0, 6).map((t) => { const c = Object.assign({}, t); delete c.valueUsd; return c; }); // dollar values stay on the server
    // The most the shopper could take off the best price with the coupon and cashback we found (they may not combine, so the page says "up to").
    const extraUsd = r2(teasers.reduce((n, t) => n + ((t.kind === 'coupon' || t.kind === 'cashback') && t.valueUsd ? t.valueUsd : 0), 0));
    // Real gaps between offers, from the prices we read (same currency only). The prices themselves stay locked.
    if (base) {
      const others = rest.filter((a) => (a.kind === 'price' || a.kind === 'refurb') && a.currency === best.currency && a.price > 0);
      const lower = others.filter((a) => a.price < base).sort((x, y) => x.price - y.price)[0];
      // Gaps are sent as rough percentages, rounded DOWN, so the headline is true but does not give the locked price away.
      if (lower) { const pct = Math.floor(((base - lower.price) / base) * 100 / 5) * 5; out.cheaper = { pct: Math.max(pct, 5), kind: lower.kind }; }
      const near = others.filter((a) => a.price >= base && a.price <= base * 1.1);
      if (near.length) out.close = { n: near.length };
    }
    // Rounded DOWN (to the nearest 5 once it is 20 or more), so "up to about" is always true.
    const roughUsd = extraUsd >= 20 ? Math.floor(extraUsd / 5) * 5 : Math.floor(extraUsd);
    if (roughUsd >= 1 && base) out.extra = { usd: roughUsd, currency: best.currency };
    const counts = {};
    rest.forEach((a) => { counts[a.kind] = (counts[a.kind] || 0) + 1; });
    out.locked = counts; // counts only
  }
  // Store listings that print no date: counted for free users, listed (and labelled) for Pro.
  const und = (ev.undated || []).filter((u) => !best || u.store !== best.store || u.price !== best.price);
  if (und.length) {
    if (pro) out.undated = und.map((u) => ({ store: u.store, kind: u.kind, price: u.price, currency: u.currency, condition: u.condition, sourceUrl: u.sourceUrl, sourceTitle: u.sourceTitle }));
    else out.undatedCount = und.length;
  }
  return Object.assign(out, extras || {});
}

// ---- Fallback: the result is never empty ----
const STORE_LINKS = {
  US: [['Amazon', 'https://www.amazon.com/s?k='], ['Best Buy', 'https://www.bestbuy.com/site/searchpage.jsp?st='], ['Walmart', 'https://www.walmart.com/search?q='], ['Target', 'https://www.target.com/s?searchTerm='], ['eBay', 'https://www.ebay.com/sch/i.html?_nkw=']],
  GB: [['Amazon UK', 'https://www.amazon.co.uk/s?k='], ['Argos', 'https://www.argos.co.uk/search/'], ['eBay UK', 'https://www.ebay.co.uk/sch/i.html?_nkw=']],
  CA: [['Amazon Canada', 'https://www.amazon.ca/s?k='], ['Best Buy Canada', 'https://www.bestbuy.ca/en-ca/search?search='], ['Walmart Canada', 'https://www.walmart.ca/en/search?q='], ['eBay Canada', 'https://www.ebay.ca/sch/i.html?_nkw=']],
  DE: [['Amazon.de', 'https://www.amazon.de/s?k='], ['eBay.de', 'https://www.ebay.de/sch/i.html?_nkw=']],
  AU: [['Amazon Australia', 'https://www.amazon.com.au/s?k='], ['eBay Australia', 'https://www.ebay.com.au/sch/i.html?_nkw=']],
  IN: [['Amazon India', 'https://www.amazon.in/s?k='], ['Flipkart', 'https://www.flipkart.com/search?q=']],
};
const INTL = [['Amazon', 'https://www.amazon.com/s?k='], ['eBay', 'https://www.ebay.com/sch/i.html?_nkw=']];

function storeLinks(productName, country) {
  const list = STORE_LINKS[country] || INTL;
  const q = encodeURIComponent(clean(productName, 100));
  return list.map(([store, base]) => ({ store, url: base + q }));
}

// Match a product name to one of our price-history pages.
const STOP = new Set(['price', 'history', 'amazon', 'deal', 'deals', 'tracker', 'the', 'and', 'with', 'for', 'of', 'new', 'in']);
function tokens(s) { return normName(s).split(' ').filter((t) => t && !STOP.has(t)); }
function matchDeal(name, index) {
  const a = tokens(name);
  if (a.length < 2 || !Array.isArray(index)) return null;
  const A = new Set(a);
  let best = null; let bs = 0;
  for (const d of index) {
    const b = tokens(d.title);
    if (!b.length) continue;
    const B = new Set(b);
    let inter = 0; A.forEach((t) => { if (B.has(t)) inter++; });
    const score = inter / Math.min(A.size, B.size);
    // model numbers (tokens with digits) must all match
    const ma = a.filter((t) => /\d/.test(t)); const mb = new Set(b.filter((t) => /\d/.test(t)));
    const modelsOk = ma.length === 0 || ma.every((t) => mb.has(t));
    if (modelsOk && score > bs) { bs = score; best = d; }
  }
  return bs >= 0.75 ? { slug: best.slug, title: best.title, lowest: best.lowest || null, average: best.average || null, updated: best.updated || null, points: Array.isArray(best.points) ? best.points : null } : null;
}

function lockedSaving(items, ref, histLowest) {
  const rough = (d) => (d >= 20 ? Math.floor(d / 5) * 5 : Math.floor(d));
  let best = null;
  (items || []).forEach((x) => { const d = x.listPrice > x.price ? x.listPrice - x.price : 0; if (d > 0 && (!best || d > best.d)) best = { d, currency: x.currency }; });
  if (best && rough(best.d) >= 5) return { usd: rough(best.d), currency: best.currency, vs: 'list' };
  // No stated list price on the held-back reports: compare them with the last report the shopper can see.
  if (ref && ref.price > 0) {
    const same = (items || []).filter((x) => x.price > 0 && x.currency === ref.currency);
    if (same.length) { const d = ref.price - Math.min.apply(null, same.map((x) => x.price)); if (d > 0 && rough(d) >= 5) return { usd: rough(d), currency: ref.currency, vs: 'last' }; }
    if (histLowest && (!ref.currency || ref.currency === 'USD')) { const d = ref.price - histLowest; if (d > 0 && rough(d) >= 5) return { usd: rough(d), currency: 'USD', vs: 'history' }; }
  }
  return undefined;
}

function buildFallback({ productName, country, stale, deal, newer, hadSearchError, unreadable, tier, undated }) {
  const sorted = (stale || []).slice().sort((a, b) => a.ageDays - b.ageDays);
  const lastSeen = sorted[0] || null;
  const saveOf = (x) => (x.listPrice > x.price ? r2(x.listPrice - x.price) : 0);
  const view = (x) => ({ store: x.store, price: x.price, currency: x.currency, dateHuman: x.dateHuman, ageDays: x.ageDays, sourceUrl: x.sourceUrl, sourceTitle: x.sourceTitle, saveUsd: tier === 'pro' ? (saveOf(x) || undefined) : undefined });
  const more = sorted.slice(1, 4);
  return {
    reason: hadSearchError ? 'search_unavailable' : unreadable ? 'unreadable' : 'no_current_offer',
    lastSeen: lastSeen ? view(lastSeen) : null,
    // Free users see only that more old reports exist; Pro sees them.
    olderCount: more.length,
    // One rough figure from the LOCKED items only (older reports and undated listings), never from the free last report.
    lockedSave: tier !== 'pro' ? lockedSaving(more.concat(undated || []), lastSeen, deal && deal.lowest) : undefined,
    olderOldestDays: more.length ? more[more.length - 1].ageDays : undefined,
    older: tier === 'pro' ? more.map(view) : undefined,
    undated: tier === 'pro' && (undated || []).length ? undated.map((u) => ({ store: u.store, kind: u.kind, price: u.price, currency: u.currency, saveUsd: u.listPrice > u.price ? r2(u.listPrice - u.price) : undefined, condition: u.condition, sourceUrl: u.sourceUrl, sourceTitle: u.sourceTitle })) : undefined,
    undatedCount: tier !== 'pro' && (undated || []).length ? undated.length : undefined,
    links: storeLinks(productName, country),
    history: deal ? { url: '/deals/' + deal.slug, title: deal.title, lowest: deal.lowest || null, average: deal.average || null } : null,
    newer: newer || [],
  };
}

module.exports = { savingPotential, MIN_SAVING_USD, storeTarget, rejectedOut, rejCat, parseDate, parseExpiry, ageDays, normalizeFinding, evaluate, pickBest, shape, storeLinks, matchDeal, buildFallback, normUrl, PREDICT, human, iso };
