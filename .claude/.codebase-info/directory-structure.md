# Directory Structure

*Last Updated: 2026-09-11*

```
agy-toolshed-router/
├── bin/
│   └── model-gateway.js          # CLI entry point (setup, login, status, doctor, ensure, etc.)
│
├── lib/
│   ├── runtime.js                # Model policy table, discovery, window logic
│   ├── request-worker.js         # Request routing, backend dispatch, schema compat
│   ├── settings-wiring.js        # Load env block from .claude/settings files
│   ├── process-supervision.js    # Shim/proxy lifecycle, health checks
│   ├── tool-schema-compat.js     # Regex pattern fixing for Codex
│   ├── remote-control.js         # RC-compat mode (hosts file, port 80)
│   ├── atomic-file.js            # Safe concurrent file writes
│   ├── lifecycle-diagnostics.js  # Parse lifecycle.jsonl
│   ├── pins.js                   # Claude model alias resolution
│   ├── agy-backend.js            # AGY/Gemini backend handler
│   └── grok-backend.js           # Grok backend handler
│
├── hooks/
│   ├── hooks.json                # Hook definitions (SessionStart: ensure gateway running)
│   └── registry-writer.js        # Write discovery cache for model picker
│
├── test/
│   ├── *.test.js                 # Node.js built-in test suite (~10 test files)
│   └── fixtures/                 # Test data, schemas, mock responses
│
├── docs/
│   ├── usage-observability.md    # Telemetry setup & interpretation
│   ├── api-reference.md          # /v1/models, /v1/messages endpoints
│   └── troubleshooting.md        # Common issues & fixes
│
├── .claude/
│   └── skills/
│       └── verify/
│           └── SKILL.md          # model-gateway:verify-plugin skill
│
├── .claude-plugin/
│   └── plugin.json               # Plugin metadata (name, version, hooks)
│
├── package.json                  # Node.js manifest (ajv dev dep)
├── CHANGELOG.md                  # Release notes
├── README.md                      # Setup guide, model table, Remote Control
├── .gitignore                    # Standard Node.js ignores
└── .golangci.yml, .goreleaser.yaml  # (from upstream Printing Press; unused)
```

## Key File Roles

### `bin/model-gateway.js` — Main CLI

Entry point for all model-gateway commands:
- `setup` — Download proxy binary, start shim, write wiring
- `login` — Browser OAuth for Codex/GPT subscription
- `ensure` — Start gateway if down (SessionStart hook calls with `--quiet`)
- `doctor` — Full diagnostic: binary, auth, ports, model counts, wiring
- `status` — What's currently running (pids, ports)
- `stop` — Shut down shim and proxy
- `env --write-project|--write-user|--remove` — Manage `.claude/settings.local.json` wiring
- `pin --opus|--sonnet|--fable|--haiku [override]` — Manage Claude alias pins

### `lib/request-worker.js` — Core Router

Handles each inbound HTTP request:
1. Parse Anthropic Messages format
2. Detect backend from model id (`claude-gpt-*` → Codex, etc.)
3. Apply schema compat fixes (Codex only)
4. Forward to backend with auth
5. Transform response back to Anthropic format

### `lib/runtime.js` — Model Discovery

`MODEL_WINDOW_POLICY` table is the system-of-record for:
- Which models are advertised
- Backend and picker ids (e.g., `claude-gpt-5.6-sol[1m]`)
- Advertised context windows (920k for Codex, 500k for Grok, 1M for AGY)
- Sentry mode and compaction trigger
- Measurement date and any caveats

### `test/` — Test Suite

Built-in Node.js test runner (no external framework):
```bash
npm test  # Runs all *.test.js files with concurrency=2, 5-minute timeout
```

Tests verify:
- Request parsing and routing
- Schema compatibility fixes
- Backend dispatch
- Error responses
- Lifecycle management

