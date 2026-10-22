'use strict';
const { cfg } = require('./config');

// Sends one email through Resend. Returns {ok, retry}. retry=true means "try again later" (rate limit or outage).
async function sendEmail({ to, subject, html, text }) {
  const c = cfg();
  if (!c.resendKey) return { ok: false, retry: false, error: 'email_not_configured' };
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.fromEmail, to: [to], subject, html, text }),
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

function proLoginEmail(link) {
  return {
    subject: 'Your Zroppix Pro sign-in link',
    text: 'Use this link to sign in to Zroppix Pro on this device:\n' + link + '\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email and nothing happens. Never forward this link: anyone who opens it gets into your Pro access.\n\nZroppix is independent and not affiliated with Amazon or any store.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="margin:0 0 12px">Sign in to Zroppix Pro</h2><p>Use the button to sign in on this device. The link works <b>once</b> and expires in 15 minutes.</p><p style="margin:20px 0"><a href="' + esc(link) + '" style="background:#C9A84C;color:#0D0D14;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px;display:inline-block">Sign in to Pro</a></p><p style="font-size:13px;color:#555">If you did not ask for this, ignore this email and nothing happens. Never forward this link: anyone who opens it gets into your Pro access.</p><p style="font-size:12px;color:#777">Zroppix is independent and not affiliated with Amazon or any store.</p></div>',
  };
}

module.exports = { sendEmail, confirmEmail, waitlistEmail, proLoginEmail };
