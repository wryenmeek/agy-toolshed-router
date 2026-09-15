# Patterns & Conventions

*Last Updated: 2026-09-11*

## Request Routing Pattern

All backend routing follows this shape in `lib/request-worker.js`:

```javascript
async function routeRequest(req) {
    const modelId = parseModelId(req.body.model);
    const backend = detectBackend(modelId);  // "codex", "grok", "agy", "claude"
    
    switch(backend) {
        case "codex":
            return routeCodex(req, modelId);
        case "grok":
            return routeGrok(req, modelId);
        case "agy":
            return routeAGY(req, modelId);
        case "claude":
            return passthrough(req);  // No routing, pass directly to Anthropic
    }
}
```

**Model ID format**: `claude-<backend>-<variant>` or just `claude-<variant>` for native models

Examples:
- `claude-gpt-5.6-sol` → Codex backend
- `claude-grok-4.5` → Grok backend  
- `claude-gemini-3.6-flash` → AGY backend
- `claude-opus` → Passthrough to Anthropic (no modification)

## Schema Compatibility Pattern

Codex rejects Unicode property escapes. The fix pattern in `lib/tool-schema-compat.js`:

```javascript
// Input regex (problematic for Codex):
"pattern": "[^\\p{Cc}\\p{Cn}]+"

// After compat layer:
"pattern": "[^]+"  // Atoms removed; other bytes preserved

// Returns error if can't fix safely:
{ "error": "tool name: schema at #/properties/field/pattern - unsafe regex context" }
```

**Rule**: Only fix if pattern is a simple negated character class without ranges/backrefs/etc.

**Coverage**: Scans `properties`, `items`, `additionalProperties`, `patternProperties`, `prefixItems`, `allOf`, `anyOf`, `unevaluatedProperties/Items`, `propertyNames`, `dependentSchemas`

**Non-covered**: `not`, `oneOf`, `contains`, `$ref`, content schemas, format validators

## Error Response Pattern

All error responses follow this envelope:

```json
{
  "type": "error",
  "error": {
    "type": "<ErrorType>",
    "message": "<human-readable>",
    "code": "<code>",
    "details": {}
  }
}
```

**Common codes**:
- `auth_failed` → 401 Unauthorized (token expired, invalid, reauth needed)
- `rate_limit` → 429 Too Many Requests (exponential backoff recommended)
- `schema_compat` → 400 Bad Request (tool not forwarded; details name the schema path + reason)
- `upstream_error` → forwarded provider error (500, 503, etc.)
- `port_conflict` → 503 Service Unavailable (shim failed to start)

## State File Patterns

**Atomic writes** via `lib/atomic-file.js`:

```javascript
atomic.write('/path/to/file.json', data, {
    mode: 0o600,  // Credentials: readable only by owner
    backup: true  // Keep .bak if write succeeds
});
```

**Files written**:
- `~/.claude/model-gateway/logs/lifecycle.jsonl` — append-only lifecycle events
- `~/.claude/model-gateway/logs/request-routes.jsonl` — append-only request metadata
- `~/.claude/model-gateway/logs/guardian.log` — supervisor output (overwrite, not atomic)
- `.claude/settings.local.json` — project wiring (merge, not replace)
- `~/.claude/settings.json` — user wiring (merge, not replace)
- `~/.claude/model-gateway/pins.json` — alias overrides (atomic)

## Concurrency Pattern

**Process model**:
- Supervisor runs continuously (one per machine)
- Shim worker spawned per request (Node.js cluster or stateless HTTP)
- Proxy is separate long-lived process on localhost:18765

**Avoid**: Direct file mutation by multiple processes
- Use atomic writes (lock-free with `.tmp` + rename)
- Read settings once per request, not cached across sessions
- Health checks read-only; never modify state during checks

## Timeout & Recovery Pattern

```javascript
const RECOVERY_BACKOFF = {
  initial: 100,    // 100ms
  max: 60_000,     // 60s
  exponential: 2   // double each attempt
};

// After N failures, stop restarting; user must intervene
const MAX_RECOVERY_ATTEMPTS = 3;
```

**Application**:
- Proxy fails to start → exponential backoff, retry up to 3x
- Health check fails → record in lifecycle, next check retries
- Auth expired (401) → return error to user, don't restart shim

## Logging Pattern

**On stdout** (for user/hook):
- Startup: single line "Shim running on http://..."
- Errors: clear, actionable ("Port 18764 already in use by PID 12345")
- Nudge on SessionStart: one line max

**In files** (append-only):
- `lifecycle.jsonl`: structured events (timestamp, type, pids, exit codes, diagnostics)
- `request-routes.jsonl`: request metadata (backend, model, path, effort, session id)
- `guardian.log`: supervisor output (raw, human-readable, overwrite mode)

**Secrets**: Never logged (credentials redacted in diagnostics, never in request logs)

## Configuration Precedence

**Reading settings** (checked in order, first match wins):

1. Process environment: `ANTHROPIC_BASE_URL=...` (hard override)
2. Project settings: `.claude/settings.local.json` (this repo only)
3. User settings: `~/.claude/settings.json` (global fallback)
4. Plugin defaults: hardcoded in code

**Writing settings**:
- `env --write-project` → `.claude/settings.local.json`
- `env --write-user` → `~/.claude/settings.json`
- Never modify global `~/.claude/settings.json` from project-level commands

## Testing Pattern

Tests use Node.js built-in `node --test`:

```bash
npm test  # Concurrency=2, 300s timeout
```

**Test file layout**:
- `test/request-routing.test.js` — Model detection, backend routing
- `test/schema-compat.test.js` — Regex fixing, edge cases
- `test/lifecycle.test.js` — Supervisor recovery, health checks
- `test/auth.test.js` — OAuth, token refresh, 401 handling
- Fixtures in `test/fixtures/` — Schemas, mock responses, test data

**Mock pattern**:
- Proxy: stub HTTP server on test port
- Backends: fixtures (no real API calls)
- File I/O: in-memory or temp directories

