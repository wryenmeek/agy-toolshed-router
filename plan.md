# Automated Upstream Rebase and Compatibility Plan

## Goal

Maintain the AGY-enabled `model-gateway` fork against
`Eigenwise/eigenwise-toolshed` with the least manual effort, without silently
losing AGY support, accepting incompatible upstream behavior, or publishing
unreviewed runtime changes.

This is a fork-drift and compatibility problem, not only a Git rebase problem:
a rebase can be conflict-free while upstream or AGY CLI behavior has changed.

## Evidence and maintenance boundary

The local fork is derived from upstream's `plugins/model-gateway` tree. The
local addition is AGY routing and translation; most lifecycle, wiring, hooks,
proxy, and test infrastructure follows upstream.

At the comparison point, upstream was commit
[`ae0554a6d9d40dd114b0c90cf9dfc215415565a1`](https://github.com/Eigenwise/eigenwise-toolshed/tree/ae0554a6d9d40dd114b0c90cf9dfc215415565a1),
version `0.50.17`, while the local fork was version `0.50.10`. Upstream had
files and tests absent locally, including `lib/codex-upstream-state.js`,
`test/gateway-ps-locale.test.js`, and `test/thread-negotiation.test.js`.
These differences demonstrate why tree and behavior drift must be detected
explicitly.

The official AGY CLI repository, package/release feed, and compatibility
contract are not yet recorded. Identifying that primary source is a Phase 1
prerequisite.

## Branch and repository model

- `upstream/main`: fetched from `https://github.com/Eigenwise/eigenwise-toolshed.git`
- `agy-fork`: maintained branch containing upstream plus focused AGY commits
- `automation/upstream-sync-*`: temporary branches created by automation
- `main`: protected integration/release branch

The AGY implementation should remain a small, identifiable commit series. Do
not mix unrelated maintenance changes into AGY commits. If the fork is hosted
separately, configure the upstream remote and protect the maintained branch.

## Runtime identity policy

Rebase automation does not solve runtime identity collisions. Choose one policy
before release:

### Replacement policy (recommended initially)

The AGY fork is the single installed `model-gateway` implementation. Do not
install the upstream marketplace copy beside it. Rebase and test the fork, then
release it as the chosen replacement.

### Independent-installation policy

If both distributions must be installable, the fork needs a distinct
marketplace/plugin identity and separate:

- ports
- state directory
- proxy binary/download location
- discovery cache
- registry and update-launcher paths
- settings/wiring namespace
- process ownership and recovery rules

A renamed plugin alone is insufficient. Claude Code still effectively selects
one `ANTHROPIC_BASE_URL` per project/process, so independent gateways are
alternatives per project, not a transparent chain.

## Low-cost upstream detection

Add a lightweight daily or twice-weekly workflow that does not require model
credentials:

1. Fetch upstream `main` and record its commit SHA.
2. Compare it with the last successfully inspected SHA.
3. Exit quietly when `plugins/model-gateway/**` did not change.
4. When it changed, classify touched paths as routing, lifecycle, wiring,
   hooks, tests, documentation, or package metadata.
5. Open or update an upstream-sync issue/PR with the SHA, changed paths, and
   risk classification.

Use a manual `workflow_dispatch` trigger as well. Add optional release/tag
polling once upstream's release process is confirmed.

The detector should also compare:

- `.claude-plugin/plugin.json` version and identity
- `package.json`
- `package-lock.json`
- `hooks/hooks.json`
- model-gateway source and test inventory

## Automated upstream sync PR

When relevant upstream changes exist:

1. Check out full history.
2. Fetch upstream `main`.
3. Rebase `agy-fork` onto the upstream tip.
4. Run dependency installation and all validation gates.
5. Create or update a reviewable sync PR.
6. Never modify the protected branch directly.

If conflicts occur, stop. Report the upstream SHA, conflicted paths, and
whether each conflict touches an AGY or runtime contract. Do not use automatic
ours/theirs resolution for routing, lifecycle, settings, hooks, or protocol
files.

Use concurrency control so only one sync runs at a time. Supersede stale sync
PRs rather than accumulating duplicates.

## Compatibility contracts

Create explicit tests and snapshots for the interfaces most likely to drift:

### Model Gateway contracts

- model prefixes and backend selection
- model discovery response shape
- `[1m]` alias generation and stripping before forwarding
- `/healthz` response shape
- `/v1/models` response shape
- lifecycle and process-ownership records
- project/user settings wiring
- hook commands and timeouts
- Anthropic passthrough byte preservation
- Codex/Grok continuation and context-error behavior
- remote-control bindability and hosts-file restoration

Treat upstream changes to these contracts as review-required even when the
rebase itself is clean.

### AGY contracts

The adapter currently assumes the following behavior:

- `agy --version` exists and returns successfully
- model data is an array in
  `~/.gemini/antigravity-cli/cache/models_cache.json`
- the CLI accepts `--input-format stream-json`, `--output-format stream-json`,
  `--disable-slash-commands`, `--dangerously-skip-permissions`, `--model`, and
  `--effort`
- CLI output contains `step_update` and `result` events
- Gemini REST/SSE responses contain the expected candidate, content-part,
  function-call, finish-reason, and usage fields

These assumptions are implemented in `lib/agy-backend.js` and
`lib/request-worker.js`; they must be treated as versioned compatibility
contracts, not undocumented implementation details.

Add:

- a documented `AGY_CLI_MIN_VERSION`
- a machine-readable AGY compatibility probe
- a fake-CLI fixture emitting representative stream events
- old/current/malformed model-cache fixtures
- Gemini REST/SSE response fixtures
- tests for missing flags, renamed events, missing usage fields, and unknown
  finish reasons
- doctor output that identifies unsupported or untested AGY CLI versions

Do not trust arbitrary cache data as model metadata; validate its shape and
fall back safely.

## Dependency and release drift detection

### Model Gateway

Fail or label the sync PR when any of these change:

- package dependency or engine requirements
- lockfile contents
- plugin identity or version
- hook definitions
- default ports, state paths, cache paths, or settings keys
- lifecycle/process-supervision code
- model routing or protocol code
- upstream files are added or local files unexpectedly disappear

Require an explicit release note for runtime-sensitive changes. Keep a
machine-readable last-inspected upstream SHA and plugin version in the sync
workflow or generated maintenance record.

### AGY CLI

After the official AGY source is identified, monitor its release/tag/API feed.
For every new release:

1. Record the version and release metadata.
2. Run `agy --version` and `agy --help`.
3. Compare supported flags with the expected contract.
4. Run the protocol probe using a fake or isolated credential-free request.
5. Validate stream event names and field shapes.
6. Validate model-cache schema and model discovery.
7. Open a compatibility PR or issue when behavior changes.

Maintain a tested-version range: minimum supported, current known-good, and
latest available. Do not automatically advance the minimum version.

## Validation gates

Every sync PR must pass:

- `npm ci`
- `npm test`
- `git diff --check`
- AGY backend and request-routing tests
- plugin manifest validation
- AGY-prefix and dynamic-discovery regression checks
- Codex, Grok, AGY, and Anthropic passthrough coverage
- dependency/lockfile review checks

Use the minimum supported Node version and the current Node version in CI.
The current package declares Node `>=22.5.0` and AJV `8.20.0`; detect changes
rather than assuming these remain stable.

Use isolated homes, ports, sockets, caches, logs, and settings. CI must not
require live ChatGPT, Grok, AGY, Gemini, or Anthropic credentials.

## Canary and promotion

Before releasing a merged sync:

1. Build the plugin artifact in a clean environment.
2. Install it into an isolated temporary Claude configuration.
3. Start the gateway using ephemeral test ports.
4. Exercise `/healthz` and `/v1/models`.
5. Test one fixture request for each backend and Anthropic passthrough.
6. Run `doctor` and verify the effective wiring and serving version.
7. Publish only after the canary passes.

Record the upstream SHA, fork version, AGY CLI version, Node version, and test
result with the release. Keep the previous artifact available for rollback.

## GitHub Actions permissions and safety

Use least privilege:

- `contents: write` only for automation branches
- `pull-requests: write` for sync PRs
- `issues: write` only if conflict issues are created

Pin third-party actions to reviewed commit SHAs. Do not expose secrets to
untrusted PR code. Never force-push protected branches or auto-merge changes
touching runtime/protocol contracts.

## Rollout phases

### Phase 1: Establish sources and ownership

- Host the maintained fork in a repository with Actions enabled.
- Configure and verify the `upstream` remote.
- Identify the canonical AGY CLI repository/release feed.
- Choose replacement versus independent-installation policy.
- Identify the canonical maintained branch.
- Configure branch protection and required checks.

### Phase 2: Detect and sync

- Add the lightweight upstream SHA/path detector.
- Add scheduled and manual sync workflows.
- Add conflict issue/notification handling.
- Run one manual sync against the current upstream tip.
- Review the first generated PR without merging it.

### Phase 3: Contract hardening

- Add model-gateway contract snapshots.
- Add AGY CLI version, flag, stream, and cache probes.
- Add dependency and lockfile diff guards.
- Add Node-version matrix testing.
- Add path-based CODEOWNERS review for runtime and protocol files.

### Phase 4: Canary and release

- Add isolated install and backend canary tests.
- Record provenance and tested dependency versions.
- Add rollback documentation and artifact retention.
- Require manual approval for runtime-sensitive releases.

### Phase 5: Reduce long-term drift

- Keep AGY changes focused and upstream-compatible.
- Contribute the AGY backend upstream where feasible.
- Remove fork-only compatibility code if upstream adopts AGY.

## Acceptance criteria

- A maintainer can start a sync from the Actions UI.
- Scheduled detection is quiet for unrelated upstream changes.
- Relevant changes produce a reviewable PR with SHA and risk classification.
- Conflicting rebases never modify protected branches and produce actionable
  notifications.
- AGY CLI releases are detected and compatibility-tested.
- CI verifies AGY, Codex, Grok, and Anthropic behavior.
- Dependency, lockfile, hook, identity, and runtime-path changes are visible.
- No workflow silently resolves semantic conflicts or force-pushes protected
  branches.
- A clean sync can be promoted through an isolated canary and rolled back.
- The release identifies the plugin identity and runtime resources it owns.

## Open decisions

- What repository will host the maintained fork?
- Should the maintained branch be `agy-fork`, `main`, or another name?
- Should conflicts create GitHub issues, notifications, or both?
- Should detection run daily, twice weekly, or weekly?
- What is the official AGY CLI source and release channel?
- What AGY CLI versions should be supported and tested?
- Should the fork retain upstream identity as a replacement, or be fully
  namespaced for independent installation?
- Can AGY be contributed upstream to eliminate long-term fork drift?
