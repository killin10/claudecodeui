# OpenCode V2 integration

CloudCLI requires OpenCode **2.1.4 or a newer 2.x release**. It uses the official `@opencode/client` package, pinned to 2.1.4. The former `@opencode-ai/sdk/v2` entry point implements the V1 server protocol and is no longer used.

Each turn starts an authenticated `opencode serve` on a random loopback port. CloudCLI checks `/api/info` for readiness instead of parsing the CLI's startup banner, then subscribes to events before sending the prompt. The child inherits the service environment; authentication and ownership variables are added only to that child. Completion, failure and cancellation stop the owned process.

## Supported behavior

- Create or resume a session in the selected directory, select its model and reasoning variant, and switch between the plan agent and the configured default agent.
- Display text, reasoning, tool results, errors and subagent activity. Live messages and history use the same message/content identifiers.
- Reply to permission requests and map V2 forms to the existing question panel. Noninteractive runs cancel forms instead of inventing user answers.
- Read history and usage from `session_v2` and `session_message` in OpenCode's database. Watch both the database and its WAL for changes.
- Discover active credential integration identifiers from the V2 credential table without reading credential values. Manage MCP entries under `mcp.servers`, retaining other MCP settings.

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
npm run build
npm run typecheck
npm run lint
```

The turn's event and permission callbacks intentionally share one lifecycle closure: cancellation, prompt resolution and stream completion must observe the same state. Server process ownership is isolated in `opencode-server.provider.ts`, and message projection is shared by live and historical rendering in the sessions provider.

Protocol references: [V2 migration](https://opencode.ai/v2/docs/migrate-v1/), [official client](https://opencode.ai/v2/docs/build/client), [API](https://opencode.ai/v2/docs/api).
