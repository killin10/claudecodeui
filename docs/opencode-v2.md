# OpenCode V2 integration

CloudCLI requires OpenCode **2.1.4 or a newer 2.x release**. It uses the official `@opencode/client` package, pinned to 2.1.4. The former `@opencode-ai/sdk/v2` entry point implements the V1 server protocol and is no longer used.

Each turn starts an authenticated `opencode serve` on a random loopback port. CloudCLI checks `/api/info` for readiness instead of parsing the CLI's startup banner, then subscribes to events before sending the prompt. The child inherits the service environment; authentication and ownership variables are added only to that child. Foreground completion retains the process while background work is pending. Failure, cancellation or completion of all work stops the owned process.

## Supported behavior

- Create or resume a session in the selected directory, select its model and reasoning variant, and switch between the plan agent and the configured default agent.
- Display text, reasoning, tool results, errors and subagent activity. Live messages and history use the same message/content identifiers. Native shell and todo tools use the command and checklist views; edit, write and patch tools use file previews and native diffs when available.
- Reply to permission requests and render V2 forms with native field types, defaults, conditions and constraints. Rejected answers retain the form and entered values for correction or retry. Noninteractive runs cancel forms instead of inventing user answers.
- Read history and usage from `session_v2` and `session_message` in OpenCode's database. Watch both the database and its WAL for changes.
- Search visible OpenCode conversations alongside other providers, with snippets and highlights. Search reads user text, assistant text and reasoning in cancellable batches; it excludes archived sessions, archived projects, tool output and internal messages.
- Display Skill activation, agent/model/directory changes, synthetic messages and instruction updates as they arrive. Live notices use the same identifiers and normalization as history to prevent duplicates after reload.
- Edit ordered user permission rules in Settings → Agents → OpenCode → Permissions. The panel also shows native configuration sources, agent rules and saved approvals for the selected project. Only user rules are editable; saves preserve JSONC comments and unrelated settings, and reject a stale configuration revision.
- Discover active credential integration identifiers from the V2 credential table without reading credential values. Manage MCP entries under `mcp.servers`, retaining other MCP settings.
- List and stop background shell and subagent tasks. Detached tasks retain the server until their native completion notification is delivered and the resulting execution finishes. Starting a new user turn stops the previous turn's remaining background work before starting another server, matching the Claude integration. A 30-minute ceiling bounds retained background work.
- Discover commands and Skills from the native catalog. `/review` and other native commands use `session.command`; `/compact` uses `session.compact` and accepts no arguments or attachments. The menu inserts `/skill:<id>` for Skills to distinguish them from commands with the same name. Skill mentions in text or command arguments carry native IDs and mention offsets; an unavailable explicit Skill reports an error.
- Display the last model request's context usage separately from cumulative session usage. Input includes cache reads and writes; output includes reasoning tokens. Model windows are obtained from the native catalog and saved through the session metadata API. Successful compaction marks context usage unavailable until the next model request measures it.

Native Skill and command discovery waits for plugin activation through `model.list`. In OpenCode 2.1.4, reading `skill.list` or `command.list` immediately after startup can return an incomplete catalog.

Permission settings honor `OPENCODE_CONFIG_DIR`, otherwise using the OpenCode directory under `XDG_CONFIG_HOME` or `~/.config`. An existing `opencode.jsonc` takes precedence over `opencode.json`. Native “Always allow” decisions are persisted in the project permission table when the request supplies a `save` scope. CloudCLI also retains a per-chat fallback for requests without that scope; the fallback does not replace native saved approvals.

The runtime does not fall back to V1. Existing V1 sessions must be migrated by OpenCode before CloudCLI can read them through the V2 store. CloudCLI does not rewrite the provider database. Its application session mapping remains separate, and deleting an application session never deletes the shared OpenCode database.

## Troubleshooting

1. Check `opencode --version` using the same PATH as the CloudCLI service. Update an older CLI with `opencode upgrade`.
2. If startup fails, run `opencode serve --hostname=127.0.0.1 --port=0` with the service's environment and inspect OpenCode's logs. CLI configuration errors, plugin startup failures and port errors are separate from model errors.
3. An error returned after a session is created, such as an authentication failure or insufficient balance, comes from the configured provider. Check that provider's credentials and quota; increasing the server startup timeout does not resolve it.
4. For local deployment, use the commands in [local-deployment.md](local-deployment.md). The deployment retains a previous release for rollback. Rolling back CloudCLI does not downgrade OpenCode's own database or configuration.

## Validation

The provider tests run the real V2 client against a temporary HTTP/SSE server and exercise startup, model selection, permissions, forms, cancellation, connection loss and process cleanup. Separate SQLite fixtures cover history, pagination, usage and application session mapping. Run them with the repository's Node 24 runtime:

```sh
npm test
npm run test:client
npm run build
npm run typecheck
npm run lint
```

The turn's event and permission callbacks intentionally share one lifecycle closure: cancellation, prompt resolution and stream completion must observe the same state. Separate provider components own server processes, background task tracking, native input dispatch, form validation, tool normalization and usage accounting. Live events, history and the token endpoint share the same usage calculation.

Protocol references: [V2 migration](https://opencode.ai/v2/docs/migrate-v1/), [official client](https://opencode.ai/v2/docs/build/client), [API](https://opencode.ai/v2/docs/api).
