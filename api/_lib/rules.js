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
  };
}

function normUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '');
  } catch (_) { return null; }
}

function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; }

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
  const accepted = []; const rejected = []; const stale = [];

  (rawFindings || []).slice(0, 20).forEach((raw, i) => {
    const f = normalizeFinding(raw, i);
    const who = f.store || 'Unnamed store';
    const what = f.kind === 'price' || f.kind === 'refurb' ? (f.price != null ? who + ' ' + f.currency + ' ' + f.price : who)
      : f.kind === 'cashback' ? who + (f.percent != null ? ' ' + f.percent + '% cashback' : ' cashback')
      : f.kind === 'coupon' ? who + (f.code ? ' code ' + f.code : ' coupon')
      : who + (f.title ? ' ' + f.title.slice(0, 40) : '');
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
    if (!d) return rej('no date on the page');
    const age = ageDays(d, now);

    // Kind-specific facts
    let limit = maxAge;
    if (f.kind === 'newer_model') limit = 365;
    if (f.kind === 'price' || f.kind === 'refurb') {
      if (!(f.price > 0) || f.price > 100000) return rej('no usable price');
    }
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
    if (j && (j.same_product === false || j.verdict === 'reject')) return rej(j.reason || 'not the same product');

    const item = Object.assign({}, f, { date: iso(d), dateHuman: human(d), ageDays: age, expiresIso: f.expiresIso || null });
    if (age > limit) {
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
  return { accepted, rejected, stale };
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
function shape(ev, tier, extras) {
  const best = pickBest(ev.accepted);
  const rest = ev.accepted.filter((a) => a !== best && a.kind !== 'newer_model');
  const newer = ev.accepted.filter((a) => a.kind === 'newer_model').slice(0, 1);
  const pub = (a) => ({
    id: a.id, kind: a.kind, store: a.store, title: a.title, price: a.price, currency: a.currency, percent: a.percent,
    code: a.code, expires: a.expiresIso, date: a.date, dateHuman: a.dateHuman, ageDays: a.ageDays,
    sourceUrl: a.sourceUrl, sourceTitle: a.sourceTitle, seller: a.seller, condition: a.condition, ships: a.ships, note: a.note,
  });
  const out = {
    best: best ? pub(best) : null,
    newer: newer.map(pub),
    rejected: ev.rejected.slice(0, 8).map((r) => ({ what: r.what, why: r.why })),
    warnings: [],
  };
  // Safety information is never locked.
  if (best && best.seller === 'third_party') out.warnings.push('The best offer is from a third-party seller, not the manufacturer or the store itself. Check the seller rating and return terms before you buy.');
  if (best && best.ships === 'no') out.warnings.push('The store may not ship to your country. Check before you rely on this price.');
  if (tier === 'pro') out.others = rest.map(pub);
  else {
    const counts = {};
    rest.forEach((a) => { counts[a.kind] = (counts[a.kind] || 0) + 1; });
    out.locked = counts; // counts only, never the details
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
  return bs >= 0.75 ? { slug: best.slug, title: best.title } : null;
}

function buildFallback({ productName, country, stale, deal, newer, hadSearchError }) {
  const lastSeen = (stale || []).slice().sort((a, b) => a.ageDays - b.ageDays)[0] || null;
  return {
    reason: hadSearchError ? 'search_unavailable' : 'no_current_offer',
    lastSeen: lastSeen ? { store: lastSeen.store, price: lastSeen.price, currency: lastSeen.currency, dateHuman: lastSeen.dateHuman, ageDays: lastSeen.ageDays, sourceUrl: lastSeen.sourceUrl, sourceTitle: lastSeen.sourceTitle } : null,
    links: storeLinks(productName, country),
    history: deal ? { url: '/deals/' + deal.slug, title: deal.title } : null,
    newer: newer || [],
  };
}

module.exports = { parseDate, parseExpiry, ageDays, normalizeFinding, evaluate, pickBest, shape, storeLinks, matchDeal, buildFallback, normUrl, PREDICT, human, iso };
