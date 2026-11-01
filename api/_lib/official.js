'use strict';
// Manufacturer pages, read live. A brand's own store or outlet page often prints no date, so a search result for it is rejected as undated.
// But when WE load the page during the search, the price on it is true today. This module loads such pages (the brand's own domain only),
// reads the price, condition and stock, and returns findings dated with the day we read them. Every check is done by code:
//   - the page must be on the brand's own domain (also after redirects), over https, on a public address, and allowed by robots.txt
//   - the page name must contain every word of the product name, and no extra edition or generation marker (Series 2, Pro, Max...)
//   - a real price must be printed; a recertified or used unit is never presented as new; a page that says sold out is dropped
//   - stock is shown when stated and left "not stated" otherwise (it is not required)
// Prices come from the page's structured product data (JSON-LD) when present; only otherwise does a small model read trimmed text.
const dns = require('dns').promises;
const net = require('net');
const { clean, normName } = require('./util');

const TIMEOUT_MS = 4500;
const MAX_BYTES = 700000;
const MAX_HOPS = 3;
const UA = 'Mozilla/5.0 (compatible; ZroppixBot/1.0; +https://zroppix.com/is-zroppix-safe)';
const iso = (d) => d.toISOString().slice(0, 10);
const human = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---- brand and domain ----
const GENERIC = new Set(['the', 'new', 'used', 'refurbished', 'apple', 'amazon', 'google', 'microsoft']); // brands that sell through other stores are handled elsewhere
const brandOf = (name) => {
  const t = normName(name).split(' ').filter(Boolean)[0] || '';
  return /^[a-z0-9]{2,20}$/.test(t) && t !== 'the' && t !== 'new' ? t : '';
};
// sony.com, store.sony.com, sonyusa.com, shop-sony.com ... but not "sonysucks.com" or "sony.example.org"
function hostMatchesBrand(host, brand) {
  if (!brand || !host) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const parts = h.split('.');
  if (parts.length < 2) return false;
  const sld = parts.length >= 3 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? parts[parts.length - 3] : parts[parts.length - 2];
  const ok = new Set([brand, brand + 'usa', brand + 'us', brand + 'store', brand + 'shop', 'shop' + brand, 'store' + brand, brand + 'direct', brand + 'official']);
  return ok.has(sld.replace(/-/g, ''));
}

// ---- safe fetching ----
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:'); }
  return true;
}
async function safeUrl(u, brand) {
  let url; try { url = new URL(u); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (net.isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (!hostMatchesBrand(host, brand)) return null;
  try { const addrs = await dns.lookup(host, { all: true }); if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null; } catch (_) { return null; }
  return url;
}
async function withTimeout(url, opts, ms) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); } finally { clearTimeout(timer); }
}
async function readCapped(r) {
  if (!r.body || !r.body.getReader) { const t = await r.text(); return t.slice(0, MAX_BYTES); }
  const reader = r.body.getReader(); const dec = new TextDecoder('utf-8', { fatal: false }); let out = ''; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; out += dec.decode(value, { stream: true }); if (n > MAX_BYTES) { try { await reader.cancel(); } catch (_) { /* done */ } break; } }
  return out;
}
const robotsCache = new Map();
async function robotsAllows(url) {
  const key = url.origin;
  if (!robotsCache.has(key)) {
    let rules = [];
    try {
      const r = await withTimeout(key + '/robots.txt', { headers: { 'User-Agent': UA }, redirect: 'error' }, 2500);
      if (r.ok) {
        const lines = (await readCapped(r)).split(/\r?\n/); let applies = false; let seenAgent = false;
        for (const raw of lines) {
          const line = raw.replace(/#.*/, '').trim(); const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
          const k = m[1].toLowerCase(), v = m[2].trim();
          if (k === 'user-agent') { if (seenAgent === false) applies = false; seenAgent = true; if (v === '*' || /zroppix/i.test(v)) applies = true; }
          else { seenAgent = false; if (applies && k === 'disallow' && v) rules.push(v); if (applies && k === 'allow' && v) rules = rules.filter((x) => !(v.startsWith(x) && v.length >= x.length)); }
        }
      }
    } catch (_) { rules = []; } // robots.txt unreachable: no rules known, nothing is blocked by it
    robotsCache.set(key, rules);
  }
  const path = url.pathname + url.search;
  return !robotsCache.get(key).some((p) => (p === '/' ? true : p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path.startsWith(p)));
}
// Load one page. Redirects are followed by hand so every hop stays on the brand's own domain and a public address.
async function fetchPage(u, brand) {
  let url = await safeUrl(u, brand);
  for (let hop = 0; hop <= MAX_HOPS && url; hop++) {
    if (!(await robotsAllows(url))) return { blocked: 'robots' };
    let r;
    try { r = await withTimeout(url.href, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' }, redirect: 'manual' }); } catch (_) { return { error: 'fetch' }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      let next; try { next = new URL(r.headers.get('location'), url).href; } catch (_) { return { error: 'redirect' }; }
      url = await safeUrl(next, brand); if (!url) return { error: 'redirect_off_domain' }; continue;
    }
    if (!r.ok) return { error: 'http_' + r.status };
    if (!/text\/html|application\/xhtml/i.test(r.headers.get('content-type') || '')) return { error: 'not_html' };
    return { url: url.href, html: await readCapped(r) };
  }
  return { error: 'redirect' };
}

// ---- reading the page ----
const decodeEntities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const visibleText = (html) => decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const metaOf = (html, prop) => { const m = String(html).match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[:.]/g, '\\$&') + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) || String(html).match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop.replace(/[:.]/g, '\\$&') + '["\']', 'i')); return m ? decodeEntities(m[1]) : ''; };
const titleOf = (html) => { const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''; };
const h1Of = (html) => { const m = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); return m ? visibleText(m[1]) : ''; };

