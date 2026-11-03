# Session CLI

`cloudcli session` manages the sessions in a running CloudCLI server. It does not start a second server or open its database. All business arguments are named options; extra positional arguments, unknown options and duplicate options are errors.

## Installation and authentication

Local macOS deployment installs `~/.local/bin/cloudcli`. Add `~/.local/bin` to the caller's PATH if necessary, or use the absolute path in scheduled jobs. The launcher uses the deployment's pinned Node and resolves `current` on each invocation. It preserves the caller's working directory and does not replace an unrelated existing command.

Create an API key in CloudCLI settings. Set `CLOUDCLI_API_KEY`, or store it in `~/.config/cloudcli/cli.json` with mode `0600`:

```json
{"endpoint":"http://127.0.0.1:3001","apiKey":"YOUR_API_KEY"}
```

The endpoint precedence is `--endpoint`, `CLOUDCLI_ENDPOINT`, config file, then `http://127.0.0.1:3001`. `--config-file` selects another config file. An environment API key overrides the file key. Credentials are sent only in the `x-api-key` header; redirects are refused. Debug output does not include request bodies or credentials.

The API is mounted at `/api/session-control/v1` and validates the per-user UI API key independently of the legacy `API_KEY` environment gate. Session visibility is the same shared workspace as the UI. Submission results and cancellation are restricted to the API key's user. This is not a new per-user project isolation mechanism.

## Commands

```bash
cloudcli session list --provider codex --archive-state active --max-items 20 --output table
cloudcli session list --project-path /absolute/server/project --execution-state running
cloudcli session show --session-id SESSION_ID

cloudcli session create --provider codex --project-path /absolute/server/project \
  --model MODEL_ID --title "Daily review" --permission-mode bypass-permissions \
  --client-token daily-review-session-2026-11-03

cloudcli session send --session-id SESSION_ID --message "Review today's changes" \
  --if-busy queue --client-token daily-review-message-2026-11-03
cloudcli session send --session-id SESSION_ID --message-file ./prompt.txt
cat ./prompt.txt | cloudcli session send --session-id SESSION_ID --stdin

cloudcli session message list --session-id SESSION_ID --max-items 20
cloudcli session submission show --session-id SESSION_ID --submission-id SUBMISSION_ID
cloudcli session submission wait --session-id SESSION_ID --submission-id SUBMISSION_ID --timeout-seconds 1800
cloudcli session submission cancel --session-id SESSION_ID --submission-id SUBMISSION_ID

cloudcli session archive --session-id SESSION_ID
cloudcli session restore --session-id SESSION_ID
cloudcli session delete --session-id SESSION_ID --permanent
```

Use the stable CloudCLI session ID. Provider-native IDs are returned as metadata and are not accepted as alternate identities. `--project-path` must be an existing absolute directory **on the server**; a message file is read **on the CLI machine**.

Creating a session does not run a model. Provider and project path are required. Model and permission mode default to the server's settings and the response reports the selected configuration. Permission values are `default`, `auto`, `accept-edits`, `bypass-permissions` and `plan`, subject to provider capabilities. Unsupported models and modes fail validation.

A send snapshots the current stored model and permission mode. UI runs also record their explicitly supplied permission mode for subsequent CLI sends. A browser-only selection that has not been sent is not yet server state. Queued submissions retain their captured settings.

## Submission lifecycle

A successful send returns a durable acknowledgement with `sessionId`, `submissionId`, `state` and `createdAt`. It means accepted, not that the model succeeded. The HTTP connection and CLI process may close without cancelling the submission.

Submissions have these states:

- `queued`: waiting for an available session.
- `running`: execution is active.
- `waiting-for-input`: a provider approval/question was surfaced; answer through the UI.
- `succeeded`, `failed`, `cancelled`, `interrupted`: terminal outcomes.

The dispatcher polls every second and admits up to eight CLI submissions concurrently across sessions. Each session runs one turn at a time. It waits for foreground work, background work, detected external CLI activity, and existing UI queued messages. CLI submissions run individually in insertion order; unlike the UI composer queue, they are not merged into one prompt. Pending CLI submissions are queried through this API; they do not appear as editable composer queue cards.

