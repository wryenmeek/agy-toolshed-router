'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

function writeAgyFixture(home) {
  const bin = path.join(home, 'fake-agy.js');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('agy 1.0.0\\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('claude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)\\n');
  process.exit(0);
}
if (process.env.AGY_ARGS_FILE) fs.writeFileSync(process.env.AGY_ARGS_FILE, JSON.stringify(args));
let input = '';
let handled = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (handled) return;
  input += chunk;
  if (!input.includes('\\n')) return;
  handled = true;
  if (input.includes('fail this request')) {
    process.stderr.write('fixture upstream failure\\n');
    process.exit(7);
  }
  process.stdout.write(JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', response: 'fixture response', usage: { input_tokens: 3, output_tokens: 2 },
  } }) + '\\n');
  process.exit(0);
});
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body ? 'POST' : 'GET',
      path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function startAgyGateway(t) {
  const environment = gatewayTestEnvironment(t, {
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_SENTRY: '0',
  });
  const argsFile = path.join(environment.HOME, 'agy-args.json');
  const agyBin = writeAgyFixture(environment.HOME);
  environment.CODEX_GATEWAY_AGY_BIN = agyBin;
  environment.AGY_ARGS_FILE = argsFile;
  const gateway = await startGateway(t, 'serve-shim', environment);
  return { ...gateway, argsFile };
}

test('lists dynamically discovered AGY models in /v1/models', async (t) => {
  const gateway = await startAgyGateway(t);
  const response = await waitUntil(async () => {
    const result = await request(gateway.port, '/v1/models');
    const models = JSON.parse(result.body).data;
    return models.some((model) => model.id === 'claude-agy-claude-sonnet-4-6[1m]') ? result : null;
  }, 'dynamic AGY model did not appear in /v1/models');

  const model = JSON.parse(response.body).data.find((entry) => entry.id === 'claude-agy-claude-sonnet-4-6[1m]');
  assert.equal(model.display_name, 'Claude Sonnet 4.6 (Thinking)');
});

test('routes a discovered Claude AGY picker alias with the original CLI model argv', async (t) => {
  const gateway = await startAgyGateway(t);
  await waitUntil(async () => {
    const result = await request(gateway.port, '/v1/models');
    return JSON.parse(result.body).data.some((model) => model.id === 'claude-agy-claude-sonnet-4-6[1m]');
  }, 'dynamic AGY model did not appear in /v1/models');

  const response = await request(gateway.port, '/v1/messages', JSON.stringify({
    model: 'claude-agy-claude-sonnet-4-6[1m]',
    stream: false,
    messages: [{ role: 'user', content: 'route this request' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content[0].text, 'fixture response');
  const args = JSON.parse(fs.readFileSync(gateway.argsFile, 'utf8'));
  const modelIndex = args.indexOf('--model');
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], 'claude-sonnet-4-6');
});

test('returns an error when the AGY CLI exits nonzero instead of empty success', async (t) => {
  const gateway = await startAgyGateway(t);
  await waitUntil(async () => {
    const result = await request(gateway.port, '/v1/models');
    return JSON.parse(result.body).data.some((model) => model.id === 'claude-agy-claude-sonnet-4-6[1m]');
  }, 'dynamic AGY model did not appear in /v1/models');

  const response = await request(gateway.port, '/v1/messages', JSON.stringify({
    model: 'claude-agy-claude-sonnet-4-6[1m]',
    stream: false,
    messages: [{ role: 'user', content: 'fail this request' }],
  }));
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'model-gateway: AGY CLI exited with code 7: fixture upstream failure',
    },
  });
});