function jsonLdProducts(html) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== 'object') return;
    const t = [].concat(n['@type'] || []).map(String);
    if (t.some((x) => /^(Product|ProductGroup|IndividualProduct|Offer|AggregateOffer)$/.test(x)) && t.some((x) => /Product/.test(x))) out.push(n);
    if (n['@graph']) walk(n['@graph']);
    if (n.mainEntity) walk(n.mainEntity);
    if (n.hasVariant) walk(n.hasVariant);
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html)) && out.length < 12) { try { walk(JSON.parse(m[1].trim())); } catch (_) { /* a broken block is ignored */ } }
  return out;
}
const tail = (s) => String(s || '').split('/').pop().toLowerCase();
const COND = (s) => { const x = tail(s); return /refurb|recert|renewed/.test(x) ? 'refurbished' : /used|damaged/.test(x) ? 'used' : /new/.test(x) ? 'new' : ''; };
const STOCK = (s) => { const x = tail(s); return /outofstock|soldout|discontinued/.test(x) ? 'out_of_stock' : /instock|limitedavailability|onlineonly|instoreonly|backorder|preorder|presale/.test(x) ? (/instoreonly/.test(x) ? 'unknown' : 'in_stock') : 'unknown'; };
const priceNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

// Structured data -> candidates {name, price, currency, condition, stock, listPrice, quote}
function fromStructured(html) {
  const cands = [];
  for (const p of jsonLdProducts(html)) {
    const name = clean(p.name || '', 200);
    let offers = p.offers; if (!offers && /Offer/.test([].concat(p['@type']).join(' '))) offers = p;
    for (const o of [].concat(offers || [])) {
      if (!o || typeof o !== 'object') continue;
      const spec = [].concat(o.priceSpecification || []);
      const price = priceNum(o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : spec[0] && spec[0].price);
      if (!price) continue;
      const listSpec = spec.find((s) => s && /list|msrp|strike/i.test(String(s.priceType || '')));
      cands.push({ name, price, currency: String(o.priceCurrency || (spec[0] && spec[0].priceCurrency) || '').toUpperCase(), condition: COND(o.itemCondition || p.itemCondition), stock: STOCK(o.availability), listPrice: listSpec ? priceNum(listSpec.price) : null, quote: name + ' ' + price, via: 'jsonld' });
    }
  }
  if (!cands.length) { // OpenGraph product tags
    const amt = priceNum(metaOf(html, 'product:price:amount') || metaOf(html, 'og:price:amount'));
    if (amt) cands.push({ name: clean(metaOf(html, 'og:title') || h1Of(html) || titleOf(html), 200), price: amt, currency: (metaOf(html, 'product:price:currency') || metaOf(html, 'og:price:currency')).toUpperCase(), condition: '', stock: STOCK(metaOf(html, 'product:availability') || metaOf(html, 'og:availability')), listPrice: null, quote: '', via: 'meta' });
  }
  return cands;
}

