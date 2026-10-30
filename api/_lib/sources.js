'use strict';
// Official store product APIs: real prices read straight from the store, with no AI reading needed and no search cost.
// A source is used only when its key is set. Every failure is silent: the web search still runs without it.
// Findings use the same shape as the web search, so they go through the same date, source and same-product checks.
const { cfg } = require('./config');
const { clean } = require('./util');

const TIMEOUT_MS = 4500;
const iso = (d) => d.toISOString().slice(0, 10);
const human = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function getJson(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

const words = (name) => String(name || '').replace(/[()"']/g, ' ').split(/\s+/).filter((w) => w.length > 1 && /^[A-Za-z0-9\-\.]+$/.test(w)).slice(0, 8);

// Best Buy (United States only). https://bestbuyapis.github.io/api-documentation/
async function bestBuy(product, country, now) {
  const c = cfg();
  if (!c.bestBuyKey || country !== 'US') return [];
  const w = words(product.name + (product.variant ? ' ' + product.variant : ''));
  if (w.length < 2) return [];
  const q = '(' + w.map((x) => 'search=' + encodeURIComponent(x)).join('&') + ')';
  const j = await getJson('https://api.bestbuy.com/v1/products' + q + '?apiKey=' + encodeURIComponent(c.bestBuyKey) + '&format=json&pageSize=4&sort=salePrice.asc&show=sku,name,salePrice,regularPrice,url,freeShipping,shippingCost,condition');
  const out = [];
  (j && Array.isArray(j.products) ? j.products : []).forEach((p, i) => {
    if (!p || !(p.salePrice > 0) || !p.url || (p.condition && String(p.condition).toLowerCase() !== 'new')) return;
    const ship = p.freeShipping === true ? { shipping: 'free', shipping_cost: null } : p.shippingCost > 0 ? { shipping: 'paid', shipping_cost: p.shippingCost } : { shipping: 'not_stated', shipping_cost: null };
    out.push(Object.assign({
      id: 'bb' + (i + 1), kind: 'price', store: 'Best Buy', title: clean(p.name, 140), price: p.salePrice, list_price: p.regularPrice > p.salePrice ? p.regularPrice : null, currency: 'USD',
      page_date: iso(now), source_url: String(p.url).split('?')[0], source_title: 'Best Buy product listing',
      quote: 'Best Buy lists this at $' + p.salePrice + ' (read ' + human(now) + ')', seller: 'retailer', ships: 'unknown', note: 'Price read from Best Buy today',
    }, ship));
  });
  return out;
}

// eBay Browse API: new items at a fixed price. Third-party sellers, so the seller is marked as such.
let ebayTok = null;
const EBAY_SITE = { US: 'EBAY_US', GB: 'EBAY_GB', DE: 'EBAY_DE', CA: 'EBAY_CA', AU: 'EBAY_AU' };
async function ebayToken(c) {
  if (ebayTok && ebayTok.exp > Date.now() + 60000) return ebayTok.v;
  const j = await getJson('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(c.ebayId + ':' + c.ebaySecret).toString('base64') }, body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope') });
  if (!j || !j.access_token) return null;
  ebayTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 1000 };
  return ebayTok.v;
}
async function ebay(product, country, now) {
  const c = cfg();
  if (!c.ebayId || !c.ebaySecret || !EBAY_SITE[country]) return [];
  const tok = await ebayToken(c);
  if (!tok) return [];
  const q = words(product.name + (product.variant ? ' ' + product.variant : '')).join(' ');
  if (q.length < 3) return [];
  const j = await getJson('https://api.ebay.com/buy/browse/v1/item_summary/search?limit=4&sort=price&filter=' + encodeURIComponent('conditions:{NEW},buyingOptions:{FIXED_PRICE}') + '&q=' + encodeURIComponent(q), { headers: { authorization: 'Bearer ' + tok, 'x-ebay-c-marketplace-id': EBAY_SITE[country] } });
  const out = [];
  (j && Array.isArray(j.itemSummaries) ? j.itemSummaries : []).forEach((p, i) => {
    const price = p && p.price ? Number(p.price.value) : 0;
    if (!(price > 0) || !p.itemWebUrl) return;
    const sc = p.shippingOptions && p.shippingOptions[0] && p.shippingOptions[0].shippingCost ? Number(p.shippingOptions[0].shippingCost.value) : null;
    const ship = sc === 0 ? { shipping: 'free', shipping_cost: null } : sc > 0 ? { shipping: 'paid', shipping_cost: sc } : { shipping: 'not_stated', shipping_cost: null };
    const fb = p.seller && p.seller.feedbackPercentage ? ' Seller ' + p.seller.feedbackPercentage + '% positive.' : '';
    out.push(Object.assign({
      id: 'eb' + (i + 1), kind: 'price', store: 'eBay', title: clean(p.title, 140), price, list_price: null, currency: String((p.price && p.price.currency) || 'USD').toUpperCase(),
      page_date: iso(now), source_url: String(p.itemWebUrl).split('?')[0], source_title: 'eBay listing',
      quote: 'eBay lists this new item at ' + price + ' (read ' + human(now) + ')', condition: 'new', seller: 'third_party', ships: 'unknown', note: ('Third-party seller.' + fb).slice(0, 100),
    }, ship));
  });
  return out;
}

// Runs every configured source at the same time. Never throws.
async function fetchAll(product, country, now) {
  try {
    const parts = await Promise.all([bestBuy(product, country, now).catch(() => []), ebay(product, country, now).catch(() => [])]);
    const findings = parts.reduce((a, b) => a.concat(b), []).slice(0, 6);
    return { findings, results: findings.map((f) => ({ url: f.source_url, title: f.source_title, page_age: f.page_date, api: true })) };
  } catch (_) { return { findings: [], results: [] }; }
}

module.exports = { fetchAll, bestBuy, ebay, words };
