'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const agy = require('../lib/agy-backend.js');

test('translates Anthropic messages, tools, and effort to Gemini generateContent request', () => {
  const request = agy.translateRequest({
    system: [{ type: 'text', text: 'You are an AGY assistant.' }],
    messages: [
      { role: 'user', content: 'calculate sum' },
      { role: 'assistant', content: [{ type: 'text', text: 'Calling tool.' }, { type: 'tool_use', id: 'call_1', name: 'add', input: { a: 2, b: 3 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '5' }, { type: 'text', text: 'Now multiply by 2.' }] },
    ],
    tools: [{ name: 'add', description: 'Add two numbers', input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }],
    output_config: { effort: 'high' },
    max_tokens: 1024,
    temperature: 0.7,
  }, 'gemini-3.6-flash');

  assert.equal(request.generationConfig.maxOutputTokens, 1024);
  assert.equal(request.generationConfig.temperature, 0.7);
  assert.equal(request.generationConfig.thinkingConfig.thinkingBudget, 8192);
  assert.deepEqual(request.systemInstruction, { parts: [{ text: 'You are an AGY assistant.' }] });

  // User turn 1
  assert.equal(request.contents[0].role, 'user');
  assert.deepEqual(request.contents[0].parts, [{ text: 'calculate sum' }]);

  // Model turn 1
  assert.equal(request.contents[1].role, 'model');
  assert.equal(request.contents[1].parts[0].text, 'Calling tool.');
  assert.deepEqual(request.contents[1].parts[1].functionCall, { name: 'add', args: { a: 2, b: 3 } });

  // User turn 2 (tool result + text)
  assert.equal(request.contents[2].role, 'user');
  assert.deepEqual(request.contents[2].parts[0].functionResponse, { name: 'call_1', response: { content: '5' } });
  assert.deepEqual(request.contents[2].parts[1].text, 'Now multiply by 2.');

  // Tools
  assert.equal(request.tools[0].functionDeclarations[0].name, 'add');
  assert.equal(request.tools[0].functionDeclarations[0].description, 'Add two numbers');
});

test('translates Gemini non-streaming response to Anthropic message format', () => {
  const geminiResponse = {
    id: 'resp_123',
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { text: 'Calculation complete.' },
          { functionCall: { name: 'finish', args: { answer: 10 } } },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 50,
      candidatesTokenCount: 20,
      thinkingTokens: 15,
    },
  };

  const anthropic = agy.translateResponse(geminiResponse, 'gemini-3.6-flash');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.model, 'gemini-3.6-flash');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[0].text, 'Calculation complete.');
  assert.equal(anthropic.content[1].type, 'tool_use');
  assert.equal(anthropic.content[1].name, 'finish');
  assert.deepEqual(anthropic.content[1].input, { answer: 10 });
  assert.equal(anthropic.usage.input_tokens, 50);
  assert.equal(anthropic.usage.output_tokens, 20);
  assert.equal(anthropic.usage.output_tokens_details.reasoning_tokens, 15);
});

