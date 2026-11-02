import type { OpenCodeClient, SessionMessageInfo, SessionShellStarted, SessionShellEnded } from '@opencode/client';

import type { AnyRecord, BackgroundTaskSummary } from '@/shared/types.js';

/** Runtime-owned task registry. Native delivery, rather than a quiet timer, releases detached work. */
export class OpenCodeBackgroundWork {
  readonly tasks = new Map<string, BackgroundTaskSummary>();
  private readonly endedSessions = new Set<string>();
  private readonly detached = new Set<string>();
  private readonly deliveredCalls = new Set<string>();
  private readonly deliveredBeforeSnapshot = new Set<string>();
  private readonly followups = new Set<string>();
  private readonly nativeShells = new Set<string>();

  trackNativeShell(event: SessionShellStarted | SessionShellEnded, nested: boolean): void {
    const shell = event.data.shell;
    if (event.type === 'session.shell.ended') {
      if (this.nativeShells.delete(shell.id)) this.tasks.delete(shell.id);
      return;
    }
    if (shell.metadata.background !== true || this.tasks.has(shell.id)) return;
    this.nativeShells.add(shell.id);
    this.tasks.set(shell.id, {
      taskId: shell.id, toolUseId: shell.id, taskType: 'shell', description: shell.command,
      startedAt: event.created, ...(nested ? { nested: true } : {}),
    });
  }

  track(message: SessionMessageInfo, nested: boolean): void {
    if (message.type !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool') continue;
      const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
      const shell = part.name === 'shell';
      if (!shell && part.name !== 'subagent' && part.name !== 'task') continue;
      const id = shell ? metadata?.shellID : metadata?.sessionID;
      if (typeof id !== 'string' || metadata?.status !== 'running') continue;
      if (this.wasDelivered(id, part.id)) continue;
      const input = part.state.input as AnyRecord;
      const background = input?.background === true || part.state.status === 'completed';
      if (!background && this.endedSessions.has(id)) continue;
      if (background) this.detached.add(id);
      this.tasks.set(id, {
        taskId: id, toolUseId: part.id, taskType: shell ? 'shell' : 'subagent',
        description: String(input?.description ?? input?.command ?? 'OpenCode subagent'),
        startedAt: message.time.created, ...(nested ? { nested: true } : {}),
      });
    }
  }

  private wasDelivered(id: string, toolUseId: string): boolean {
    if (this.deliveredBeforeSnapshot.delete(id)) this.deliveredCalls.add(toolUseId);
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

  notificationDelivered(sessionID: string, metadata: AnyRecord | undefined): void {
    const id = metadata?.source === 'shell' ? metadata.shellID
      : metadata?.source === 'subagent' ? metadata.childID : undefined;
    if (typeof id !== 'string') return;
    // Delivery happens during an execution. Its terminal event must drain before
    // the server can close, even if the tool snapshot arrived after notification.
    const toolUseId = this.tasks.get(id)?.toolUseId;
    if (toolUseId) this.deliveredCalls.add(toolUseId);
    else this.deliveredBeforeSnapshot.add(id);
    this.detached.delete(id);
    this.tasks.delete(id);
    this.followups.add(sessionID);
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
