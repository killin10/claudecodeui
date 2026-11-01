# macOS local deployment

## Approved scope

Build the current working copy, install independent versioned releases, and run the compiled server with a per-user macOS LaunchAgent. Use `~/.local/share/cloudcli`, `~/.config/cloudcli`, `~/Library/Logs/cloudcli`, and `~/Library/LaunchAgents/local.cloudcli.plist`. Do not change backend/frontend business code or upstream update entrypoints. Do not publish, commit, or change global Node installations.

## Approaches

Local npm tarball installation is simpler but replaces the installed version. Docker adds host credential/filesystem complexity. The selected approach is independent release directories with a `current` link and LaunchAgent supervision, making source-directory independence and controlled rollback explicit.

## Runtime and layout

Each release contains compiled client/server output, public/shared resources, production dependencies, a sanitized deployment-only package manifest, lockfile, metadata, and a link to the external server.env. The default database and other application data remain under ~/.cloudcli. Runtime paths are generated from the user's home directory rather than hardcoded in source. Use a resolved absolute Node executable and record/check its exact version; prefer an available LTS, but do not change global Node automatically.

A stable installed management command supports start/stop/restart, enable/disable, status/logs/releases/rollback/uninstall. LaunchAgent runs a shell launcher which checks Node/release metadata and execs the compiled entrypoint, with explicit HOME/PATH and no interactive shell startup files. RunAtLoad and KeepAlive provide login startup and restart throttling. Stop unloads the job; disable persists the disabled state. Uninstall preserves configuration, logs, backups and application data.

## Deployment transaction

Build and production installation happen before stopping the old service. A directory lock serializes mutating operations. Refuse unknown existing directories/plists, foreign port listeners and release links outside the owned release directory. Preserve user configuration. Check native SQLite and PTY operations before activation. Stop the owned service, take a consistent SQLite backup, switch current atomically, restart and verify health, process identity and frontend assets. Retain previous for rollback and several recent releases. Schema changes block automatic code rollback; never silently restore a database backup. Explicit rollback also checks the recorded schema compatibility boundary. No promise of uninterrupted agent/terminal sessions.

Default target binding is 0.0.0.0:3001 (IPv4). On first-ever account setup, temporary loopback binding is recommended; do not invent user credentials. Do not expose an uninitialized instance automatically without a conscious operator choice. Existing update controls remain unchanged and must not be used for deployment management.

## Verification and limits

Tests cover filesystem ownership, spaces/XML escaping, configuration preservation, lock contention, package sanitization, atomic release selection, failed start recovery, schema mismatch, native modules and Node mismatch. Verify real build/typecheck/lint/tests, installed source independence, launchd state, listening address, health and frontend delivery. Actual login startup requires a later logout/login or reboot. Rotate logs on controlled restart; this is not a continuous size cap. No HTTPS/firewall/IPv6/sleep-prevention changes.