test('streams Gemini chunks as Anthropic SSE frames', () => {
  const frames = [];
  const transformer = agy.createAgySseTransformer((frame) => frames.push(frame), 'gemini-3.6-flash');

  // First chunk: text delta
  transformer.chunk({
    candidates: [{
      content: { parts: [{ text: 'Hello ' }] },
    }],
  });

  // Second chunk: text delta + function call + finish
  transformer.chunk({
    candidates: [{
      content: {
        parts: [
          { text: 'world!' },
          { functionCall: { name: 'greet', args: { target: 'user' } } },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 15,
    },
  });

  const parsed = frames.map((f) => {
    const lines = f.trim().split('\n');
    return { event: lines[0].replace('event: ', ''), data: JSON.parse(lines[1].replace('data: ', '')) };
  });

  assert.equal(parsed[0].event, 'message_start');
  assert.equal(parsed[0].data.message.model, 'gemini-3.6-flash');
  assert.equal(parsed[1].event, 'content_block_start');
  assert.equal(parsed[2].event, 'content_block_delta');
  assert.equal(parsed[2].data.delta.text, 'Hello ');
  assert.equal(parsed[3].event, 'content_block_delta');
  assert.equal(parsed[3].data.delta.text, 'world!');
  assert.equal(parsed[4].event, 'content_block_stop');
  assert.equal(parsed[5].event, 'content_block_start');
  assert.equal(parsed[5].data.content_block.type, 'tool_use');
  assert.equal(parsed[5].data.content_block.name, 'greet');
  assert.equal(parsed[6].event, 'content_block_delta');
  assert.deepEqual(JSON.parse(parsed[6].data.delta.partial_json), { target: 'user' });
  assert.equal(parsed[7].event, 'content_block_stop');
  assert.equal(parsed[8].event, 'message_delta');
  assert.equal(parsed[8].data.delta.stop_reason, 'end_turn');
  assert.equal(parsed[8].data.usage.output_tokens, 15);
  assert.equal(parsed[9].event, 'message_stop');
});

test('normalizes model slugs and maps picker aliases', () => {
  assert.equal(agy.normalizeModelSlug('Gemini 3.6 Flash (High)'), 'gemini-3.6-flash-high');
  assert.equal(agy.normalizeModelSlug('Gemini 3.1 Pro (Low)'), 'gemini-3.1-pro-low');
  assert.equal(agy.agyModelFromPicker('claude-agy-gemini-3.6-flash[1m]'), 'gemini-3.6-flash');
  assert.equal(agy.agyModelFromPicker('claude-agy-claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6');
  assert.equal(agy.agyModelFromPicker('gemini-3.1-pro'), 'gemini-3.1-pro');
  assert.equal(agy.agyPickerId('gemini-3.6-flash'), 'gemini-3.6-flash');
  assert.equal(agy.agyPickerModelId('claude-sonnet-4-6'), 'claude-agy-claude-sonnet-4-6');
  assert.equal(agy.agyPickerModelId('gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
});

test('normalizes mixed-case AGY picker ids and rejects malformed suffixes', () => {
  assert.equal(agy.agyPickerModelId('Claude-Sonnet-4-6'), 'claude-agy-Claude-Sonnet-4-6');
  assert.equal(agy.agyModelFromPicker('CLAUDE-AGY-Claude-Sonnet-4-6[1m]', ['claude-sonnet-4-6']), 'claude-sonnet-4-6');
  assert.equal(agy.agyModelFromPicker('claude-agy-[1m]', ['gemini-3.6-flash']), null);
  assert.equal(agy.agyModelFromPicker('claude-agy-gemini-3.6-flash[1m][1m]', ['gemini-3.6-flash']), null);
});


test('parses the AGY CLI model listing, including its Claude quota rows', () => {
  const output = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    'not-a-model\tIgnored',
  ].join('\n');

  assert.deepEqual(agy.parseAgyModelsOutput(output), [
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
  ]);
});

test('discovers AGY models from the CLI and falls back on command failure', async () => {
  const calls = [];
  const spawnImpl = (binPath, args, options) => {
    calls.push({ binPath, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stderr.end('Fetching available models...\n');
      child.stdout.end('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n');
      child.emit('close', 0);
    });
    return child;
  };

  const discovered = await agy.discoverAgyModels({ binPath: '/fake/agy', spawnImpl });
  assert.deepEqual(discovered, [{ id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' }]);
  assert.deepEqual(calls, [{
    binPath: '/fake/agy',
    args: ['models'],
    options: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  }]);

  const fallback = [{ id: 'gemini-fallback', displayName: 'Fallback' }];
  const failed = await agy.discoverAgyModels({
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    },
    fallback,
  });
  assert.deepEqual(failed, fallback);
});

test('supports JSON model output and terminates a timed-out AGY CLI', async () => {
  const jsonSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ models: [
        { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
      ] }));
      child.stderr.end('Fetching available models...\n');
      child.emit('close', 0);
    });
    return child;
  };

  assert.deepEqual(await agy.discoverAgyModels({ spawnImpl: jsonSpawn }), [
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
  ]);

  let signal;
  const timeoutSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (value) => { signal = value; };
    return child;
  };
  const fallback = [{ id: 'gemini-fallback', displayName: 'Fallback' }];
  assert.deepEqual(await agy.discoverAgyModels({ spawnImpl: timeoutSpawn, timeout: 5, fallback }), fallback);
  assert.equal(signal, 'SIGTERM');
});


test('checks agy CLI availability without relying on a developer-installed CLI', () => {
  const cli = agy.checkAgyCli('/deterministic/fake-agy', {
    spawnSyncImpl: () => ({ status: 0, stdout: 'agy 1.0.0\n' }),
  });
  assert.deepEqual(cli, { present: true, version: 'agy 1.0.0', path: '/deterministic/fake-agy' });
});

test('checks AGY CLI authentication with a non-interactive models probe', () => {
  const calls = [];
  const auth = agy.checkAgyAuth('/deterministic/fake-agy', {
    env: { PATH: '/deterministic', HOME: '/tmp' },
    fsImpl: { existsSync: () => false },
    spawnSyncImpl: (bin, args, options) => {
      calls.push({ bin, args, env: options.env });
      return args[0] === '--version'
        ? { status: 0, stdout: 'agy 1.0.0\n' }
        : { status: 0, stdout: '[{ "id": "gemini-test" }]\n' };
    },
  });
  assert.deepEqual(auth, { present: true, type: 'agy_cli', version: 'agy 1.0.0' });
  assert.deepEqual(calls.map(({ args }) => args), [['--version'], ['models']]);
  assert.deepEqual(calls[0].env, calls[1].env);
  assert.deepEqual(calls[0].env, { PATH: '/deterministic', HOME: '/tmp' });
});

test('reports AGY CLI authentication as unavailable when the models probe fails', () => {
  const auth = agy.checkAgyAuth('/deterministic/fake-agy', {
    env: { PATH: '/deterministic', HOME: '/tmp' },
    fsImpl: { existsSync: () => false },
    spawnSyncImpl: (bin, args) => args[0] === '--version'
      ? { status: 0, stdout: 'agy 1.0.0\\n' }
      : { status: 1, stdout: '', stderr: 'not authenticated\\n' },
  });
  assert.deepEqual(auth, { present: false, type: null });
});

test('resolves AGY model policies and attaches 1M picker aliases', () => {
  const { resolveGatewayModelPolicy, gatewayClientModelId, gatewayAdvertisedWindow } = require('../lib/runtime.js');

  const flash = resolveGatewayModelPolicy('claude-agy-gemini-3.6-flash[1m]');
  assert.equal(flash.backend, 'agy');
  assert.equal(flash.backendId, 'gemini-3.6-flash');
  assert.equal(flash.advertisedWindow, 1000000);
  assert.equal(flash.pickerAlias, 'claude-agy-gemini-3.6-flash[1m]');

  const pro = resolveGatewayModelPolicy('gemini-3.1-pro');
  assert.equal(pro.backend, 'agy');
  assert.equal(pro.backendId, 'gemini-3.1-pro');
  assert.equal(pro.advertisedWindow, 1000000);
  assert.equal(gatewayClientModelId('claude-agy-gemini-3.1-pro'), 'claude-agy-gemini-3.1-pro[1m]');

  // Unknown future AGY model uses agy-default wildcard
  const future = resolveGatewayModelPolicy('claude-agy-gemini-future-4.0[1m]');
  assert.equal(future.backend, 'agy');
  assert.equal(future.advertisedWindow, 1000000);
  assert.equal(future.pickerAlias, 'claude-agy-gemini-future-4.0[1m]');

  const gptOssVariant = resolveGatewayModelPolicy('claude-agy-gpt-oss-120b-medium[1m]');
  assert.equal(gptOssVariant.backend, 'agy');
  assert.equal(gptOssVariant.advertisedWindow, 1000000);
  assert.equal(gptOssVariant.pickerAlias, 'claude-agy-gpt-oss-120b-medium[1m]');

  const agyClaude = resolveGatewayModelPolicy('claude-agy-claude-sonnet-4-6[1m]');
  assert.equal(agyClaude.backend, 'agy');
  assert.equal(agyClaude.backendId, 'claude-sonnet-4-6');
  assert.equal(agyClaude.advertisedWindow, 1000000);
  assert.equal(agyClaude.pickerAlias, 'claude-agy-claude-sonnet-4-6[1m]');
});

test('translates chat conversation to agy prompt and streams agy CLI events', () => {
  const prompt = agy.buildAgyPrompt({
    system: 'You are an expert coder.',
    tools: [
      { name: 'calculator', description: 'Evaluate math', input_schema: { type: 'object', properties: { expr: { type: 'string' } } } },
    ],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: [{ type: 'text', text: 'what is 2+2?' }] },
    ],
  });

  assert.match(prompt, /\[System Instructions\]\nYou are an expert coder\./);
  assert.match(prompt, /\[Available Tools \(JSON Schema\)\]/);
  assert.match(prompt, /Tool: calculator/);
  assert.match(prompt, /User: hello/);
  assert.match(prompt, /Assistant: hi there/);
  assert.match(prompt, /User: what is 2\+2\?/);

  const frames = [];
  const transformer = agy.createAgyCliStreamTransformer((f) => frames.push(f), 'claude-agy-gemini-3.6-flash[1m]');

  transformer.event({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: '4',
      state: 'ACTIVE',
    },
  });

  transformer.event({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: '\n',
      state: 'DONE',
    },
  });

  transformer.event({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: '4\n',
      usage: { input_tokens: 15, output_tokens: 3, thinking_tokens: 0 },
    },
  });

  assert.equal(frames.length, 7);
  assert.match(frames[0], /"type":"message_start"/);
  assert.match(frames[1], /"type":"content_block_start"/);
  assert.match(frames[2], /"text_delta","text":"4"/);
  assert.match(frames[3], /"text_delta","text":"\\n"/);
  assert.match(frames[4], /"type":"content_block_stop"/);
  assert.match(frames[5], /"type":"message_delta"/);
  assert.match(frames[5], /"input_tokens":15/);
  assert.match(frames[5], /"output_tokens":3/);
  assert.match(frames[6], /"type":"message_stop"/);
});

