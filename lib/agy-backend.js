'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGY_GEMINI_ENDPOINT = process.env.CODEX_GATEWAY_AGY_ENDPOINT
  || 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_AGY_MODELS = [
  { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', context: 1000000, reasoning: true },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', context: 1000000, reasoning: true },
  { id: 'gpt-oss-120b', displayName: 'GPT-OSS 120B', context: 128000, reasoning: false },
];

function agyDirectory(home = os.homedir()) {
  return process.env.CODEX_GATEWAY_AGY_HOME || path.join(home, '.gemini', 'antigravity-cli');
}

function agyModelCachePath(home) {
  return path.join(agyDirectory(home), 'cache', 'models_cache.json');
}

function checkAgyCli(binPath = process.env.CODEX_GATEWAY_AGY_BIN || 'agy') {
  try {
    const result = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      return { present: true, version: result.stdout.trim() };
    }
  } catch {}
  return { present: false, version: null };
}

function readAgyAuth() {
  if (process.env.GEMINI_API_KEY) {
    return { type: 'api_key', key: process.env.GEMINI_API_KEY };
  }
  const cliCheck = checkAgyCli();
  if (cliCheck.present) {
    return { type: 'agy_cli', version: cliCheck.version };
  }
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  if (fs.existsSync(adcPath)) {
    return { type: 'adc', path: adcPath };
  }
  throw new Error('Antigravity CLI or GEMINI_API_KEY is missing. Install `agy` or export GEMINI_API_KEY.');
}

function normalizeModelSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9.-]/g, '');
}

function agyPickerId(model) {
  return String(model || '').replace(/^agy-/, '').replace(/^gemini-/, 'gemini-');
}

function agyModelFromPicker(id, models = DEFAULT_AGY_MODELS.map((m) => m.id)) {
  const cleanId = String(id || '').replace(/\[1m\]$/, '').replace(/^claude-agy-/, '').replace(/^claude-/, '');
  const match = models.find((m) => m === cleanId || normalizeModelSlug(m) === cleanId);
  return match || cleanId;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function translateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const functionDeclarations = [];
  for (const tool of tools) {
    if (!tool?.name) continue;
    functionDeclarations.push({
      name: tool.name,
      description: tool.description || undefined,
      parameters: tool.input_schema || { type: 'object', properties: {} },
    });
  }
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function translateInput(payload) {
  const contents = [];
  let systemInstruction = undefined;

  const system = payload?.system;
  const systemText = typeof system === 'string'
    ? system
    : Array.isArray(system)
      ? system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      : '';

  if (systemText) {
    systemInstruction = { parts: [{ text: systemText }] };
  }

  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === 'string') {
        parts.push({ text: block });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input || {},
          },
        });
      } else if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: block.tool_use_id || 'tool',
            response: {
              content: textFromContent(block.content),
            },
          },
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents, systemInstruction };
}

function translateRequest(payload, model) {
  const { contents, systemInstruction } = translateInput(payload);
  const request = {
    contents,
    generationConfig: {},
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }

  if (Number.isFinite(payload?.max_tokens) && payload.max_tokens > 0) {
    request.generationConfig.maxOutputTokens = payload.max_tokens;
  }

  if (Number.isFinite(payload?.temperature)) {
    request.generationConfig.temperature = payload.temperature;
  }

  if (Number.isFinite(payload?.top_p)) {
    request.generationConfig.topP = payload.top_p;
  }

  const effort = payload?.output_config?.effort;
  if (typeof effort === 'string') {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: effort === 'high' ? 8192 : effort === 'medium' ? 4096 : 1024,
    };
  }

  const tools = translateTools(payload?.tools);
  if (tools) {
    request.tools = tools;
  }

  return request;
}

function anthropicUsage(usageMetadata) {
  const promptTokens = Number(usageMetadata?.promptTokenCount) || 0;
  const candidateTokens = Number(usageMetadata?.candidatesTokenCount) || 0;
  const thoughtsTokens = Number(usageMetadata?.thinkingTokens ?? usageMetadata?.thoughtTokens) || 0;
  return {
    input_tokens: promptTokens,
    output_tokens: candidateTokens,
    output_tokens_details: { reasoning_tokens: thoughtsTokens },
  };
}