// A short, price-centred excerpt of the visible text, for the small model. Never the whole page.
function excerpt(html) {
  const t = visibleText(html); const parts = [t.slice(0, 900)]; const re = /[$£€]\s?\d[\d,]*(?:\.\d{2})?/g; let m; let n = 0; let last = -1000;
  while ((m = re.exec(t)) && n < 5) { if (m.index - last < 260) continue; last = m.index; n++; parts.push(t.slice(Math.max(0, m.index - 140), m.index + 200)); }
  return parts.join(' … ').slice(0, 3200);
}
const AI_SYSTEM = 'You read the text of ONE product page and report only what the page itself states. Reply with JSON only: {"name":string,"price":number|null,"currency":"USD"|string|null,"list_price":number|null,"condition":"new"|"refurbished"|"used"|"unknown","stock":"in_stock"|"out_of_stock"|"unknown","quote":string}. price = the current selling price of this exact product. list_price = a regular, MSRP or original price printed on the page that is higher than price, otherwise null. condition: "refurbished" for recertified, renewed, open-box or refurbished; "used" for pre-owned. Never guess: use null or "unknown" when the page does not say.';

// ---- matching and validation (code only) ----
const GEN = new Set(['series', 'gen', 'generation', 'mark', 'mk', 'ii', 'iii', 'iv', '2nd', '3rd', '4th', '5th']);
const NOT_EDITION = new Set(['premium', 'edition', 'classic', 'prime', 'go', 'elite']);
const EDITION = new Set(['pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'se', 'air', 'maxv', 'xl', 'fe', 'neo', 'signature', 'sport', 'slim', 'turbo', 'limited', 'special']);
const FILLER = new Set(['the', 'and', 'with', 'new', 'inch', 'in', 'a', 'an']);
function officialMatch(query, name) {
  const q = normName(query).split(' ').filter((t) => t && !FILLER.has(t));
  if (!q.some((t) => /\d/.test(t)) && q.length < 3) return false; // a model needs a number or at least three words; a bare family name is too loose
  const full = new Set(normName(name).split(' ').filter(Boolean));
  if (!q.every((t) => full.has(t))) return false;
  const head = normName(String(name).split(/\s[-–—|:]\s|,/)[0]).split(' ').filter(Boolean); // the part before the marketing description
  const qs = new Set(q);
  return !head.some((t) => !qs.has(t) && (GEN.has(t) || (EDITION.has(t) && !NOT_EDITION.has(t))));
}
const stateOf = (text) => /\b(recertified|refurbished|renewed|open[- ]box|pre-owned|certified pre)\b/i.test(text) ? 'refurbished' : /\bused\b/i.test(text) ? 'used' : '';

// Turn one candidate into a finding, or say why not. Returns {finding} or {why}.
function toFinding(cand, ctx) {
  const { product, url, pageTitle, now, idx, brandName } = ctx;
  const names = [cand.name, pageTitle].filter(Boolean);
  const matched = names.some((n) => officialMatch(product.name + (product.variant ? ' ' + product.variant : ''), n));
  if (!matched) return { why: 'different or unconfirmed model' };
  if (!(cand.price >= 1 && cand.price <= 100000)) return { why: 'no usable price' };
  if (cand.currency && cand.currency !== 'USD') return { why: 'not a US dollar price' };
  if (cand.stock === 'out_of_stock') return { why: 'sold out' };
  // Condition: what the page says, but the page name, title and web address can only make it more cautious, never less.
  const named = stateOf([cand.name, pageTitle, url].join(' ').replace(/[-_/]/g, ' '));
  let condition = cand.condition && cand.condition !== 'unknown' ? cand.condition : '';
  if (named && (!condition || condition === 'new')) condition = named;
  if (!condition || (condition === 'new' && /\/(outlet|clearance|open-?box|scratch|dent)/i.test(url))) condition = /\/(outlet|clearance|open-?box|scratch|dent)/i.test(url) ? 'unknown' : 'new'; // an outlet page that calls its stock "new" is not trusted
  if (condition === 'unknown') return { why: 'condition not stated on an outlet page' };
  if (condition === 'used') return { why: 'used condition' };
  const f = {
    _api: true, _live: true, id: 'of' + idx, kind: condition === 'new' ? 'price' : 'refurb', store: brandName + (condition === 'new' ? '' : ' (' + (named === 'refurbished' && /recert/i.test([cand.name, pageTitle, url].join(' ')) ? 'recertified' : 'refurbished') + ')'),
    title: clean(cand.name || pageTitle, 140), price: cand.price, list_price: cand.listPrice && cand.listPrice > cand.price ? cand.listPrice : null, currency: 'USD',
    page_date: iso(now), source_url: url.split('#')[0], source_title: brandName + ' product page, read live', quote: clean(cand.quote || cand.name, 160),
    condition: condition === 'new' ? 'new' : (/recert/i.test([cand.name, pageTitle, url].join(' ')) ? 'recertified' : 'refurbished'), seller: 'manufacturer', ships: 'unknown', shipping: 'not_stated', shipping_cost: null,
    stock: cand.stock === 'in_stock' ? 'in_stock' : 'unknown', note: cand.stock === 'in_stock' ? '' : 'Availability not stated, check the page',
  };
  return { finding: f };
}

// Candidate pages: results on the brand's own domain, best-looking first.
function pickUrls(results, product, brand, limit) {
  const toks = normName(product.name).split(' ').filter((t) => t.length > 1 && t !== brand);
  const seen = new Set(); const list = [];
  for (const r of results || []) {
    let u; try { u = new URL(r.url); } catch (_) { continue; }
    if (u.protocol !== 'https:' || !hostMatchesBrand(u.hostname, brand)) continue;
    u.hash = ''; const key = u.origin + u.pathname; if (seen.has(key)) continue; seen.add(key);
    const hay = normName(decodeURIComponent(u.pathname).replace(/[-_/.]/g, ' ') + ' ' + (r.title || ''));
    const score = toks.filter((t) => hay.includes(t)).length * 2 + (/\b(outlet|refurb|recert|certified|clearance|open box|shop|buy|store|product)\b/.test(hay) ? 1 : 0);
    if (score > 0) list.push({ url: u.href, score });
  }
  return list.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.url);
}

// Main entry. `callAi({system, user})` -> {text, costUsd} is optional; without it only structured data is used.
async function collect({ product, country, results, now, callAi, maxPages, budgetMs, forceUrls }) {
  const out = { findings: [], results: [], tried: [], costUsd: 0 };
  try {
    if (country !== 'US') return out;
    const brand = brandOf(product.name);
    if (!brand || GENERIC.has(brand)) return out;
    const urls = forceUrls && forceUrls.length ? forceUrls.slice(0, 3) : pickUrls(results, product, brand, maxPages || 3);
    if (!urls.length) return out;
    const brandName = brand.charAt(0).toUpperCase() + brand.slice(1);
    const deadline = Date.now() + (budgetMs || 8000); let aiUsed = 0;
    const pages = await Promise.all(urls.map((u) => fetchPage(u, brand).then((p) => Object.assign({ asked: u }, p)).catch(() => ({ asked: u, error: 'fetch' }))));
    let idx = 0; const seenKey = new Set();
    for (const p of pages) {
      const rec = { url: p.asked }; out.tried.push(rec);
      if (!p.html) { rec.skipped = p.blocked || p.error; continue; }
      if (Date.now() > deadline) { rec.skipped = 'out_of_time'; continue; }
      const pageTitle = clean(h1Of(p.html) || titleOf(p.html), 200);
      let cands = fromStructured(p.html);
      if (!cands.length && callAi && aiUsed < 2 && officialMatch(product.name, pageTitle || '') ) {
        aiUsed++;
        try {
          const r = await callAi({ system: AI_SYSTEM, user: 'Page title: ' + pageTitle + '\nWeb address: ' + p.url + '\nPage text:\n' + excerpt(p.html) });
          out.costUsd += r.costUsd || 0;
          const m = String(r.text || '').match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
          if (j && priceNum(j.price)) cands = [{ name: clean(j.name || pageTitle, 200), price: priceNum(j.price), currency: String(j.currency || 'USD').toUpperCase(), condition: ['new', 'refurbished', 'used'].includes(j.condition) ? j.condition : '', stock: j.stock === 'in_stock' || j.stock === 'out_of_stock' ? j.stock : 'unknown', listPrice: priceNum(j.list_price), quote: clean(j.quote, 160), via: 'ai' }];
        } catch (_) { /* the model's answer is optional */ }
      }
      if (!cands.length) { rec.skipped = 'no_price_found'; continue; }
      for (const c of cands.slice(0, 3)) {
        const t = toFinding(c, { product, url: p.url, pageTitle, now, idx: idx + 1, brandName });
        if (!t.finding) { rec.skipped = t.why; continue; }
        const key = t.finding.kind + '|' + t.finding.price + '|' + t.finding.condition; if (seenKey.has(key)) continue; seenKey.add(key);
        idx++; out.findings.push(t.finding); rec.found = { price: t.finding.price, kind: t.finding.kind, via: c.via };
        if (!out.results.some((x) => x.url === t.finding.source_url)) out.results.push({ url: t.finding.source_url, title: t.finding.source_title, page_age: t.finding.page_date, api: true });
      }
    }
  } catch (_) { /* silent: the normal search still stands */ }
  out.findings = out.findings.slice(0, 3);
  return out;
}

module.exports = { collect, brandOf, hostMatchesBrand, officialMatch, fromStructured, toFinding, pickUrls, safeUrl, fetchPage, privateIp, excerpt, visibleText, AI_SYSTEM };
