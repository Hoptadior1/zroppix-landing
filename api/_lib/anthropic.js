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
  const text = content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  // URLs the search tool actually returned. Anything the model claims that is not in here is rejected later.
  const results = [];
  let searchErrors = 0;
  for (const b of content) {
    if (b.type !== 'web_search_tool_result') continue;
    if (Array.isArray(b.content)) {
      for (const x of b.content) if (x && x.type === 'web_search_result' && x.url) results.push({ url: String(x.url), title: String(x.title || ''), page_age: x.page_age ? String(x.page_age) : null });
    } else if (b.content && b.content.type === 'web_search_tool_result_error') searchErrors++;
  }
  return { text, usage, costUsd: costOf(model, usage), results, searchErrors, stop };
}

// Pull the first JSON object out of a model reply. Returns null if there is none.
function extractJson(text) {
  if (!text) return null;
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
}

module.exports = { call, costOf, extractJson, AIError };
