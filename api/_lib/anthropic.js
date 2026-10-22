'use strict';
const { cfg, prices, SEARCH_USD } = require('./config');

class AIError extends Error {
  constructor(msg, status) { super(msg); this.status = status || 0; }
}

function costOf(model, usage) {
  const p = prices()[model] || { in: 4, out: 20 }; // unknown model: assume the dearest tier
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  const long = p.longAt && inTok > p.longAt;
  const pin = long ? p.inLong : p.in;
  const pout = long ? p.outLong : p.out;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return (inTok * pin + outTok * pout) / 1e6 + searches * SEARCH_USD;
}

function addUsage(a, b) {
  const o = Object.assign({}, a);
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) o[k] = (o[k] || 0) + (b[k] || 0);
  const s = ((a.server_tool_use || {}).web_search_requests || 0) + ((b.server_tool_use || {}).web_search_requests || 0);
  o.server_tool_use = { web_search_requests: s };
  return o;
}

// One logical call. Handles pause_turn (server tool still running) by sending the assistant turn back unchanged.
async function call({ model, system, messages, tools, maxTokens, deadline }) {
  const c = cfg();
  if (!c.anthropicKey) throw new AIError('ai_not_configured');
  let msgs = messages.slice();
  let usage = {};
  let content = [];
  let stop = '';
  for (let round = 0; round < 4; round++) {
    const left = (deadline || Date.now() + 50000) - Date.now();
    if (left < 3000) throw new AIError('timeout');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    let r;
    try {
      const body = { model, max_tokens: maxTokens || 1500, system, messages: msgs };
      if (tools) body.tools = tools;
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': c.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new AIError(e && e.name === 'AbortError' ? 'timeout' : 'network');
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new AIError('http_' + r.status, r.status);
    const j = await r.json();
    usage = addUsage(usage, j.usage || {});
    content = content.concat(j.content || []);
    stop = j.stop_reason || '';
    if (stop === 'pause_turn') {
      msgs = msgs.concat([{ role: 'assistant', content: j.content }]);
      continue;
    }
    break;
  }
  // Text arrives in many small blocks when the search tool adds citations. They are pieces of one reply, so join with nothing.
  const text = content.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const blockTypes = {};
  for (const b of content) blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
  // URLs the search tool actually returned. Anything the model claims that is not in here is rejected later.
  const results = [];
  let searchErrors = 0;
  for (const b of content) {
    if (b.type !== 'web_search_tool_result') continue;
    if (Array.isArray(b.content)) {
      for (const x of b.content) if (x && x.type === 'web_search_result' && x.url) results.push({ url: String(x.url), title: String(x.title || ''), page_age: x.page_age ? String(x.page_age) : null });
    } else if (b.content && b.content.type === 'web_search_tool_result_error') searchErrors++;
  }
  return { text, usage, costUsd: costOf(model, usage), results, searchErrors, stop, blockTypes };
}

// Pull the JSON object out of a model reply. Tolerates stray line breaks and a reply cut off at the token limit.
function extractJson(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  if (s < 0) return null;
  const e = text.lastIndexOf('}');
  if (e > s) {
    const c = text.slice(s, e + 1);
    try { return JSON.parse(c); } catch (_) { /* try again below */ }
    try { return JSON.parse(c.replace(/[\r\n\t]+/g, ' ')); } catch (_) { /* fall through */ }
  }
  return salvage(text.slice(s));
}

// Truncated reply: keep every COMPLETE object in the first array and close the JSON.
function salvage(raw) {
  const t = raw.replace(/[\r\n\t]+/g, ' ');
  const i = t.indexOf('[');
  if (i < 0) return null;
  let depth = 0; let inStr = false; let esc = false; let lastEnd = -1;
  for (let k = i + 1; k < t.length; k++) {
    const ch = t[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) lastEnd = k; }
  }
  if (lastEnd < 0) return null;
  try { return JSON.parse(t.slice(0, i + 1) + t.slice(i + 1, lastEnd + 1) + ']}'); } catch (_) { return null; }
}

module.exports = { call, costOf, extractJson, AIError };
