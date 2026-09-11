# Automated Upstream Rebase Plan

## Goal

Automate maintenance of the AGY-enabled `model-gateway` fork against
`Eigenwise/eigenwise-toolshed` without silently overwriting AGY support or
publishing unreviewed runtime changes.

## Current problem

The fork and upstream share the `model-gateway` identity and several runtime
resources. Upstream updates must therefore be reviewed and tested before they
are adopted. The fork's AGY changes should remain a small, identifiable patch
series on top of upstream `main`.

## Proposed branch model

- `upstream/main`: fetched from `https://github.com/Eigenwise/eigenwise-toolshed.git`
- `agy-fork`: the maintained branch containing the upstream base plus AGY commits
- `automation/upstream-rebase-*`: temporary branches created by automation
- `main`: protected integration/release branch

The AGY implementation should not be mixed with unrelated maintenance changes.
If practical, preserve AGY work as one or more focused commits so rebases remain
mechanical and conflicts are easy to inspect.

## Automation

Add a scheduled and manually dispatchable GitHub Actions workflow:

1. Check out the fork repository with full history.
2. Fetch upstream `main`.
3. Rebase the maintained AGY branch onto the fetched upstream tip.
4. Run dependency installation and the complete test suite.
5. Run structural checks for AGY routing, plugin identity, ports, state paths,
   settings wiring, and process supervision.
6. If clean, push a temporary update branch and open or update a PR.
7. If conflicts occur, stop without resolving them automatically and open an
   issue or send a notification containing the upstream commit and conflict
   summary.

Recommended triggers:

- Weekly scheduled run.
- `workflow_dispatch` for an immediate sync.
- Optional run when upstream publishes a release or changes the plugin path.

## Required workflow permissions

Use the minimum permissions needed:

- `contents: write` for the automation branch.
- `pull-requests: write` to create/update the sync PR.
- `issues: write` only if conflict issues are created.

Do not force-push protected branches. Pin third-party actions to reviewed
versions or commit SHAs. Do not expose repository secrets to code from an
untrusted PR.

## Conflict policy

The workflow must fail safely when Git reports conflicts. It must not:

- Choose ours/theirs automatically for routing or lifecycle files.
- Rebase and publish directly to the release branch.
- Delete AGY files to make the rebase pass.
- Treat passing unit tests as proof that model routing is correct.

A maintainer resolves conflicts, runs the full suite, and merges the PR.

## Validation gates

At minimum, the sync PR must pass:

- `npm ci`
- `npm test`
- `git diff --check`
- AGY backend tests and request-routing tests
- Plugin manifest validation
- Checks that the AGY model prefixes and dynamic discovery remain present
- Checks that upstream Codex/Grok behavior remains present

Runtime-sensitive changes should additionally receive a manual review of:

- `lib/runtime.js`
- `lib/request-worker.js`
- `lib/process-supervision.js`
- `lib/settings-wiring.js`
- `hooks/hooks.json`
- `hooks/registry-writer.js`

Do not require a live login or a production gateway during CI. Use isolated
homes, ports, sockets, caches, and logs as the existing test suite does.

## Version and identity guardrails

Rebase automation does not solve runtime identity collisions. Before release,
the fork should either:

1. Remain the single AGY-enabled implementation of the upstream plugin, or
2. Move to a distinct marketplace/plugin identity and fully isolate its ports,
   state directory, proxy binary, discovery cache, registry, update launcher,
   settings namespace, and process ownership logic.

If the fork is distributed separately, use a distinct identity so an upstream
cache update cannot replace or outrank the AGY implementation.

## Rollout

### Phase 1: Prepare

- Host the fork in a Git repository with Actions enabled.
- Add and verify the `upstream` remote.
- Identify the canonical AGY-maintenance branch.
- Confirm branch protection and required checks.

### Phase 2: Automate sync PRs

- Add the scheduled/manual workflow.
- Add conflict issue or notification handling.
- Run it manually against the current upstream tip.
- Review the first generated PR without merging it.

### Phase 3: Harden

- Add AGY-presence and namespace regression checks.
- Add concurrency control so only one sync runs at a time.
- Automatically close or supersede stale sync PRs.
- Document the conflict-resolution and release procedure.

### Phase 4: Operate

- Merge clean sync PRs after review.
- Resolve conflicts manually and improve tests when upstream changes expose
  assumptions.
- Periodically evaluate whether AGY can be contributed upstream.

## Acceptance criteria

- A maintainer can start a sync from the Actions UI.
- A scheduled sync creates a reviewable PR when rebase and tests pass.
- A conflicting rebase never modifies the protected branch and produces an
  actionable notification.
- CI verifies both AGY and upstream model families.
- No workflow step force-pushes or silently resolves semantic conflicts.
- The release process clearly identifies which plugin identity and runtime
  resources the resulting build owns.

## Open decisions

- What repository will host the maintained fork?
- Should the maintained branch be named `agy-fork`, `main`, or another name?
- Should conflicts create GitHub issues, send notifications, or both?
- Should syncs be weekly or daily?
- Should the fork retain the upstream plugin identity as a replacement, or be
  fully namespaced for independent installation?
- Can the AGY backend be proposed upstream to eliminate long-term fork drift?
