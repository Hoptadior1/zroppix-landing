'use strict';
const { cfg } = require('./config');

// Sends one email through Resend. Returns {ok, retry}. retry=true means "try again later" (rate limit or outage).
async function sendEmail({ to, subject, html, text, headers }) {
  const c = cfg();
  if (!c.resendKey) return { ok: false, retry: false, error: 'email_not_configured' };
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ from: c.fromEmail, to: [to], subject, html, text }, headers ? { headers } : {})),
    });
  } catch (_) { return { ok: false, retry: true, error: 'network' }; }
  if (r.ok) return { ok: true };
  return { ok: false, retry: r.status === 429 || r.status >= 500, error: 'http_' + r.status };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function confirmEmail(link, bonus) {
  return {
    subject: 'Confirm your email to unlock ' + bonus + ' more free checks',
    text: 'Confirm your email and we will add ' + bonus + ' more free "Find cheaper" checks:\n' + link + '\n\nThe link works for 7 days. If you did not ask for this, ignore this email and nothing happens.\n\nZroppix is independent and not affiliated with Amazon or any store.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="margin:0 0 12px">Confirm your email</h2><p>Confirm and we will add <b>' + bonus + ' more free checks</b> to the browser you used.</p><p><a href="' + esc(link) + '" style="display:inline-block;background:#C9A84C;color:#0D0D14;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none">Confirm my email</a></p><p style="font-size:13px;color:#666">The link works for 7 days. If you did not ask for this, ignore this email and nothing happens.</p><p style="font-size:12px;color:#888">Zroppix is independent and not affiliated with Amazon or any store.</p></div>',
  };
}

function waitlistEmail() {
  return {
    subject: 'You are on the Zroppix Pro waitlist',
    text: 'You are on the Zroppix Pro waitlist. We will email you once when Pro opens. We will not use your address for anything else.\n\nZroppix is independent and not affiliated with Amazon or any store.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="margin:0 0 12px">You are on the list</h2><p>We will email you <b>once</b> when Pro opens. We will not use your address for anything else.</p><p style="font-size:12px;color:#888">Zroppix is independent and not affiliated with Amazon or any store.</p></div>',
  };
}

function proLoginEmail(link, product) {
  return {
    subject: 'Your Zroppix Pro sign-in link',
    text: 'Use this link to sign in to Zroppix Pro on this device:\n' + link + (product ? '\n\nWe will search again for ' + product + ' once you are in, so you see everything that was locked.' : '') + '\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email and nothing happens. Never forward this link: anyone who opens it gets into your Pro access.\n\nZroppix is independent and not affiliated with Amazon or any store.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="margin:0 0 12px">Sign in to Zroppix Pro</h2><p>Use the button to sign in on this device. The link works <b>once</b> and expires in 15 minutes.</p>' + (product ? '<p>Once you are in we will search again for <b>' + esc(product) + '</b>, so you see everything that was locked.</p>' : '') + '<p style="margin:20px 0"><a href="' + esc(link) + '" style="background:#C9A84C;color:#0D0D14;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px;display:inline-block">Sign in to Pro</a></p><p style="font-size:13px;color:#555">If you did not ask for this, ignore this email and nothing happens. Never forward this link: anyone who opens it gets into your Pro access.</p><p style="font-size:12px;color:#777">Zroppix is independent and not affiliated with Amazon or any store.</p></div>',
  };
}

const FOOT = '<p style="font-size:12px;color:#888">Zroppix is independent and not affiliated with Amazon or any store.</p>';
const BTN = 'display:inline-block;background:#C9A84C;color:#0D0D14;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none';
const money = (n, cur) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch (_) { return (cur || '$') + ' ' + n; } };

function watchConfirmEmail({ link, name, days }) {
  return {
    subject: 'Confirm: watch ' + name + ' for you',
    text: 'You asked Zroppix to watch ' + name + '.\nConfirm and we will search for it again every day for ' + days + ' days, and email you once when a dated offer passes our checks:\n' + link + '\n\nIf you did not ask for this, ignore this email and nothing happens.\n\n' + 'Zroppix is independent and not affiliated with Amazon or any store.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="margin:0 0 12px">Watch this product?</h2><p>You asked us to watch <b>' + esc(name) + '</b>.</p><p>Confirm and we will search for it again every day for ' + days + ' days, and email you <b>once</b> when a dated offer passes our checks.</p><p style="margin:20px 0"><a href="' + esc(link) + '" style="' + BTN + '">Confirm and start watching</a></p><p style="font-size:13px;color:#666">If you did not ask for this, ignore this email and nothing happens.</p>' + FOOT + '</div>',
  };
}