function translateResponse(response, model) {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = [];

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text) {
      content.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  const hasToolUse = content.some((block) => block.type === 'tool_use');
  const finishReason = candidate?.finishReason;
  const stopReason = hasToolUse ? 'tool_use' : finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

  return {
    id: response?.id || `msg_agy_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage(response?.usageMetadata),
  };
}

function sseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function createAgySseTransformer(write, model) {
  let started = false;
  let stopped = false;
  let blockIndex = 0;
  let activeBlock = null;

  function start(id = `msg_agy_${Date.now()}`) {
    if (started) return;
    started = true;
    write(sseFrame({
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  function stopBlock() {
    if (!activeBlock || activeBlock.stopped) return;
    activeBlock.stopped = true;
    write(sseFrame({ type: 'content_block_stop', index: activeBlock.index }));
    activeBlock = null;
  }

  function startTextBlock() {
    if (activeBlock && activeBlock.type === 'text') return activeBlock;
    stopBlock();
    const block = { index: blockIndex++, type: 'text', stopped: false };
    activeBlock = block;
    write(sseFrame({ type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } }));
    return block;
  }

  function stop(usage = {}, reason = 'end_turn') {
    if (stopped) return;
    stopBlock();
    stopped = true;
    write(sseFrame({
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: anthropicUsage(usage),
    }));
    write(sseFrame({ type: 'message_stop' }));
  }

  return {
    chunk(chunk) {
      start();
      const candidate = chunk?.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          const textBlock = startTextBlock();
          write(sseFrame({
            type: 'content_block_delta',
            index: textBlock.index,
            delta: { type: 'text_delta', text: part.text },
          }));
        }

        if (part.functionCall) {
          stopBlock();
          const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const funcBlock = { index: blockIndex++, type: 'tool_use', stopped: false };
          activeBlock = funcBlock;
          write(sseFrame({
            type: 'content_block_start',
            index: funcBlock.index,
            content_block: {
              type: 'tool_use',
              id: callId,
              name: part.functionCall.name,
              input: {},
            },
          }));
          write(sseFrame({
            type: 'content_block_delta',
            index: funcBlock.index,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(part.functionCall.args || {}),
            },
          }));
          stopBlock();
        }
      }

      if (candidate?.finishReason) {
        const finish = candidate.finishReason;
        const reason = finish === 'STOP' ? 'end_turn'
          : finish === 'MAX_TOKENS' ? 'max_tokens'
          : 'end_turn';
        stop(chunk?.usageMetadata, reason);
      }
    },
    end(usage) {
      if (!stopped) stop(usage, 'end_turn');
    },
    error(err) {
      const message = err instanceof Error ? err.message : String(err || 'Unknown error');
      write(sseFrame({
        type: 'error',
        error: { type: 'api_error', message: `model-gateway: AGY Gemini upstream error: ${message}` },
      }));
    },
  };
}

function buildAgyPrompt(payload) {
  const lines = [];
  const system = payload?.system;
  const systemText = typeof system === 'string'
    ? system
    : Array.isArray(system)
      ? system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      : '';

  if (systemText) {
    lines.push(`[System Instructions]\n${systemText}\n`);
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const roleLabel = msg.role === 'assistant' ? 'Assistant' : 'User';
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (!b) continue;
        if (typeof b === 'string') parts.push(b);
        else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        else if (b.type === 'tool_use') parts.push(`[Tool Call: ${b.name}(${JSON.stringify(b.input || {})})]`);
        else if (b.type === 'tool_result') parts.push(`[Tool Result for ${b.tool_use_id || 'call'}: ${textFromContent(b.content)}]`);
      }
      text = parts.join('\n');
    }
    if (i === messages.length - 1 && msg.role === 'user' && lines.length === 0) {
      lines.push(text);
    } else {
      lines.push(`${roleLabel}: ${text}`);
    }
  }

  return lines.join('\n\n');
}

function createAgyCliStreamTransformer(write, model) {
  let started = false;
  let stopped = false;
  let blockIndex = 0;
  let activeBlock = null;

  function start(id = `msg_agy_${Date.now()}`) {
    if (started) return;
    started = true;
    write(sseFrame({
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  function stopBlock() {
    if (!activeBlock || activeBlock.stopped) return;
    activeBlock.stopped = true;
    write(sseFrame({ type: 'content_block_stop', index: activeBlock.index }));
    activeBlock = null;
  }

  function startTextBlock() {
    if (activeBlock && activeBlock.type === 'text') return activeBlock;
    stopBlock();
    const block = { index: blockIndex++, type: 'text', stopped: false };
    activeBlock = block;
    write(sseFrame({ type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } }));
    return block;
  }

  function stop(usage = {}, reason = 'end_turn') {
    if (stopped) return;
    stopBlock();
    stopped = true;
    write(sseFrame({
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: {
        input_tokens: Number(usage?.input_tokens) || 0,
        output_tokens: Number(usage?.output_tokens) || 0,
        output_tokens_details: { reasoning_tokens: Number(usage?.thinking_tokens) || 0 },
      },
    }));
    write(sseFrame({ type: 'message_stop' }));
  }

  return {
    event(ev) {
      start();
      if (ev.event === 'step_update') {
        const update = ev.step_update;
        if (update?.step_type === 'agent_response') {
          if (typeof update.text_delta === 'string' && update.text_delta) {
            const textBlock = startTextBlock();
            write(sseFrame({
              type: 'content_block_delta',
              index: textBlock.index,
              delta: { type: 'text_delta', text: update.text_delta },
            }));
          }
          if (update.state === 'DONE') {
            stop(update.usage, 'end_turn');
          }
        }
      } else if (ev.event === 'result') {
        const res = ev.result;
        if (!stopped) {
          stop(res?.usage, res?.status === 'SUCCESS' ? 'end_turn' : 'end_turn');
        }
      }
    },
    end(usage) {
      if (!stopped) stop(usage, 'end_turn');
    },
    error(err) {
      const message = err instanceof Error ? err.message : String(err || 'Unknown error');
      write(sseFrame({
        type: 'error',
        error: { type: 'api_error', message: `model-gateway: AGY CLI upstream error: ${message}` },
      }));
    },
  };
}

function agyModelsFromCache({ file = agyModelCachePath() } = {}) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_AGY_MODELS;
}

module.exports = {
  AGY_GEMINI_ENDPOINT,
  DEFAULT_AGY_MODELS,
  agyDirectory,
  agyModelCachePath,
  agyModelFromPicker,
  agyModelsFromCache,
  agyPickerId,
  buildAgyPrompt,
  checkAgyCli,
  createAgyCliStreamTransformer,
  createAgySseTransformer,
  normalizeModelSlug,
  readAgyAuth,
  translateInput,
  translateRequest,
  translateResponse,
  translateTools,
};
