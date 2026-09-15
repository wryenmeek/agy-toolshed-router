'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditPreflightChecks, promptScopeSelection } = require('../lib/commands.js');
const { selectedWiringScope } = require('../lib/settings-wiring.js');

test('model-gateway setup onboarding wizard - selectedWiringScope supports explicit override and MODEL_GATEWAY_SCOPE env', () => {
  assert.equal(selectedWiringScope('user'), 'user');
  assert.equal(selectedWiringScope('project'), 'project');
  assert.equal(selectedWiringScope(), 'project');

  const origEnv = process.env.MODEL_GATEWAY_SCOPE;
  try {
    process.env.MODEL_GATEWAY_SCOPE = 'user';
    assert.equal(selectedWiringScope(), 'user');
    process.env.MODEL_GATEWAY_SCOPE = 'project';
    assert.equal(selectedWiringScope(), 'project');
  } finally {
    if (origEnv !== undefined) {
      process.env.MODEL_GATEWAY_SCOPE = origEnv;
    } else {
      delete process.env.MODEL_GATEWAY_SCOPE;
    }
  }
});

test('model-gateway setup onboarding wizard - auditPreflightChecks audits runtime, backends, and ports cleanly', async () => {
  const checks = await auditPreflightChecks();
  assert.equal(Array.isArray(checks), true);
  assert.equal(checks.length >= 4, true);

  const names = checks.map((c) => c.name);
  assert.equal(names.some((n) => n.includes('Node.js')), true);
  assert.equal(names.some((n) => n.includes('Antigravity') || n.includes('AGY')), true);
  assert.equal(names.some((n) => n.includes('Codex') || n.includes('ChatGPT')), true);

  for (const c of checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(['ok', 'warn', 'info', 'pending'].includes(c.status), true);
    assert.equal(typeof c.detail, 'string');
  }
});

test('model-gateway setup onboarding wizard - promptScopeSelection resolves default scope when non-interactive', async () => {
  const scope = await promptScopeSelection({ defaultScope: 'project', interactive: false });
  assert.equal(scope, 'project');

  const userScope = await promptScopeSelection({ defaultScope: 'user', interactive: false });
  assert.equal(userScope, 'user');
});

test('model-gateway setup onboarding wizard - promptScopeSelection respects cliArgs overrides', async () => {
  const userByArg = await promptScopeSelection({ cliArgs: ['--scope', 'user'] });
  assert.equal(userByArg, 'user');

  const projByArg = await promptScopeSelection({ cliArgs: ['--scope', 'project'] });
  assert.equal(projByArg, 'project');

  const writeUser = await promptScopeSelection({ cliArgs: ['--write-user'] });
  assert.equal(writeUser, 'user');

  const writeProj = await promptScopeSelection({ cliArgs: ['--write-project'] });
  assert.equal(writeProj, 'project');
});
