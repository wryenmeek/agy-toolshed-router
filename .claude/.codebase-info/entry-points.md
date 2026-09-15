# Entry Points

*Last Updated: 2026-09-11*

## CLI Commands

All commands live in `bin/model-gateway.js` and are dispatched via a command router:

```bash
node bin/model-gateway.js <command> [options]
```

| Command | File Handler | Purpose | Output |
|---------|--------------|---------|--------|
| `setup` | `lib/setup.js` | Install proxy, start shim, wire project/user | Confirmation + next steps |
| `login` | `lib/oauth.js` | Browser OAuth for Codex subscription | Auth status |
| `ensure` | `lib/process-supervision.js` | Start shim if down (SessionStart hook) | Exit 0 (always, even if already running) |
| `status` | `lib/lifecycle-diagnostics.js` | Print running pids, ports, versions | Human-readable status |
| `doctor` | `lib/diagnostics.js` | Full system check + model table | Verbose report |
| `stop` | `lib/process-supervision.js` | Shut down shim + proxy gracefully | Exit status |
| `env --write-project\|--write-user\|--remove` | `lib/settings-wiring.js` | Manage wiring in `.claude/settings` | Confirmation or error |
| `pin [--opus\|--sonnet\|--fable\|--haiku] [id]` | `lib/pins.js` | Show/override Claude alias pins | Current pins or confirmation |
| `models` | `lib/runtime.js` | List advertised models (debug) | JSON or table |

## HTTP Endpoints

Shim router listens on `http://127.0.0.1:18764` (configurable via `CODEX_GATEWAY_PORT`):

| Endpoint | Method | Handler | Purpose |
|----------|--------|---------|---------|
| `/v1/models` | GET | `lib/runtime.js` | Model discovery (called by Claude Code, SessionStart hook refresh) |
| `/v1/messages` | POST | `lib/request-worker.js` | Messages API (main request flow) |
| `/v1/models/:id/schema-compat` | POST | `lib/tool-schema-compat.js` | Debug endpoint: test regex fixing (internal) |
| `/health` | GET | `lib/process-supervision.js` | Health check (used by supervisor probes) |

## Hooks

### SessionStart Hook

**Trigger**: Session starts (or resumes) in Claude Code

**Actions**:
1. Call `ensure --quiet` to start shim if down (max 12s wait)
2. Read effective ANTHROPIC_BASE_URL (process env > project settings > user settings)
3. Check if gateway is wired and running
4. Return single-line nudge if gateway is half-configured (login pending, etc.)

**File**: `hooks/hooks.json` → registered on plugin install

**Output**: Nudge line in session start message (or silent if healthy)

### Model Discovery Hook

**Trigger**: Claude Code asks for available models (SessionStart + model picker)

**Actions**:
1. Call `/v1/models` on running shim
2. Cache result in Claude Code's discovery cache
3. Populate `/model` picker rows

**Dependency**: Plugin must be installed and shim must be running

## Lifecycle Events

**File**: `~/.claude/model-gateway/logs/lifecycle.jsonl` (one JSON object per line)

Each event captures:
- Timestamp (ISO 8601)
- Event type (`spawn`, `started`, `exit`, `recovery-attempt`, `recovery-success`, `health-check`, etc.)
- Process info (supervisor/worker/proxy PID, parent PID)
- Command and args
- Exit code or signal
- Diagnostics (e.g., port conflicts, recovery backoff)

**Parsed by**: `doctor` command for human-readable summary

## Request Flow Example

User runs:
```bash
# In Claude Code or agent
/model claude-gpt-5.6-sol[1m]  # Select Codex
# Then use model in a session
```

**Flow**:
1. Claude Code creates Messages API request → sends to shim
2. `bin/model-gateway.js` child process spawned by supervisor
3. `lib/request-worker.js` receives HTTP POST `/v1/messages`
4. Detects `model: "claude-gpt-5.6-sol"` → routes to Codex backend
5. `lib/tool-schema-compat.js` scans tool schemas for regex incompatibilities
6. Injects Codex OAuth token (refreshed by proxy on 401)
7. Forwards to `claude-code-proxy` on localhost:18765
8. Proxy translates to OpenAI API, sends to Codex backend
9. Response comes back → shim transforms to Anthropic Messages format
10. Returns to Claude Code
11. Metadata logged to `request-routes.jsonl` (request/response sizes, duration, model, backend)

## Startup Sequence

1. **SessionStart hook** calls `ensure --quiet` (max 12s)
2. **Supervisor** (`process-supervision.js`) starts if not running
3. **Binary download** (first run only): fetch claude-code-proxy from GitHub releases, verify sha256
4. **Shim server** starts on port 18764, begins listening
5. **Proxy** starts on port 18765 (if Codex backend configured)
6. **Health checks** begin: every 10s, probe `/v1/models` on shim + `/health` on proxy
7. **On death**: Supervisor detects exit, recovers with exponential backoff (capped at 60s)
8. **Lifecycle** events written to `lifecycle.jsonl` for debugging

## Error Recovery

**Proxy offline**:
- Supervisor notices failed health check
- Records recovery attempt in lifecycle.jsonl
- Restart with bounded backoff
- After 3 failures, stop restarting; user must run `doctor` to see status

**Auth expired** (Codex 401):
- Request fails with 401 Unauthorized
- User runs `login` in Claude Code
- Proxy token refreshes
- Next request succeeds without restarting shim

**Port conflict**:
- Shim fails to bind port 18764
- Supervisor records error + likely process holding port
- User runs `doctor` (identifies conflict) or `stop` (kills old process)
- Restart via `ensure` or next SessionStart

