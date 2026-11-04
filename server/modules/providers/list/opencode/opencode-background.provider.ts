import type Database from 'better-sqlite3';
import type { OpenCodeClient, SessionMessageInfo, SessionShellStarted, SessionShellEnded } from '@opencode/client';

import type { AnyRecord, BackgroundTaskSummary } from '@/shared/types.js';

import { readOpenCodeCompletion, readOpenCodeDelivery, readOpenCodeExecution, readOpenCodeShellDelivery } from './opencode-completion.provider.js';

/** Runtime-owned task registry. Native delivery, rather than a quiet timer, releases detached work. */
export class OpenCodeBackgroundWork {
  readonly tasks = new Map<string, BackgroundTaskSummary>();
  private readonly endedSessions = new Set<string>();
  private readonly detached = new Set<string>();
  private readonly deliveredCalls = new Set<string>();
  private readonly deliveredBeforeSnapshot = new Map<string, number>();
  private readonly followups = new Map<string, number>();
  private readonly nativeShells = new Set<string>();
  private readonly shellOwners = new Map<string, string>();

  trackNativeShell(event: SessionShellStarted | SessionShellEnded, nested: boolean): void {
    const shell = event.data.shell;
    if (event.type === 'session.shell.ended') {
      if (this.nativeShells.delete(shell.id)) this.tasks.delete(shell.id);
      return;
    }
    if (shell.metadata.background !== true || this.tasks.has(shell.id)) return;
    if (this.wasDelivered(shell.id, shell.id, event.created)) return;
    this.shellOwners.set(shell.id, event.data.sessionID);
    this.nativeShells.add(shell.id);
    this.tasks.set(shell.id, {
      taskId: shell.id, toolUseId: shell.id, taskType: 'shell', description: shell.command,
      startedAt: event.created, ...(nested ? { nested: true } : {}),
    });
  }

  track(message: SessionMessageInfo, nested: boolean, sessionId: string): void {
    if (message.type !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool') continue;
      const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
      const shell = part.name === 'shell';
      if (!shell && part.name !== 'subagent' && part.name !== 'task') continue;
      const id = shell ? metadata?.shellID : metadata?.sessionID;
      if (typeof id !== 'string' || metadata?.status !== 'running') continue;
      const startedAt = part.time?.created ?? message.time.created;
      if (this.wasDelivered(id, part.id, startedAt)) continue;
      const existing = this.tasks.get(id);
      if (existing && existing.startedAt > startedAt) continue;
      const input = part.state.input as AnyRecord;
      const background = input?.background === true || part.state.status === 'completed';
      if (!background && this.endedSessions.has(id)) continue;
      if (this.tasks.get(id)?.toolUseId !== part.id) this.endedSessions.delete(id);
      if (background) this.detached.add(id);
      if (shell) this.shellOwners.set(id, sessionId);
      this.tasks.set(id, {
        taskId: id, toolUseId: part.id, taskType: shell ? 'shell' : 'subagent',
        description: String(input?.description ?? input?.command ?? 'OpenCode subagent'),
        startedAt, ...(nested ? { nested: true } : {}),
      });
    }
  }

  private wasDelivered(id: string, toolUseId: string, startedAt: number): boolean {
    const deliveredAt = this.deliveredBeforeSnapshot.get(id);
    if (deliveredAt !== undefined && deliveredAt >= startedAt) this.deliveredCalls.add(toolUseId);
    // Remember calls, not child sessions: a subsequent call may resume a child.
    return this.deliveredCalls.has(toolUseId);
  }

  executionStarted(sessionID: string): void {
    this.endedSessions.delete(sessionID);
  }

  executionEnded(sessionID: string): void {
    this.endedSessions.add(sessionID);
    this.followups.delete(sessionID);
    if (!this.detached.has(sessionID)) this.tasks.delete(sessionID);
  }

