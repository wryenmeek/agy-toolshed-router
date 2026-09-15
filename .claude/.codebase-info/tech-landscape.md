# Tech Landscape

*Last Updated: 2026-09-11*

## Runtime & Core Dependencies

| Component | Role | Version |
|-----------|------|---------|
| **Node.js** | Runtime | ≥22.5.0 |
| **http/https** | Native protocol | Built-in |
| **crypto** | Token hashing, session keys | Built-in |

## Internal Modules

| File | Purpose |
|------|---------|
| `lib/runtime.js` | Model discovery, policy table, advertised window logic |
| `lib/request-worker.js` | Request parsing, routing, backend dispatch |
| `lib/settings-wiring.js` | Read project/user `.claude/settings.local.json` env block |
| `lib/process-supervision.js` | Shim lifecycle, proxy health checks, recovery |
| `lib/tool-schema-compat.js` | Regex pattern fixing for Codex compatibility |
| `lib/remote-control.js` | RC-compat mode (hosts file mapping, port 80 listener) |
| `lib/atomic-file.js` | Atomic writes to state/pid files (no corruption) |
| `lib/lifecycle-diagnostics.js` | Parse lifecycle.jsonl for session state and errors |
| `lib/pins.js` | Claude model alias resolution (Opus → version pin) |

## External Dependencies

**Development/Test**:
- `ajv` (8.20.0) — JSON Schema validation (test suite)

**External Services** (not npm):
- `claude-code-proxy` (v0.1.36+) — OpenAI OAuth bridge, runs on localhost:18765
- Grok API — xAI backend, requires credentials
- Google Gemini / AGY backend — Requires AGY CLI auth or `GEMINI_API_KEY`
- Anthropic API — Passthrough; used for native Claude models

## Configuration Files

| File | Purpose | Scope |
|------|---------|-------|
| `.claude/settings.local.json` | Project-scoped gateway wiring | This project only |
| `~/.claude/settings.json` | User-scoped gateway wiring (fallback) | All projects |
| `~/.claude/model-gateway/pins.json` | Claude model alias overrides | User global |
| `~/.claude/model-gateway/logs/request-routes.jsonl` | Request metadata log (disabled by `CODEX_GATEWAY_REQUEST_LOG=0`) | User global |
| `~/.claude/model-gateway/logs/lifecycle.jsonl` | Process lifecycle events | User global |
| `~/.claude/model-gateway/logs/guardian.log` | Supervisor startup/recovery output | User global |

## Environment Variables

**Set by user/project** (with defaults):
- `ANTHROPIC_BASE_URL` — Shim endpoint (default: `http://127.0.0.1:18764`); process env overrides settings files
- `CODEX_GATEWAY_PORT` — Shim listener port (default: 18764)
- `CODEX_GATEWAY_PROXY_PORT` — Proxy listener port (default: 18765)
- `CODEX_GATEWAY_REQUEST_LOG` — Enable request metadata logging (default: `1`; set `0` to disable)
- `CODEX_GATEWAY_REQUEST_LOG_PATH` — Custom path for request logs
- `CODEX_GATEWAY_COMPAT_PORT` — RC-compat listener port (default: 80)
- `CODEX_GATEWAY_HOSTS_FILE` — Custom hosts file path (Linux/macOS)
- `GEMINI_API_KEY` — AGY/Gemini backend credential (alternative to AGY CLI auth)

**Model window adjustments**:
- `CODEX_GATEWAY_COMPACT_TRIGGER` — Sentry mode trigger; capped by `autoCompactWindow`
- `CODEX_GATEWAY_CONTEXT_WINDOW` — Override advertised Codex window (for advanced use)
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — ⚠️ **Do not set**: applies to both Anthropic and Codex; can break Codex compaction after history exceeds limit

## Build & Test

```bash
# Run tests (Node.js built-in test runner, concurrent)
npm test

# Manual test of router on localhost:18764
node bin/model-gateway.js setup    # Start shim + proxy
node bin/model-gateway.js status   # Check running state
node bin/model-gateway.js doctor   # Full diagnostics
```

## Ports & Networking

| Port | Service | Notes |
|------|---------|-------|
| 18764 | Shim router | `http://127.0.0.1:18764` (ANTHROPIC_BASE_URL default) |
| 18765 | claude-code-proxy | OpenAI OAuth bridge; localhost only |
| 80 | RC-compat HTTP listener (optional) | Only when RC-compatibility mode enabled + hosts file mapped |
| 443 | Remote Control (native) | Uses Anthropic host, bypasses shim |

## Data Storage

**In-memory**:
- Model discovery cache (refreshed on each `/v1/models` probe)
- Request routing state (ephemeral per request)

**Persistent** (user home):
- `~/.claude/model-gateway/` — All durable state, logs, configs
- `~/.claude/settings.json` — Gateway env block wiring
- Project `.claude/settings.local.json` — Project-scoped wiring (takes precedence)

## Security & Credentials

**Authentication flows**:
- **Codex/GPT**: OAuth via browser → claude-code-proxy handles token refresh
- **Grok**: API key from user's xAI account → stored in settings or env var
- **AGY/Gemini**: AGY CLI auth (saved to OS keyring) or `GEMINI_API_KEY` env var
- **Claude**: Passthrough; uses main Anthropic API key from `~/.claude/` or env

**Secrets handling**:
- Never logged or printed (except in error diagnostics, always redacted)
- Passed via auth headers to backends; never stored in request logs
- Request metadata log (`request-routes.jsonl`) is metadata-only: no tokens, prompts, or tool definitions

