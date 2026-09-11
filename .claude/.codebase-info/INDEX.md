# AGY Toolshed Router

*Last Updated: 2026-09-11*

Shim router for the model-gateway plugin. Routes requests from Claude Code to multiple backend providers (Codex/GPT, Grok, AGY/Gemini, native Claude). Handles authentication, schema compatibility, model discovery, and lifecycle management.

**Size**: ~55 files | **Stack**: Node.js 22.5+  
**Purpose**: Local HTTP gateway routing for multi-backend model access

## Quick Links

- [Architecture](architecture.md) — Router design, provider routing, schema compatibility
- [Tech Stack](tech-landscape.md) — Runtime, dependencies, config files
- [File Structure](directory-structure.md) — Directory tree and component organization
- [Entry Points](entry-points.md) — Startup, CLI commands, HTTP routes
- [Patterns](patterns.md) — Request handling, backend routing, error recovery

## How to Use This Map

Each doc stands alone and covers one aspect. Start with Architecture for system overview, then navigate by file path in Entry Points to find specific command handlers or routes. When adding a feature, update the doc that covers it (e.g., new backend provider → update Architecture routing diagram).

**Staleness check**: The hook injects this map at session start and re-assesses it after code changes. If its hash in `.map-state.json` differs from the docs on disk, the map is fresh; if unchanged for the git HEAD since the last map run, skip updating.

