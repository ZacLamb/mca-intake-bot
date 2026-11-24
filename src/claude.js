const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

let client;
const c = () => (client ||= new Anthropic({ apiKey: cfg.anthropicKey }));

// Forces a structured answer through a single tool
async function callTool({ system, user, tool, maxTokens = 1500 }) {
  const res = await c().messages.create({
    model: cfg.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no structured output');
  return block.input;
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