`--if-busy queue` is the default. `reject` refuses a busy session or one with pending messages. A queued message may still wait if another caller wins the runtime reservation before dispatch. Sending to an archived session fails until it is restored.

`submission show` returns the accepted content, captured options, state, final assistant messages and error. Final messages are capped at 1,000 messages or 4 MB, with an explicit `history_truncated` result when exceeded. Read provider history for the full transcript. A successful foreground turn can still leave provider background work running; later sends wait for it.

`submission wait` defaults to 1,800 seconds. Timeout and Ctrl-C stop the local wait only. `submission cancel` withdraws a queued submission or requests cancellation of its own active run; it never stops a newer run just because the session ID matches. Background work remaining after a successful submission is managed in the UI.

On server startup, formerly active submissions become `interrupted`; they are not automatically replayed because their tools may already have had effects. Queued submissions remain queued and resume dispatch. Inspect history before explicitly retrying interrupted work.

## Idempotency and deletion

Use `--client-token` for scheduled create/send operations that may be retried. Tokens contain 1–128 letters, digits, underscores, dots, colons or hyphens. A token is scoped to the authenticated user and operation. Repeating the same normalized input returns the original acknowledgement; different input returns `IDEMPOTENCY_CONFLICT`. A retry of send is not a status query: use `submission show` for the current state.

Receipts have no automatic expiration. Permanent deletion removes native provider artifacts, the application session, its submission content/results and permission settings. Receipt details are replaced with a minimal deleted-session marker and input fingerprint. Reusing that token returns HTTP 410 `RESOURCE_DELETED`, preventing accidental recreation. Database backups are outside session deletion.

Archive preserves native data and is reversible. Archive/delete refuse active work, pending CLI submissions, UI queued messages or pending scheduled messages. Cancel or resolve them first. Permanent deletion requires `--permanent` but does not prompt interactively. Provider deletion failures are errors, not successful hidden-list removals.

## Output and pagination

The default output is JSON for both terminals and scripts. `--output table` and `--output tsv` provide readable projections. `--query` uses JMESPath; for example:

```bash
cloudcli session list --query 'items[].{id:sessionId,title:title}' --output table
cloudcli session create --provider codex --project-path /absolute/server/project --query sessionId --output tsv
```

Single-resource commands return an object. Lists return `{ "items": [], "nextToken": null }`. The CLI automatically follows pages unless `--max-items` limits total output. Pass a returned `nextToken` as `--starting-token` with unchanged filters. Session lists sort by most recent activity; message lists follow the UI history's newest-page-first ordering. Pagination is a live view, not a snapshot: concurrent activity can move records between pages.

`--archive-state active|archived|all` defaults to `active`; `--execution-state running|idle` is optional. `--search` matches session titles. Filters run before pagination. `--query` is applied to the assembled output, not used as a server filter. Table/TSV output does not display pagination metadata; use JSON to retrieve continuation tokens.

Stdout contains only command results; stderr contains structured errors or requested diagnostics. `--debug` prints request methods and resource paths; `--only-show-errors` suppresses diagnostics. HTTP requests time out after 30 seconds, bounded further by the wait deadline. Mutating transport failures can have an unknown outcome; retry with the same client token.

| Exit code | Meaning |
| --- | --- |
| 0 | Command succeeded; send means accepted, show means query succeeded |
| 2 | Invalid arguments or rejected input |
| 3 | Resource missing or permanently deleted |
| 4 | Authentication/authorization failure |
| 5 | Conflict, busy session or cancellation not acknowledged |
| 6 | Configuration, transport or unexpected server/CLI error |
| 7 | Wait observed a failed, cancelled or interrupted submission |
| 8 | Wait deadline expired; submission continues |
| 130 | Local command interrupted with Ctrl-C |

Errors use `{ "error": { "code": "...", "message": "..." } }`. A successful `submission show` can return a failed submission with exit code 0; `submission wait` returns 0 only for `succeeded`.
