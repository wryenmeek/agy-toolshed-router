'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHILD_PROCESS_METHODS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

function childProcessCalls(source) {
  const calls = [];
  const namedImports = new Set();
  const namespaces = new Set();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['"]node:child_process['"]\)/g)) {
    for (const binding of match[1].split(',')) {
      const [imported, local] = binding.trim().split(/\s+as\s+/);
      if (CHILD_PROCESS_METHODS.has(imported)) namedImports.add(local || imported);
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]node:child_process['"]\)/g)) {
    namespaces.add(match[1]);
  }

  const namedPattern = namedImports.size ? [...namedImports].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '(?!)';
  const namespacePattern = namespaces.size ? [...namespaces].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '(?!)';
  const callsPattern = new RegExp(`(?:\\b(?:${namespacePattern})\\.(?:${[...CHILD_PROCESS_METHODS].join('|')})|\\b(?:${namedPattern}))\\s*\\(`, 'g');
  for (const match of source.matchAll(callsPattern)) calls.push({ match, method: match[0].trim().replace(/\($/, '') });
  return calls;
}

function inspectSource(source, file = '<source>') {
  return childProcessCalls(source).map(({ match, method }) => {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    const end = source.indexOf(');', match.index);
    const expression = source.slice(match.index, end === -1 ? source.length : end + 2);
    return {
      file,
      line,
      method,
      source: expression,
      hidden: /\bwindowsHide\s*:\s*true\b/.test(expression),
    };
  });
}

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

function inspectPlugin(pluginRoot) {
  return ['lib', 'bin']
    .map((directory) => path.join(pluginRoot, directory))
    .filter((directory) => fs.existsSync(directory))
    .flatMap((directory) => javascriptFiles(directory))
    .flatMap((file) => inspectSource(fs.readFileSync(file, 'utf8'), path.relative(pluginRoot, file)));
}

function unhiddenCalls(calls) {
  return calls.filter((call) => !call.hidden);
}

module.exports = { inspectPlugin, inspectSource, unhiddenCalls };
