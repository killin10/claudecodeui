# Built-in scheduled tasks

CloudCLI stores and schedules prompts on the server. The browser can be closed. Each task targets an existing CloudCLI session; creating a fresh session per execution is not supported.

Open **Scheduled tasks** in the sidebar, or **Create scheduled task** in a session's options. Choose a session, prompt, timing and time zone. Tasks can be edited, paused, resumed, run immediately or deleted. Execution history links to the session and shows the actual submission state and result.

## Timing and execution

Use a five-field numeric cron expression (`minute hour day-of-month month day-of-week`) or a one-time ISO timestamp with an explicit UTC offset. Cron supports `*`, lists, ranges and steps. Sunday is `0` or `7`. Seconds, named months/weekdays, macros and randomized extensions are rejected. When both day-of-month and day-of-week are restricted, either match triggers the task.

For example, `0 9 * * 1-5` with `Asia/Shanghai` runs on weekdays at 09:00 in Shanghai. The preview uses the same parser and time zone as the scheduler and shows the next five instants. DST calculation follows the pinned `cron-parser` version; inspect the preview for local times near DST transitions. One-time timestamps already encode their offset; the time zone controls their display, not a reinterpretation of the timestamp.

The server polls every five seconds and handles up to 100 due tasks per pass. An occurrence less than 60 seconds late can still run. Older occurrences use the saved policy:

- `skip` (default): record one skipped interval and advance to the next future occurrence.
- `latest`: submit only the most recent due occurrence, without replaying every missed interval.

These policies also apply to one-time tasks. One-time tasks automatically stop scheduling after their due occurrence is handled. Resume computes a new future occurrence; a past one-time task needs a new execution time before it can resume. Run now is available even while a task is paused and does not change its next scheduled time.

Busy sessions queue submissions without interrupting their active work. If the same task already has a queued, running or waiting-for-input submission, the next scheduled occurrence is recorded as skipped. Manual execution instead returns `SCHEDULE_BUSY`. Background provider work can keep a queued submission waiting.

Model and permission overrides apply to the task's submissions without changing the session settings. Otherwise each trigger captures the session's saved settings at enqueue time. An open UI selector that has not yet been saved is not a session setting. Approvals and questions appear in the target session and the execution becomes `waiting-for-input`.

## CLI

The CLI uses the same API and authentication configuration as `cloudcli session`. All business values are named options. Run `cloudcli schedule --help` or add `--help` to a command for its supported options.

```bash
cloudcli schedule create \
  --name 'Weekday review' \
  --session-id SESSION_ID \
  --cron '0 9 * * 1-5' \
  --timezone Asia/Shanghai \
  --message 'Review the current project and report findings.' \
  --client-token CREATE_TOKEN

cloudcli schedule list
cloudcli schedule show --schedule-id SCHEDULE_ID
cloudcli schedule preview --cron '0 9 * * 1-5' --timezone Asia/Shanghai
cloudcli schedule update --schedule-id SCHEDULE_ID --revision REVISION --message-file ./prompt.txt
cloudcli schedule pause --schedule-id SCHEDULE_ID
cloudcli schedule resume --schedule-id SCHEDULE_ID
cloudcli schedule run --schedule-id SCHEDULE_ID --client-token RUN_TOKEN
cloudcli schedule run list --schedule-id SCHEDULE_ID
cloudcli schedule run show --schedule-id SCHEDULE_ID --run-id RUN_ID
cloudcli schedule run cancel --schedule-id SCHEDULE_ID --run-id RUN_ID
cloudcli schedule delete --schedule-id SCHEDULE_ID
```

Use `--run-at '2030-01-01T09:00:00+08:00'` instead of `--cron` for a one-time task. Create accepts `--paused`. Create and update accept exactly one message source when supplied: `--message`, `--message-file`, or `--stdin`; creation requires one. Update requires the `revision` returned by show. Concurrent edits, archival or triggers can change this revision, so reload before retrying a conflict. A task's target session is immutable; create another task to change its target.

Optional `--model` and `--permission-mode` override session settings. Update accepts `--inherit-model` and `--inherit-permission-mode` to clear the respective override. An explicit value and its inherit flag are mutually exclusive. `--misfire-policy` accepts `skip` or `latest`.

Use a distinct `--client-token` for each create or manual trigger, and reuse it when retrying an uncertain request. Retrying with different input returns a conflict. Deleting the task or session prevents those receipts from recreating it. A successful `schedule run` command only acknowledges enqueue; inspect `run show` for the actual result. JSON, table, TSV, JMESPath queries and cursor pagination behave like the session CLI.

## Lifecycle and recovery

Pausing or deleting a task stops future triggers. It does not cancel an existing submission; use the execution's cancel action separately. Editing affects future submissions only. Editing a prompt or name preserves the next scheduled time; changing timing or time zone recomputes it.

Archiving a session pauses its tasks through a database trigger, including archival from other UI/API paths. Restoring a session does not resume its tasks automatically. Permanently deleting a session removes its tasks, executions and submission contents. Idempotency receipts are redacted by the existing session deletion trigger; backups are outside that cleanup.

Deleting just a task retains its execution history. It disappears from the active task list; history remains accessible by its schedule ID through the CLI/API. Tasks and run history are not automatically pruned in this version.

Pending submissions survive restart. Executions that were active during a service restart become `interrupted`, following the session queue's existing recovery behavior. They are not automatically replayed because tool side effects may already have happened. Review the session before running the task again.

## Persistence and API

The existing application SQLite database contains `schedules` and `schedule_runs`. Each scheduled occurrence is unique by task and scheduled UTC instant. Advancing the task, inserting the execution and enqueueing its submission share one transaction. A persistence failure rolls the transaction back. A rejected enqueue records a failed execution and advances the schedule. This prevents duplicate enqueue on repeated scans; it does not promise exactly-once external tool side effects.

The browser uses JWT-authenticated `/api/schedules`. The CLI uses API-key-authenticated `/api/session-control/v1/schedules`. Both expose the same resources: list/create, preview, show/update/delete, pause/resume/run, and execution list/show/cancel. Schedule configuration and run history are scoped to the authenticated user. Target session visibility follows the application's shared workspace model.

Only one CloudCLI service process should execute a database's submission queue. Task transactions protect duplicate scans, but this is not a distributed worker or leader-election system.

The feature is additive. Existing composer one-time scheduled messages keep their previous behavior, including interrupting an active session at their chosen time. They are managed separately and can therefore interrupt a run started by this scheduler too.

To stop future scheduling without deleting data, pause the tasks before rolling back. Already queued submissions belong to the existing session queue and must be cancelled separately if they should not run. Back up the application database before a deployment; an older release does not poll these new task tables.
