# Gemini API project failover plan

## Status

Draft implementation plan. This document does not change runtime behavior.

## Goal

Add quota-aware failover to the direct Gemini API path so the gateway can use multiple authorized API credentials, with each credential belonging to a different Google Cloud project.

The gateway should be able to:

- classify Gemini quota and authentication failures;
- fail over to another compatible project before a response begins;
- avoid repeatedly selecting an exhausted project;
- recover projects after cooldown or a known daily reset; and
- expose redacted operational state without exposing credentials or content.

## Scope and non-goals

### In scope

- The direct API-key path in `forwardAgy`.
- A project-aware credential pool.
- Bounded retry and failover before response commitment.
- Non-secret cooldown and quota state.
- Setup, doctor, readiness, observability, and regression tests.

### Out of scope for the first implementation

- Rotating keys that belong to the same Google Cloud project.
- Implicit fallback from an exhausted API key to the AGY CLI.
- Reverse-engineering or automating the Gemini desktop application.
- Keeping a synchronous `/v1/messages` request open until a daily reset.
- Durable asynchronous job resumption.

## Current implementation boundary

The existing code has a single-key API path:

- `lib/agy-backend.js:35-49` selects `GEMINI_API_KEY` before AGY CLI or ADC.
- `lib/request-worker.js:1863-1957` sends one Gemini REST request and translates the response.
- `lib/request-worker.js:1890-1901` treats only HTTP 401 specially; other non-2xx responses, including 429, become `api_error` responses.
- `lib/request-worker.js:1960-2084` is the separate AGY CLI bridge.

Google documents Gemini limits as project-scoped. Relevant dimensions include requests per minute, tokens per minute, requests per day, model-specific limits, and paid-tier spend limits. Daily request quotas reset at midnight Pacific Time. The public documentation does not guarantee a universal remaining-quota or reset-time header.

