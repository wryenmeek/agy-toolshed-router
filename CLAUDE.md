# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

Requires Node.js `>=22.5.0`.

```bash
npm ci                         # install the locked test dependency set
npm test                       # run the full suite (Node test runner, concurrency 2)
npm test -- --test-name-pattern='pattern'  # run matching tests
node --test test/foo.test.js   # run one test file directly
node --check lib/foo.js        # syntax-check a JavaScript file
node bin/model-gateway.js      # print CLI usage
```

There are no separate build or lint scripts in `package.json`. The project is tested as plain CommonJS JavaScript; `ajv` is the only declared development dependency. Tests use isolated gateway homes, ports, processes, caches, and logs, so do not redirect them at a live installation.

## Architecture

This repository is the Model Gateway Claude Code plugin. It exposes subscription/CLI-backed GPT/Codex, Grok, and Antigravity (AGY)/Gemini models through Claude Code's Anthropic-compatible model picker while passing ordinary Claude traffic through to Anthropic.

- `bin/model-gateway.js` is the thin executable entry point. It dispatches subcommands to `lib/commands.js`.
- `lib/commands.js` owns the CLI operations and composes the gateway: setup/login, status/doctor, ensure/start/stop, environment wiring, discovery-cache updates, pin management, and the server modes. Keep command behavior and user-facing diagnostics here, but use the extracted modules for their domain responsibilities.
- `lib/request-worker.js` is the HTTP routing and proxying core. It buffers/parses requests when necessary to resolve model routes, maps gateway model ids to Codex, Grok, or AGY backends, preserves the Anthropic passthrough path, handles streaming/response behavior, and emits route/usage evidence. Routing is based on the backend family, not merely the `claude-` discovery prefix.
- `lib/runtime.js` is the shared policy/configuration layer. `MODEL_WINDOW_POLICY` is the authority for gateway model ids, backend and advertised context windows, picker aliases, and sentry behavior; it also handles runtime paths, discovery catalogs/cache, and environment-derived settings.
- `lib/agy-backend.js` and `lib/grok-backend.js` adapt provider-specific request/stream formats and authentication. `lib/tool-schema-compat.js` applies the narrow Codex-only deferred JSON Schema compatibility transform; Claude-side schemas and Anthropic requests must remain unchanged.
- `lib/process-supervision.js` manages the long-lived shim, proxy, and guardian processes, readiness/recovery probes, ownership checks, bounded backoff, lifecycle evidence, and safe cleanup. `lib/lifecycle-diagnostics.js` records and summarizes lifecycle evidence. `lib/windows-detached.js` contains the Windows-specific detached startup path.
- `lib/settings-wiring.js`, `lib/pins.js`, and `lib/remote-control.js` isolate settings precedence/wiring, Claude model pin resolution, and opt-in Remote Control compatibility. `lib/atomic-file.js` provides the safe file replacement primitives used by state and cache writes.
- `lib/usage-observability.js` produces counts-only usage/composition records and bounded local high-water data. It must not retain or emit prompts, messages, tool schemas/arguments/results, credentials, arbitrary headers, or response content. See `docs/usage-observability.md` for the record contract and estimation rules.
- `hooks/hooks.json` registers SessionStart hooks: `hooks/registry-writer.js` records plugin registration, then `ensure --quiet` starts or checks the gateway within the hook budget. The hook is intentionally fail-soft; use explicit `ensure`/`doctor` when an exit status or detailed diagnosis is needed.
- `skills/model-gateway/SKILL.md` and `skills/remote-control-compatibility/SKILL.md` are operational instructions surfaced to Claude Code. Keep them aligned with CLI behavior, settings precedence, restart requirements, and safety boundaries in the implementation.
- `test/support.js` provides isolated process/gateway fixtures. The many `test/*.test.js` files exercise routing, provider adapters, discovery and wiring, supervision/readiness/drain behavior, context windows, schema compatibility, observability, and platform-specific process handling.

## Operational invariants

- Project-local wiring is the default; process `ANTHROPIC_BASE_URL` takes precedence over settings files. Settings/discovery/plugin/model-row changes require a new Claude Code process; auth refresh alone does not.
- The normal shim/proxy ports are `18764` and `18765`, overridable through the documented environment variables. Do not assume a listener is owned by this installation from a matching binary alone: ownership must be proven before stopping it.
- RC-compatibility involves a user-managed hosts-file mapping and port 80; do not edit hosts files outside the documented confirmation-gated procedure.
- Update both README/skills when changing user-visible commands or recovery behavior, and add or adjust the focused Node tests before running the full suite.