  notificationDelivered(sessionID: string, metadata: AnyRecord | undefined, deliveredAt = Date.now()): void {
    const id = metadata?.source === 'shell' ? metadata.shellID
      : metadata?.source === 'subagent' ? metadata.childID : undefined;
    if (typeof id !== 'string') return;
    const task = this.tasks.get(id);
    if (task && deliveredAt < task.startedAt) return;
    // Delivery happens during an execution. Its terminal event must drain before
    // the server can close, even if the tool snapshot arrived after notification.
    const toolUseId = this.tasks.get(id)?.toolUseId;
    if (toolUseId) this.deliveredCalls.add(toolUseId);
    // A native shell entry initially uses the shell ID as its tool ID. Its later
    // model snapshot has a different call ID, so remember delivery by shell too.
    if (!toolUseId || metadata?.source === 'shell') {
      this.deliveredBeforeSnapshot.set(id, Math.max(deliveredAt, this.deliveredBeforeSnapshot.get(id) ?? 0));
    }
    this.nativeShells.delete(id);
    this.detached.delete(id);
    this.tasks.delete(id);
    this.followups.set(sessionID, Math.max(deliveredAt, this.followups.get(sessionID) ?? 0));
  }

  /** Retain delivery waiters without advertising their execution as running. */
  get runningTasks(): BackgroundTaskSummary[] {
    return Array.from(this.tasks.values()).filter((task) => !this.endedSessions.has(task.taskId));
  }

  /** Called by the runtime poller with a single consistent, read-only DB snapshot. */
  reconcile(db: Database.Database): boolean {
    // Gather all evidence before touching memory: a failed query must not leave
    // a partially reconciled registry (a SQLite rollback cannot undo JS maps).
    const snapshots = Array.from(this.tasks.values())
      .filter((task) => task.taskType === 'subagent' || task.taskType === 'shell')
      .map((task) => this.readSnapshot(db, task));
    const followups = new Map(this.followups);
    for (const { completion, delivery } of snapshots) {
      if (completion && completion.status !== 'running' && delivery) {
        followups.set(delivery.parentId, Math.max(delivery.at, followups.get(delivery.parentId) ?? 0));
      }
    }
    const settledParents = Array.from(followups)
      .filter(([sessionId, deliveredAt]) => readOpenCodeCompletion(db, sessionId, deliveredAt));
    let changed = false;
    for (const { task, completion, delivery } of snapshots) {
      if (!completion) continue;
      if (completion.status === 'running') {
        changed = this.endedSessions.delete(task.taskId) || changed;
        continue;
      }
      changed = !this.endedSessions.has(task.taskId) || changed;
      this.executionEnded(task.taskId);
      if (delivery) {
        const metadata = task.taskType === 'shell'
          ? { source: 'shell', shellID: task.taskId }
          : { source: 'subagent', childID: task.taskId };
        this.notificationDelivered(delivery.parentId, metadata, delivery.at);
        changed = true;
      }
    }
    for (const [sessionId] of settledParents) {
      this.executionEnded(sessionId);
      changed = true;
    }
    return changed;
  }

  private readSnapshot(db: Database.Database, task: BackgroundTaskSummary) {
    if (task.taskType === 'shell') {
      const owner = this.shellOwners.get(task.taskId);
      const delivery = owner ? readOpenCodeShellDelivery(db, owner, task.taskId, task.startedAt) : undefined;
      return {
        task, delivery,
        completion: delivery ? { status: 'completed' as const, at: delivery.at } : undefined,
      };
    }
    return {
      task,
      completion: readOpenCodeExecution(db, task.taskId, task.startedAt),
      delivery: readOpenCodeDelivery(db, task.taskId, task.startedAt),
    };
  }

  get pending(): boolean {
    return this.tasks.size > 0 || this.followups.size > 0;
  }

  async stop(client: OpenCodeClient, taskId: string, directory: string, signal: AbortSignal): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.taskType === 'shell') {
      await client.shell.remove({ id: taskId, location: { directory } }, { signal });
    } else {
      await client.session.interrupt({ sessionID: taskId }, { signal });
    }
    return true;
  }
}