test('does not append a successful terminal to an unsuccessful AGY result', () => {
  const frames = [];
  const transformer = agy.createAgyCliStreamTransformer((f) => frames.push(f), 'gemini-3.6-flash');

  transformer.event({
    event: 'result',
    result: { status: 'ERROR', usage: { input_tokens: 2, output_tokens: 1 } },
  });
  transformer.end({ input_tokens: 2, output_tokens: 1 });

  assert.equal(frames.filter((frame) => frame.includes('"type":"error"')).length, 1);
  assert.equal(frames.filter((frame) => frame.includes('"type":"message_stop"')).length, 0);
});

test('makes CLI stream errors terminal and idempotent', () => {
  const frames = [];
  const transformer = agy.createAgyCliStreamTransformer((f) => frames.push(f), 'gemini-3.6-flash');
  transformer.error(new Error('first'));
  transformer.error(new Error('second'));
  transformer.event({ event: 'result', result: { status: 'SUCCESS' } });
  assert.equal(frames.filter((frame) => frame.includes('"type":"error"')).length, 1);
  assert.equal(frames.filter((frame) => frame.includes('second')).length, 0);
  assert.equal(frames.filter((frame) => frame.includes('"type":"message_start"')).length, 0);
});

test('bounds AGY discovery output and terminates the child', async () => {
  let signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = (signal) => signals.push(signal);
  const result = await agy.discoverAgyModels({
    spawnImpl: () => { queueMicrotask(() => child.stdout.emit('data', 'x'.repeat(2048))); return child; },
    outputLimit: 1024,
    fallback: [{ id: 'gemini-fallback' }],
  });
  assert.deepEqual(result, [{ id: 'gemini-fallback' }]);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('resolves only safe regular executable files and filters child environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-'));
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  fs.chmodSync(bin, 0o755);
  assert.equal(agy.resolveAgyCliPath(bin), fs.realpathSync(bin));
  const env = agy.agyChildEnv({ PATH: '/bin', GEMINI_API_KEY: 'secret', HOME: '/tmp', SECRET: 'no' });
  assert.deepEqual(env, { PATH: '/bin', GEMINI_API_KEY: 'secret', HOME: '/tmp' });
});

