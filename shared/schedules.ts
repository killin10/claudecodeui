/** HTTP contract shared by the schedules API, UI and database; all instants are UTC ISO strings. */
export type ScheduleDefinition = {
  name: string;
  sessionId: string;
  message: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  misfirePolicy: 'skip' | 'latest';
  model: string | null;
  permissionMode: string | null;
};
/** Persistent task configuration. Revision protects edits from stale clients. */
export type Schedule = ScheduleDefinition & {
  scheduleId: string;
  userId: number;
  enabled: boolean;
  deleted: boolean;
  revision: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  sessionTitle?: string | null;
  projectPath?: string | null;
  provider?: string;
  lastState?: string | null;
};
/** A trigger and its linked submission; status is read from the submission when present. */
export type ScheduleRun = {
  runId: string;
  scheduleId: string;
  sessionId: string;
  scheduledFor: string;
  source: 'scheduled' | 'manual';
  state: string;
  reason: string | null;
  submissionId: string | null;
  createdAt: string;
  snapshot: ScheduleDefinition;
};