// The alert. Free subscribers see the offer and that a coupon or cashback exists; Pro subscribers also see the codes and stores.
function watchAlertEmail({ name, best, extras, pro, findUrl, stopUrl, unsubUrl }) {
  const when = best.dateHuman ? ' · reported ' + best.dateHuman + (best.ageDays != null ? ' (' + (best.ageDays === 0 ? 'today' : best.ageDays + (best.ageDays === 1 ? ' day ago' : ' days ago')) + ')' : '') : '';
  const lines = [];
  for (const x of extras || []) {
    if (x.kind === 'coupon') lines.push(pro && x.code ? 'Coupon ' + x.code + (x.percent ? ' (' + x.percent + '% off)' : '') + ' at ' + x.store + (x.expires ? ', valid until ' + x.expires : '') : 'A coupon' + (x.percent ? ' (' + x.percent + '% off)' : '') + ' valid until ' + (x.expires || 'a stated date'));
    else if (x.kind === 'cashback') lines.push(pro ? 'Cashback ' + x.percent + '% at ' + x.store : x.percent + '% cashback');
  }
  const proLine = pro ? '' : (lines.length ? 'Codes, stores and totals with shipping are in Pro: https://zroppix.com/lifetime' : '');
  return {
    subject: 'A dated offer turned up for ' + name,
    headers: { 'List-Unsubscribe': '<' + unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    text: 'You asked us to watch ' + name + '. Today\'s search found an offer that passed our checks.\n\n' + money(best.price, best.currency) + ' at ' + best.store + when + '\nPrice before shipping and taxes. It may have ended, so check the live price and seller before you buy.\nSource: ' + best.sourceUrl + '\n' + (lines.length ? '\nAlso found: ' + lines.join('; ') + '\n' : '') + (proLine ? proLine + '\n' : '') + '\nWe search again every day and only email you when something real passes our checks. No price predictions, no countdowns.\n\nYou get this because you asked us to watch this product.\nStop watching this product: ' + stopUrl + '\nUnsubscribe from all alerts: ' + unsubUrl,
    html: '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#222"><div style="font-weight:800;color:#A9842E;font-size:18px;margin-bottom:12px">Zroppix</div><p style="font-size:16px;margin:0 0 12px">You asked us to watch <b>' + esc(name) + '</b>. Today\'s search found an offer that passed our checks.</p><div style="border:1px solid #E3C978;background:#FFFAF0;border-radius:10px;padding:16px;margin:16px 0"><div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:#8A6D1F">OFFER FOUND</div><div style="font-size:30px;font-weight:800;margin:4px 0">' + esc(money(best.price, best.currency)) + '</div><div style="font-size:14px;color:#555">' + esc(best.store) + esc(when) + '</div><div style="font-size:13px;color:#777;margin-top:6px">Price before shipping and taxes. It may have ended, so check the live price and seller before you buy.</div><a href="' + esc(best.sourceUrl) + '" style="' + BTN + ';margin-top:14px">See the source</a></div>' + (lines.length ? '<p style="font-size:14px;color:#444;margin:0 0 8px"><b>Also found:</b> ' + lines.map(esc).join('; ') + '.' + (pro ? '' : ' <a href="https://zroppix.com/lifetime" style="color:#8A6D1F">Codes and stores are in Pro</a>.') + '</p>' : '') + '<p style="font-size:13px;color:#777;margin:14px 0 0">We search again every day and only email you when something real passes our checks. No price predictions, no countdowns. <a href="' + esc(findUrl) + '" style="color:#555">Open in Zroppix</a></p><hr style="border:none;border-top:1px solid #eee;margin:20px 0 12px"><p style="font-size:12px;color:#777;margin:0">You get this because you asked us to watch this product. <a href="' + esc(stopUrl) + '" style="color:#555">Stop watching this product</a> · <a href="' + esc(unsubUrl) + '" style="color:#555">Unsubscribe from all alerts</a></p>' + FOOT + '</div>',
  };
}

module.exports = { sendEmail, confirmEmail, waitlistEmail, proLoginEmail, watchConfirmEmail, watchAlertEmail };
