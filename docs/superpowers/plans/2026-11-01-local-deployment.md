# Local Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and operate standalone CloudCLI releases on macOS without changing business code.

**Architecture:** Dependency-free Node ESM deployment tooling and a launchd adapter. Pure filesystem/configuration helpers and an injected activation controller make deployment transactions testable without touching the real user's service.

**Tech Stack:** Node.js built-ins, npm ci, launchctl, SQLite backup via installed better-sqlite3, macOS LaunchAgent.

**Spec:** docs/superpowers/specs/2026-11-01-local-deployment-design.md

## Global Constraints

- Installation: ~/.local/share/cloudcli; configuration: ~/.config/cloudcli; logs: ~/Library/Logs/cloudcli.
- LaunchAgent: local.cloudcli, ~/Library/LaunchAgents/local.cloudcli.plist.
- No server/ or src/ changes; no update-entrypoint changes; no global Node mutation.
- No source-directory runtime dependencies, no npm start, no global npm package replacement.
- Preserve existing user data/configuration; refuse foreign resources.
- No commits/pushes or subagents requested. Execute in this checkout without creating an unrequested worktree.

## Review Focus

- Home and executable paths containing spaces/XML metacharacters must work (Task 1).
- Unknown files, escaping symlinks and a second concurrent deploy must not be overwritten (Task 1).
- A failed boot or database schema change must not silently lose data (Task 2).
- Production lifecycle scripts must not require Husky, but native install scripts must run (Task 2).
- First-run account setup and external port ownership must be explicit, not hidden (Task 3).

### Task 1: Filesystem/configuration contracts

**Files:** scripts/deploy/layout.mjs, scripts/deploy/tests/layout.test.mjs.
**Interfaces:** paths(home), initialize(paths, runtime), readConfig(paths), resolveRelease(paths, link), selectRelease(paths, link, release), withLock(paths, fn), renderPlist(paths, runtime), runtimeManifest(packageJson).

- [x] Write tests using temporary homes for config preservation/permissions, foreign resource rejection, lock contention, release-link validation, plist escaping and production package scripts.
- [x] Run `node --test scripts/deploy/tests/layout.test.mjs`; observed missing implementation failure.
- [x] Implement helpers; all layout tests pass, including macOS /var versus /private/var path alias handling.

### Task 2: Release creation and transactional activation

**Files:** scripts/deploy/release.mjs, scripts/deploy/activation.mjs, scripts/deploy/tests/activation.test.mjs.
**Interfaces:** stageRelease(source, paths, runtime), activate(paths, release, adapter), adapter stop/start/check/backup/schema.

- [x] Write failure-injection tests with real filesystem links and controlled external service adapters: successful switch, failed check, schema mismatch, initial install failure, rollback selection.
- [x] Run tests and observe failures before implementing activation.
- [x] Implement build/check/stage, isolated production dependencies, native smoke checks and metadata.
- [x] Implement stopped-service backup, atomic links, readiness checks and conservative recovery; all deployment tests pass.

### Task 3: LaunchAgent and installed management interface

**Files:** scripts/deploy/launchd.mjs, scripts/deploy/cli.mjs, scripts/deploy/deploy.mjs, scripts/deploy/tests/runtime.test.mjs, package.json, docs/local-deployment.md.
**Interfaces:** installed cloudcli-service command; npm run deploy:local [-- --setup-local].

- [x] Write process tests for generated launcher and node mismatch, plist validation, native smoke probe and env configuration validation.
- [x] Run tests RED, implement launcher and launchd operations, then rerun GREEN.
- [x] Add deployment entrypoint and npm aliases, plus installation/rollback/first-account documentation.
- [x] Run deployment suite, full project checks and review the diff without delegating; evidence and exception below.
- [x] Check host ownership/port/runtime; installed and validated the real service. Started local-only for account registration, then verified needsSetup=false and switched to 0.0.0.0:3001.

## Execution record

- Ruling: perform implementation in the existing checkout, without an unrequested worktree, commit, or subagent; operator explicitly authorized execution on this fork.
- Ruling: initial Homebrew-only inspection found Node 26, but its locked better-sqlite3 dependency rejects that major version. Expanded inspection found existing nvm Node 24.18.0 LTS; pin that executable without changing global Node. The original proposed Node 26 fallback was discarded.
- Ruling: typecheck has a pre-existing TS2345 at src/modules/sidebar/tests/recentConversationTitleSync.test.ts:50 (missing backgroundSessionIds). Leave src/ unchanged and explicitly deploy with --skip-typecheck; store the exception in release metadata. This must not be used to hide newly introduced type errors.
- Task 1: complete — real filesystem tests and plutil round-trip pass.
- Task 2: complete — failure-injection activation tests, live SQLite WAL backup and native probes pass.
- Task 3: complete — 22 deployment tests pass; backend 816 pass/4 skip; frontend 905 pass. Build succeeds. Existing application lint and new deployment lint exit 0 (application warnings remain).
- Final review: self-review; no subagent was authorized. Added RED→GREEN regressions for blocking restart after manual database recovery and preserving the login SSH agent without inheriting unrelated environment secrets.
- Host verification: installed two releases, tested rollback in both directions, disable/enable, controlled restart and KeepAlive restart after launchctl SIGTERM. Verified launchd PID/application marker/health/frontend assets, three private database backups, and enabled login startup.
- Final host state: account initialization became complete during verification (needsSetup=false); changed server.env HOST to 0.0.0.0 and restarted. lsof confirms TCP *:3001 (IPv4), health is ok and local.cloudcli is enabled. Actual logout/login startup, access from another machine and authenticated provider calls are not yet verified.
- Integration: changes remain uncommitted in the original checkout; no branch switch, merge, push, global npm install, global Node update or business-code changes.
