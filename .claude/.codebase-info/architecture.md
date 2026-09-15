# Architecture

*Last Updated: 2026-09-11*

## System Overview

Model Gateway Shim Router is a local HTTP/HTTPS server that routes Claude Code requests to multiple LLM backends while maintaining a single connection point (`ANTHROPIC_BASE_URL` = `http://127.0.0.1:18764`). It's part of the model-gateway plugin ecosystem that extends Claude Code's `/model` picker.

## Core Components

```
┌─────────────────────────────────────────────────────────────┐
│ Claude Code (via ANTHROPIC_BASE_URL)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/HTTPS
                       ▼
┌──────────────────────────────────────────────────────────────┐
│ Shim Router (lib/runtime.js, lib/request-worker.js)          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Request Dispatcher                                      │ │
│  │  - Parse Anthropic Messages API format                 │ │
│  │  - Detect backend from model id (claude-gpt-*, etc)   │ │
│  │  - Route to appropriate backend                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │              │              │                      │
│   ┌──────▼──┐   ┌──────▼──┐   ┌──────▼──┐   ┌───────────┐   │
│   │ Codex   │   │  Grok   │   │  AGY    │   │  Claude   │   │
│   │Backend  │   │Backend  │   │Gemini   │   │ (passthru)│   │
│   │(GPT 5.6)│   │(Grok 4.5)│   │Backend  │   │           │   │
│   └──────┬──┘   └──────┬──┘   └──────┬──┘   └───────────┘   │
│          │              │              │                      │
│   ┌──────────────────────────────────────┐                    │
│   │ Schema Compat (tool name, regex fix) │                    │
│   │ Auth Handler (token refresh, OAuth) │                    │
│   │ Response Transform (Messages → fmt) │                    │
│   └──────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
   claude-code-proxy  Grok API    google-aes  (external)
   (localhost:18765)
```

## Backend Routing Logic

Model id format: `claude-<backend>-<model-variant>`

| Backend | Model ID | External Service | Auth | Notes |
|---------|----------|------------------|------|-------|
| **Codex** | `claude-gpt-5.6-sol`, `claude-gpt-5.6-terra`, `claude-gpt-6-astra` | claude-code-proxy (localhost:18765) | OAuth + login flow | Requires subscription; proxy handles OpenAI OAuth |
| **Grok** | `claude-grok-4.5` | Grok API (xAI) | X subscription + API key | Routed directly; schema compat applied |
| **AGY** | `claude-gemini-3.6-flash`, `claude-gemini-3.1-pro`, `claude-gpt-oss-120b` | google-aes (Gemini) | AGY CLI auth or `GEMINI_API_KEY` | 1M context windows; dynamic AGY models auto-discovered |
| **Claude** | `claude-opus`, `claude-sonnet`, `claude-haiku` | api.anthropic.com (no proxy) | Passthrough via env `ANTHROPIC_API_KEY` | Never routed through shim; requests pass byte-identically |

## Schema Compatibility Layer

Codex (GPT backend) rejects Unicode property escapes in JSON Schema regex patterns (e.g., `\p{Cc}`, `\P{Cf}`). The shim:
1. Detects Codex-bound tool schemas during deferred tool hydration
2. Removes only problematic regex atoms from `pattern` fields  
3. Preserves all other regex bytes and non-pattern schemas
4. Returns `400` with detailed error if pattern cannot be safely fixed

Affected schemas: `properties`, `patternProperties`, `additionalProperties`, `items`, `prefixItems`, `allOf`, `anyOf`, `dependentSchemas`, `propertyNames`, `unevaluatedProperties` / `unevaluatedItems`

## Lifecycle & Supervision

**Supervisor** (`lib/process-supervision.js`):
- Launches shim on startup (within 12s SessionStart hook budget)
- Probes proxy health via `/v1/models` endpoint
- Recovers failed proxy with bounded exponential backoff  
- Persists lifecycle events to `~/.claude/model-gateway/logs/lifecycle.jsonl`

**Model Discovery** (`lib/runtime.js`, `MODEL_WINDOW_POLICY`):
- Advertises model rows via `GET /v1/models` (shim endpoint)
- Each row includes backend id, advertised context window, and picker alias
- Codex windows (920k) advertised as `[1m]` alias for Claude Code (which caps at 200k for unknown models)
- Measured models (as of 2026-09-05): GPT-5.6 Sol/Terra/Luna, GPT-6 Astra, Grok 4.5 (500k)
- Unmeasured models use 920k default (Codex) or 1M (AGY/Gemini)

## Request-Response Flow

1. **Inbound**: Claude Code sends Anthropic Messages API request to shim
2. **Parse**: Extract model id, auth headers, tool definitions
3. **Route**: Determine backend from model prefix
4. **Auth**: Inject provider-specific credentials (Codex OAuth, Grok API key, AGY token)
5. **Schema Fix**: (Codex only) Detect/fix regex patterns in tool schemas
6. **Forward**: Send to backend with appropriate request format
7. **Transform**: Convert backend response back to Anthropic Messages format
8. **Return**: Send to Claude Code

## Error Handling

**Categories**:
- **Auth failures** → `401 Unauthorized` (invalid token, expired session, reauth needed)
- **Rate limits** → `429 Too Many Requests` (exponential backoff in proxy or at request worker level)
- **Schema errors** → `400 Bad Request` (tool not forwarded; names tool, JSON Pointer, reason code)
- **Proxy offline** → supervisor restarts; SessionStart waits ≤12s before returning
- **Provider outages** → pass through provider's error response

**Recovery**:
- Proxy death → supervised restart with bounded backoff
- Auth expiry → user runs `login` + `setup` to refresh credentials
- Schema incompatibility → change to compatible regex or use a different backend

