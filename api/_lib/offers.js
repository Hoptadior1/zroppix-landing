'use strict';
// Deterministic helpers for offers: verification status, de-duplication, the best compatible savings combination,
// and what may be remembered between searches. No AI is used here, so none of it costs tokens.
const { normName } = require('./util');

const r2 = (n) => Math.round(n * 100) / 100;
const CONDS = new Set(['new_customer', 'min_purchase', 'account_required', 'membership', 'excludes_product', 'app_only', 'limited_stock', 'not_stackable', 'eligibility', 'points', 'in_store_only']);
const PROMO_TYPES = new Set(['card', 'rebate', 'trade_in', 'gift_card', 'eligibility', 'loyalty', 'bundle', 'price_protection', 'payment', 'other']);
const PROVIDERS = new Set(['rakuten', 'topcashback', 'top cashback', 'shopback', 'capital one shopping', 'ibotta', 'befrugal', 'extrabux', 'swagbucks', 'retailmenot', 'honey', 'paypal honey']);

const isProvider = (s) => PROVIDERS.has(normName(s || ''));
const sameStore = (a, b) => { const x = normName(a || ''), y = normName(b || ''); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

function conditionsOf(f) {
  const out = new Set();
  (Array.isArray(f.conditions) ? f.conditions : []).forEach((c) => { const k = String(c || '').toLowerCase().replace(/[^a-z_]/g, ''); if (CONDS.has(k)) out.add(k); });
  if (f.minPurchase > 0) out.add('min_purchase');
  if (f.kind === 'promo' && ['eligibility', 'loyalty', 'trade_in'].includes(f.promoType)) out.add('eligibility');
  return Array.from(out);
}

// verified   : read straight from the store's own product data today (an official API), nothing else.
// available  : published with a date by a credible page, but not tested by us. Several coupon sites listing a code does not change that.
// conditional: needs eligibility, a minimum spend, a new account, a card and so on.
// expired    : its own expiry date has passed (kept out of results; used when a remembered offer is reused).
// unverified : not enough evidence to say more.
function statusOf(f, now) {
  now = now || new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (f.expiresIso && Date.parse(f.expiresIso + 'T00:00:00Z') < today) return 'expired';
  if (f.verified === true) return 'verified';
  const c = conditionsOf(f);
  if (c.length) return 'conditional';
  if (f.kind === 'newer_model') return 'available';
  if (!f.date && f.kind !== 'cashback') return 'unverified';
  return 'available';
}

const keyOf = (x) => [x.kind, normName(x.store || ''), normName(x.provider || ''), x.price, x.percent, x.amount, (x.code || '').toLowerCase(), x.promoType || ''].join('|');

// Same offer found twice (by both searches, by the store's data, or from memory): keep one, the one with most information.
function dedupe(list) {
  const best = new Map(); let dropped = 0;
  const richness = (x) => (x.verified || x._api ? 8 : 0) + (x.quote ? 2 : 0) + (x.pageDate || x.page_date || x.date ? 2 : 0) + (x.expires || x.expiresIso ? 1 : 0) + (x.code ? 1 : 0);
  (list || []).forEach((x) => {
    if (!x || typeof x !== 'object') return;
    const k = keyOf(Object.assign({}, x, { store: x.store, percent: x.percent, price: x.price, amount: x.amount != null ? x.amount : x.amount_usd, promoType: x.promoType || x.promo_type }));
    const cur = best.get(k);
    if (!cur) best.set(k, x); else { dropped++; if (richness(x) > richness(cur)) best.set(k, x); }
  });
  return { list: Array.from(best.values()), dropped };
}

// Does a store's own product title name this exact model? Used to skip the AI check for store-API prices.
const EDITION = new Set(['pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'se', 'air', 'maxv', 'xl', 'fe', 'neo', 'prime', 'elite', 'premium', 'signature', 'edition', 'sport', 'slim', 'go', 'turbo', 'classic']);
// Conservative: true only when the listing names this exact model. Anything unsure goes to the AI check instead.
// Every word and model number of the product must be in the title (the brand may be missing), and the title must not add an edition word
// ("Pro", "Max", "Ultra", "Plus", "Mini"...) the product does not have.
function modelMatches(productName, title) {
  const tok = (s) => normName(s).split(' ').filter(Boolean);
  const a = tok(productName).filter((t) => t.length > 1 && !['the', 'and', 'with', 'new', 'inch', 'in'].includes(t));
  const bArr = tok(title), b = new Set(bArr), aSet = new Set(a);
  if (!a.some((t) => /\d/.test(t))) return false;
  if (!a.slice(1).every((t) => b.has(t)) || !a.filter((t) => /\d/.test(t)).every((t) => b.has(t))) return false;
  if (bArr.some((t) => EDITION.has(t) && !aSet.has(t))) return false;
  return true;
}

const today0 = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const alive = (x, now) => !x.expiresIso || Date.parse(x.expiresIso + 'T00:00:00Z') >= today0(now);
const money = (n) => '$' + (n % 1 ? n.toFixed(2) : String(n));

// The cheapest legitimate way to buy, from what we found. Only offers that can be combined are combined:
//  - one coupon for that store (the one taking most off), unless it says it cannot be stacked and a cashback exists, then the better single one wins
//  - cashback for that store (estimated on the price after the coupon; advertised, never guaranteed)
//  - stated-amount card, gift-card or payment credits for that store (or any store). Those that need eligibility are listed apart as "if eligible".
// Rewards points and anything without a stated amount are never counted as cash.
function bestCombo(accepted, now) {
  now = now || new Date();
  const prices = accepted.filter((a) => a.kind === 'price' && a.price > 0 && a.currency === 'USD' && !a.condition);
  if (!prices.length) return null;
  const coupons = accepted.filter((a) => a.kind === 'coupon' && alive(a, now));
  const cashbacks = accepted.filter((a) => a.kind === 'cashback' && a.percent > 0);
  const promos = accepted.filter((a) => a.kind === 'promo' && a.amount > 0 && alive(a, now));
  const cands = prices.map((p) => {
    const ship = p.shipping && p.shipping.cost != null ? p.shipping.cost : 0;
    const shipKnown = !!(p.shipping && (p.shipping.state === 'free' || p.shipping.state === 'paid'));
    const comps = []; const notes = [];
    // coupon
    let off = 0, cpn = null;
    coupons.filter((c) => sameStore(c.store, p.store)).forEach((c) => {
      if (c.minPurchase > 0 && p.price < c.minPurchase) return;
      const v = c.percent > 0 ? r2(p.price * c.percent / 100) : c.price > 0 && c.price < p.price ? r2(c.price) : 0;
      if (v > off) { off = v; cpn = c; }
    });
    const checkout = r2(p.price - off + ship);
    if (cpn) comps.push({ type: 'coupon', usd: off, status: statusOf(cpn, now), label: (cpn.code ? 'Code ' + cpn.code : 'Coupon') + ' at ' + p.store + (cpn.expiresIso ? ', ends ' + cpn.expiresIso : ''), code: cpn.code || '', id: cpn.id });
    // cashback
    let cb = 0, cbo = null;
    cashbacks.filter((c) => sameStore(c.store, p.store) || (isProvider(c.store) && normName((c.note || '') + ' ' + (c.title || '')).includes(normName(p.store)))).forEach((c) => {
      const v = r2((p.price - off) * c.percent / 100); if (v > cb) { cb = v; cbo = c; }
    });
    if (cpn && cbo && (conditionsOf(cpn).includes('not_stackable') || conditionsOf(cbo).includes('not_stackable'))) {
      // cannot be used together: keep the one worth more
      if (cb > off) { comps.pop(); off = 0; } else { cb = 0; cbo = null; notes.push('The coupon and the cashback say they cannot be used together, so only the better one is counted.'); }
    }
    const checkout2 = r2(p.price - off + ship);
    if (cbo) comps.push({ type: 'cashback', usd: cb, status: statusOf(cbo, now), label: cbo.percent + '% cashback' + (cbo.provider ? ' via ' + cbo.provider : isProvider(cbo.store) ? ' via ' + cbo.store : '') + ' (advertised, paid later' + (off > 0 ? ', estimated on the price after the coupon' : '') + ')', id: cbo.id });
    // credits
    let credit = 0, elig = 0;
    promos.filter((c) => !c.store || sameStore(c.store, p.store) || /any|all/.test(normName(c.store))).forEach((c) => {
      const cond = conditionsOf(c);
      if (cond.length) { elig += c.amount; comps.push({ type: 'promo', usd: c.amount, status: 'conditional', label: money(c.amount) + ' ' + (c.promoType || 'offer').replace('_', ' ') + (c.note ? ': ' + c.note : ''), id: c.id, ifEligible: true }); }
      else { credit += c.amount; comps.push({ type: 'promo', usd: c.amount, status: statusOf(c, now), label: money(c.amount) + ' ' + (c.promoType || 'offer').replace('_', ' ') + (c.note ? ': ' + c.note : ''), id: c.id }); }
    });
    const effective = r2(checkout2 - cb - credit);
    return { store: p.store, priceId: p.id, listed: p.listPrice || null, price: p.price, shipping: shipKnown ? ship : null, shipKnown, couponOff: off, checkout: checkout2, cashbackEst: cb, credits: credit, ifEligibleUsd: r2(elig), effective, components: comps, notes, sourceUrl: p.sourceUrl, verified: p.verified === true };
  });
  // The best combination is the one with the lowest effective cost. A known shipping cost beats an unknown one at the same cost.
  cands.sort((x, y) => x.effective - y.effective || (y.shipKnown ? 1 : 0) - (x.shipKnown ? 1 : 0));
  const b = cands[0];
  b.saveUsd = r2(b.couponOff + b.cashbackEst + b.credits); // what the extras take off, never counting anything that needs eligibility
  b.notes = b.notes.concat(['Cashback is paid later by the cashback site and is not guaranteed.', 'Rewards points are not counted as cash.']);
  b.steps = [];
  const cp = b.components.find((c) => c.type === 'coupon'), cbk = b.components.find((c) => c.type === 'cashback');
  if (cbk) b.steps.push('Start from the cashback site or app, then click through to ' + b.store + '.');
  b.steps.push('Add the item at ' + money(b.price) + ' to your cart at ' + b.store + '.');
  if (cp) b.steps.push(cp.code ? 'Enter code ' + cp.code + ' at checkout.' : 'Apply the ' + b.store + ' coupon at checkout.');
  b.components.filter((c) => c.type === 'promo' && !c.ifEligible).forEach((c) => b.steps.push('Pay in the way the offer needs: ' + c.label + '.'));
  return b;
}

// What may be remembered between searches. Prices are not remembered here: they are refreshed by the normal cache.
const MEM_KINDS = new Set(['coupon', 'cashback', 'promo']);
const memoryUsable = (mem, now, hours) => !!(mem && mem.at && now.getTime() - mem.at < hours * 3600 * 1000);
// A remembered offer is re-checked by code before it is used: its own expiry, and the age of the page that stated it.
function reviveItems(items, now, maxAge) {
  const out = [];
  (items || []).forEach((x) => {
    if (!x || !MEM_KINDS.has(x.kind)) return;
    if (!alive(x, now)) return;
    let age = null;
    if (x.date) { age = Math.floor((today0(now) - Date.parse(x.date + 'T00:00:00Z')) / 86400000); if (age > maxAge[x.kind]) return; }
    out.push(Object.assign({}, x, { ageDays: age, fromMemory: true }));
  });
  return out;
}

module.exports = { CONDS, PROMO_TYPES, PROVIDERS, conditionsOf, statusOf, dedupe, keyOf, modelMatches, bestCombo, memoryUsable, reviveItems, sameStore, isProvider, MEM_KINDS };