Sources:

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini API errors](https://ai.google.dev/gemini-api/docs/api-errors)
- [Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)

## Proposed configuration

Represent each pool member as a project, not just a key:

```json
{
  "projects": [
    {
      "id": "gemini-primary",
      "project_id": "google-project-a",
      "api_key_env": "GEMINI_PROJECT_A_KEY",
      "models": ["gemini-3.1-pro"],
      "priority": 10
    },
    {
      "id": "gemini-backup",
      "project_id": "google-project-b",
      "api_key_env": "GEMINI_PROJECT_B_KEY",
      "models": ["gemini-3.1-pro"],
      "priority": 20
    }
  ]
}
```

The exact storage mechanism should follow existing setup conventions. Raw keys must remain in environment variables, the macOS keychain, or another secret manager; they must not be written to catalogs, logs, or quota state.

Each entry should validate:

- stable local alias;
- explicit Google Cloud project ID;
- secret reference;
- supported model set or wildcard policy;
- priority and optional weight; and
- enabled/disabled configuration state.

## Runtime state machine

Each project gets independent non-secret runtime state:

```text
healthy -> transient_cooldown -> healthy
healthy -> daily_exhausted -> healthy at reset
healthy -> disabled -> healthy after operator action
```

Track:

- last failure time;
- failure class and upstream status;
- retry count;
- cooldown deadline;
- estimated quota-reset deadline;
- consecutive failures; and
- last successful request time.

State should be persisted atomically if it must survive gateway restarts. It must never contain API keys, authorization headers, prompts, or generated content.

## Request and failover flow

1. Resolve the requested model.
2. Select compatible projects that are currently eligible.
3. Prefer priority order; use round-robin among equal-priority projects.
4. Send the request to one project.
5. Classify the response status and error body.
6. Update that project's state.
7. Retry another project only when no downstream response has been committed.
8. Attempt each project at most once per request.
9. If all projects fail, return a normalized error with retry metadata where available.

### Failure classification

- `401`: missing, invalid, or expired credential; disable the project until configuration is repaired.
- `403`: inspect the structured error for permission/configuration meaning; do not treat it as quota exhaustion or blindly rotate.
- `429` burst/rate/token limit: short bounded cooldown with exponential backoff and jitter.
- `429` daily quota: disable the project until the next known reset.
- `429` spend limit: use a short cooldown unless the provider identifies a longer period.
- transient `500`/`503`/`504` or network error: bounded retry; failover only under an explicit policy because the upstream may have accepted the request. Do not blindly retry unsupported `501` responses.
- malformed request or unsupported model: do not rotate; return the client/configuration error.

Google's public API error documentation does not define a universal `Retry-After` contract. If the header is present in an observed response, use it within configured maximums and preserve useful retry metadata for the client; otherwise use the documented error category and bounded backoff. If the error is ambiguous, use a conservative short cooldown rather than assuming daily exhaustion.

## Streaming boundary

Failover is transparent only before SSE headers or response content are sent.

After a stream begins:

- do not switch projects;
- do not replay the request transparently; and
- terminate with an error if the stream fails.

This avoids duplicate generations, inconsistent tool calls, and impossible stream substitution.

## Recovery and resume

### First phase: new-request recovery

A scheduler or request-time eligibility check re-enables projects when their cooldown deadline passes. Daily quota entries should use the documented midnight-Pacific reset when the failure is confidently classified as daily exhaustion.

### Later phase: durable job resumption

If work must continue after all projects are exhausted, add a separate asynchronous job contract:

```text
submit job -> job ID -> queued -> running -> completed/failed
```

The queue would need durable request state, cancellation, encrypted secret references, retry scheduling, and polling or callback support. It should not be hidden inside the existing synchronous `/v1/messages` request, and it must define how tool calls and partial results are handled.

## Likely code changes

Potential new modules:

- `lib/gemini-project-pool.js` — configuration, selection, and model compatibility.
- `lib/gemini-error-classifier.js` — status/body classification.
- `lib/gemini-quota-state.js` — cooldown, reset, and persistence.

Likely existing changes:

- `lib/agy-backend.js` — load and validate the project pool.
- `lib/request-worker.js` — bounded attempts, project selection, failover, and error metadata.
- `lib/commands.js` — setup, doctor, and readiness reporting.
- `lib/runtime.js` — model/project compatibility policy.
- `docs/` — configuration and operations guidance.

## Observability and security

Record only redacted metadata:

```text
backend=agy project=gemini-backup failure_class=daily_quota attempt=2 failover=true
```

Do not record API keys, authorization headers, full upstream bodies, prompts, or generated content.

Health and doctor output should report counts and aliases, for example:

```text
3 configured projects
2 healthy
1 cooling down
0 invalid
```

## Test strategy

### Unit tests

- configuration validation;
- model compatibility filtering;
- project selection and priority/round-robin behavior;
- each error classification;
- cooldown and reset transitions;
- persistence without secret leakage; and
- retry-delay calculation.

### Integration tests

- first project succeeds;
- first project returns 429 and backup succeeds;
- daily exhaustion suppresses one project;
- all projects exhausted;
- invalid key does not cause infinite retries;
- `Retry-After` is preserved or normalized;
- non-streaming failover occurs before response commitment;
- streaming failover is refused after headers/content begin; and
- gateway restart restores non-secret quota state.

### Concurrency tests

- concurrent requests do not all select a project just marked exhausted;
- cooldown updates are single-flight or otherwise race-safe; and
- state writes are atomic.

## Delivery stages

1. **Configuration and selection** — project pool, secret references, validation, and readiness output.
2. **Error classification** — structured 401/403/429/5xx handling and unit tests.
3. **Bounded failover** — per-request attempts, cooldowns, and streaming boundary.
4. **Persistence and recovery** — non-secret state, restart recovery, and reset scheduling.
5. **Optional asynchronous jobs** — only if reset-based continuation is required.

## Recommended defaults

- Require all backup projects to support the requested model.
- Prefer priority ordering and round-robin equal-priority projects.
- Fail over on confirmed quota exhaustion, not malformed requests.
- Retry transient limits briefly with jitter.
- Return immediately when every project is unavailable.
- Keep asynchronous resume out of the first implementation.

## Open decisions before implementation

1. Are all projects authorized under compatible billing, organization, and Google policy arrangements?
2. Must every project support every advertised Gemini model, or should the catalog expose project-specific availability?
3. Should exhausted requests fail immediately, or should a later phase provide a durable job/polling API?
