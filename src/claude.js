const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

let client;
const c = () => (client ||= new Anthropic({ apiKey: cfg.anthropicKey }));

// Some models refuse a forced tool_choice ("tool"/"any"). Remember that and use "auto" + instructions.
let forcedSupported = true;
const FORCE_ERR = /tool_choice.*not supported/i;

function pickToolInput(res, name) {
  const block = res.content.find((b) => b.type === 'tool_use' && b.name === name);
  if (block) return block.input;
  // Fallback: the model answered in text — accept a JSON object if it wrote one
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

// Gets a structured answer through a single tool
async function callTool({ system, user, tool, maxTokens = 1500 }) {
  const base = { model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: user }], tools: [tool] };

  if (forcedSupported) {
    try {
      const res = await c().messages.create({ ...base, system, tool_choice: { type: 'tool', name: tool.name } });
      const out = pickToolInput(res, tool.name);
      if (out) return out;
    } catch (e) {
      if (!FORCE_ERR.test(e.message)) throw e;
      forcedSupported = false;
    }
  }

  const sys = `${system}\n\nRESPONSE FORMAT: Always answer by calling the \`${tool.name}\` tool exactly once. Do not reply with plain text.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await c().messages.create({ ...base, system: sys, tool_choice: { type: 'auto' } });
    const out = pickToolInput(res, tool.name);
    if (out) return out;
  }
  throw new Error('Claude did not return a structured reply');
}

async function callText({ system, user, maxTokens = 4000 }) {
  const res = await c().messages.create({
    model: cfg.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

module.exports = { callTool, callText };
