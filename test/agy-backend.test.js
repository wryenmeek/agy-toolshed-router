'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  assert.equal(agy.agyModelFromPicker('gemini-3.1-pro'), 'gemini-3.1-pro');
  assert.equal(agy.agyPickerId('gemini-3.6-flash'), 'gemini-3.6-flash');
});

test('checks agy CLI availability or API key auth', () => {
  const cli = agy.checkAgyCli();
  assert.equal(typeof cli.present, 'boolean');
  if (cli.present) {
    assert.match(cli.version, /\d+\.\d+\.\d+/);
  }
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

