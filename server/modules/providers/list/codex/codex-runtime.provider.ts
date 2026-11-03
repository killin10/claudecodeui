import { codexAppServer, type CodexRpcConnection } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexRunEvents } from '@/modules/providers/list/codex/codex-events.provider.js';
import { codexPermissions, CodexRunPermissions } from '@/modules/providers/list/codex/codex-permissions.provider.js';
import { notifyBackgroundWorkCompleted, notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { createCompleteMessage } from '@/shared/utils.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const active = new Map<string, CodexRun>();
const MAX_RUN_MS = 4 * 60 * 60 * 1000;
// Native agents can deliver their answer in a new parent turn after becoming idle.
const BACKGROUND_DELIVERY_GRACE_MS = 5000;
/** One owned thread tree; kept alive through background work and its delivery turns. */
class CodexRun {
  connection?: CodexRpcConnection;
  readonly events: CodexRunEvents;
  lifetime?: Promise<void>;
  private reportedComplete = false;
  private generation = 0;
  private readonly output: ProviderRuntimeWriter;
  private permissions?: CodexRunPermissions;
  private threadId = '';
  private stopped = false;
  private mainComplete = false;
  private failure?: Error;
  private turnOptions?: AnyRecord;
  private awaitingPlan = false;
  private readonly subscribedChildren = new Set<string>();
  private reconciling = false;
  private childTerminalProbes = 0;
  private finish?: () => void;
  private settleTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: AnyRecord, private writer: ProviderRuntimeWriter, private context: ProviderRuntimeContext) {
    this.output = { send: message => this.writer.send(message), userId: writer.userId };
    this.events = new CodexRunEvents(this.output, context, () => this.sessionId, () => this.threadId);
  }

  get sessionId(): string {
    return this.options.sessionId || this.threadId;
  }

  async run(command: string): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let reconciliation: ReturnType<typeof setInterval> | undefined;
    try {
      const completed = new Promise<void>(resolve => {
        this.finish = resolve;
      });
      deadline = setTimeout(() => this.fail(new Error('Codex run exceeded its four-hour time limit')), MAX_RUN_MS);
      this.connection = await codexAppServer.connect();
      if (this.stopped) {
        return;
      }
      this.permissions = new CodexRunPermissions(this.connection, this.output, () => this.sessionId, this.options.permissionMode ?? 'default');
      this.connection.onClose(error => {
        if (!this.stopped) {
          this.fail(error);
        }
      });
      this.connection.onMessage(message => {
        try {
          if (message.method && message.id !== undefined) {
            this.permissions!.handle(message.id, message.method, message.params ?? {});
          } else if (message.method) {
            this.notification(message.method, message.params ?? {});
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const turn = await this.prepare(command);
      this.turnOptions = turn;
      if (this.stopped) {
        return;
      }
      if (this.failure) {
        throw this.failure;
      }
      reconciliation = setInterval(() => {
        void this.reconcileChildren();
      }, 2000);
      await this.connection.call('turn/start', turn);
      await completed;
      if (this.failure) {
        throw this.failure;
      }
      if (!this.stopped) {
        this.reportComplete();
        if (this.events.hadChildren) {
          notifyBackgroundWorkCompleted({ userId: this.writer.userId ?? null, provider: 'codex', sessionId: this.sessionId as AnyRecord['sessionId'], sessionName: this.options.sessionSummary });
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.events.emit({ kind: 'error', content: error instanceof Error ? error.message : String(error) });
        this.writer.send(createCompleteMessage({ provider: 'codex', sessionId: this.threadId || this.sessionId, exitCode: 1 }));
        notifyRunFailed({ userId: this.writer.userId ?? null, provider: 'codex', sessionId: this.sessionId as AnyRecord['sessionId'], sessionName: this.options.sessionSummary, error });
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(reconciliation);
      clearTimeout(this.settleTimer);
      this.permissions?.resolved();
      this.events.stopAll();
      this.stopped = true;
      await this.connection?.dispose();
      if (active.get(this.sessionId) === this) {
        active.delete(this.sessionId);
      }
    }
  }

  async abort(): Promise<void> {
    this.stopped = true;
    this.permissions?.resolved();
    try {
      await Promise.all([...this.events.activeTurns].map(([threadId, turnId]) => this.connection?.call('turn/interrupt', { threadId, turnId })));
    } catch (error) {
      console.warn('[Codex] Interrupt failed; closing the owned server:', error);
    } finally {
      this.connection?.close();
      this.finish?.();
    }
  }

  async stopTask(taskId: string): Promise<boolean> {
    if (!this.connection || !this.events.tasks.has(taskId)) {
      return false;
    }
    const terminal = this.events.terminals.get(taskId);
    if (terminal) {
      const result = await this.connection.call('thread/backgroundTerminals/terminate', terminal);
      if (!result.terminated) {
        return false;
      }
      this.events.finishTerminal(taskId, 'stopped');
      this.checkComplete();
      return true;
    }
    const turnId = this.events.activeTurns.get(taskId);
    if (!turnId) {
      // Metadata is local to this owned server; never resume an external thread to interrupt it.
      const result = await this.connection.call('thread/read', { threadId: taskId, includeTurns: true });
      const running = result.thread?.turns?.findLast((turn: AnyRecord) => turn.status === 'inProgress');
      if (!running?.id) {
        return false;
      }
      await this.connection.call('turn/interrupt', { threadId: taskId, turnId: running.id });
    } else {
      await this.connection.call('turn/interrupt', { threadId: taskId, turnId });
    }
    this.events.taskState(taskId, 'stopped');
    this.checkComplete();
    return true;
  }
  private async prepare(command: string): Promise<AnyRecord> {
    const { sessionId, model, effort, files, images } = this.options;
    const cwd = this.options.cwd || this.options.projectPath || process.cwd();
    const providerSessionId = this.context.resolveProviderSessionId(sessionId);
    const resolvedModel = await this.context.resolveResumeModel(sessionId, model);
    const mode = this.options.permissionMode ?? 'default';
    const sandbox = mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
    const approvalPolicy = mode === 'bypassPermissions' ? 'never' : 'on-request';
    const approvalsReviewer = mode === 'auto' ? 'auto_review' : 'user';
    const catalog = await this.context.getProviderModels();
    const selectedModel = resolvedModel || catalog.DEFAULT;
    const allowedEfforts = catalog.OPTIONS.find(option => option.value === selectedModel)?.effort?.values.map(value => value.value) ?? [];
    const resolvedEffort = allowedEfforts.includes(effort) ? effort : null;
    const result = await this.connection!.call(providerSessionId ? 'thread/resume' : 'thread/start', {
      ...(providerSessionId ? { threadId: providerSessionId, excludeTurns: true } : {}),
      model: selectedModel, cwd, sandbox, approvalPolicy, approvalsReviewer,
    });
    if (!result.thread?.id) {
      throw new Error('Codex returned no thread id');
    }
    this.threadId = result.thread.id;
    active.set(this.sessionId, this);
    this.writer.setSessionId?.(this.threadId);
    if (!providerSessionId) {
      this.events.emit({ kind: 'session_created', sessionId: this.threadId, newSessionId: this.threadId });
    }
    const normalizedImages = normalizeImageDescriptors(images);
    const text = appendFilesInputTag(command, files) || (normalizedImages.length ? 'Please analyze the attached image(s).' : command);
    const input = buildCodexInputItems(text.trim() ? text : 'Please analyze the attached image(s).', normalizedImages, cwd)
      .map(item => item.type === 'text' ? { ...item, text_elements: [] } : { ...item, type: 'localImage' });
    // Resume of an already-loaded thread retains its old settings. Apply the
    // requested policy at turn/start as well, including when tightening access.
    const sandboxPolicy = mode === 'bypassPermissions'
      ? { type: 'dangerFullAccess' }
      : result.sandbox?.type === 'workspaceWrite'
        ? result.sandbox
        : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    return {
      threadId: this.threadId, input, model: selectedModel, effort: resolvedEffort,
      approvalPolicy, approvalsReviewer, sandboxPolicy,
      collaborationMode: { mode: mode === 'plan' ? 'plan' : 'default', settings: { model: selectedModel, reasoning_effort: resolvedEffort, developer_instructions: null } },
    };
  }

  private notification(method: string, params: AnyRecord): void {
    if (method === 'serverRequest/resolved') {
      this.permissions?.resolved(params.requestId);
    }
    this.events.handle(method, params);
    if (method === 'turn/started' && params.threadId === this.threadId) {
      this.mainComplete = false;
      this.generation++;
    }
    if (method === 'turn/completed') {
      this.permissions?.resolved(undefined, params.threadId);
      if (params.threadId !== this.threadId && this.events.taskCards.has(params.threadId)) {
        void this.refreshFinishedChild(params.threadId);
      }
      if (params.threadId === this.threadId) {
        if (params.turn.status === 'completed') {
          void this.completeTurn(this.generation).catch(error => this.fail(error));
        } else {
          this.fail(new Error(params.turn.error?.message ?? `Codex turn ${params.turn.status}`));
        }
      }
    }
    if (method === 'error' && !params.willRetry && (!params.threadId || params.threadId === this.threadId)) {
      this.fail(new Error(params.error?.message ?? 'Codex error'));
    }
    this.checkComplete();
  }
  private async reconcileChildren(): Promise<void> {
    if (this.reconciling || this.stopped || !this.connection) {
      return;
    }
    this.reconciling = true;
    try {
      for (const [threadId, task] of [...this.events.tasks]) {
        if (task.taskType !== 'agent') {
          continue;
        }
        if (this.stopped) {
          break;
        }
        const subscribe = !this.subscribedChildren.has(threadId);
        const result = await this.connection.call(subscribe ? 'thread/resume' : 'thread/read', {
          threadId, ...(subscribe ? { excludeTurns: true } : { includeTurns: false }),
        });
        this.subscribedChildren.add(threadId);
        const status = result.thread?.status?.type;
        if (status === 'idle') {
          this.events.taskState(threadId, 'completed');
        }
        if (status === 'systemError') {
          this.events.taskState(threadId, 'failed');
        }
      }
      await this.refreshAllTerminals();
      this.checkComplete();
    } catch (error) {
      if (!this.stopped) {
        console.warn('[Codex] Child reconciliation failed:', error);
      }
    } finally {
      this.reconciling = false;
    }
  }

  canContinue(nativeId: string | null): boolean {
    return this.mainComplete && !this.awaitingPlan && !this.stopped && !this.failure && nativeId === this.threadId;
  }

  async continueRun(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    this.mainComplete = false;
    this.generation++;
    this.reportedComplete = false;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.options = options;
    this.writer = writer;
    this.context = context;
    this.permissions = new CodexRunPermissions(this.connection!, this.output, () => this.sessionId, options.permissionMode ?? 'default');
    try {
      this.turnOptions = await this.prepare(command);
      await this.connection!.call('turn/start', this.turnOptions);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    await this.lifetime;
  }
  private async completeTurn(generation: number): Promise<void> {
    await this.refreshAllTerminals();
    if (generation !== this.generation || this.stopped) {
      return;
    }
    this.mainComplete = true;
    this.offerPlan();
    if (!this.awaitingPlan) {
      this.reportComplete();
    }
    this.checkComplete();
  }

  private reportComplete(): void {
    if (this.reportedComplete) {
      return;
    }
    this.reportedComplete = true;
    this.writer.send(createCompleteMessage({ provider: 'codex', sessionId: this.threadId, actualSessionId: this.threadId, exitCode: 0 }));
    notifyRunStopped({ userId: this.writer.userId ?? null, provider: 'codex', sessionId: this.sessionId as AnyRecord['sessionId'], sessionName: this.options.sessionSummary, stopReason: 'completed' });
  }
  private async refreshFinishedChild(threadId: string): Promise<void> {
    this.childTerminalProbes++;
    try {
      await this.refreshTerminals(threadId);
    } catch (error) {
      if (!this.stopped) {
        console.warn('[Codex] Finished child terminal lookup unavailable:', error);
      }
    } finally {
      this.childTerminalProbes--;
      this.checkComplete();
    }
  }
  private async refreshAllTerminals(): Promise<void> {
    const owners = new Set([this.threadId, ...this.events.terminals.values()].map(value => typeof value === 'string' ? value : value.threadId));
    for (const [id, task] of this.events.tasks) {
      if (task.taskType === 'agent') {
        owners.add(id);
      }
    }
    for (const id of owners) {
      await this.refreshTerminals(id);
    }
  }
  private async refreshTerminals(threadId: string): Promise<void> {
    const terminals: AnyRecord[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const result = await this.connection!.call('thread/backgroundTerminals/list', { threadId, cursor, limit: 100 });
      if (!Array.isArray(result?.data)) {
        throw new Error('Invalid Codex background terminal list');
      }
      terminals.push(...result.data);
      cursor = result.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) {
        throw new Error('Codex terminal pagination did not terminate');
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor);
    this.events.setTerminals(threadId, terminals);
  }

  private offerPlan(): void {
    if (this.turnOptions?.collaborationMode.mode !== 'plan' || !this.events.proposedPlan || this.awaitingPlan) {
      return;
    }
    this.awaitingPlan = true;
    this.permissions!.proposePlan(this.events.proposedPlan, decision => {
      this.awaitingPlan = false;
      this.mainComplete = false;
      this.events.proposedPlan = undefined;
      const previous = this.turnOptions!;
      this.turnOptions = {
        ...previous,
        input: [{ type: 'text', text: decision.allow ? 'Implement the plan.' : decision.message || 'Please revise the plan.', text_elements: [] }],
        collaborationMode: { ...previous.collaborationMode, mode: decision.allow ? 'default' : 'plan' },
      };
      void this.connection!.call('turn/start', this.turnOptions).catch(error => this.fail(error));
    });
  }

  private checkComplete(): void {
    if (!this.mainComplete || this.events.tasks.size || this.failure || this.awaitingPlan || this.childTerminalProbes > 0) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
      return;
    }
    if (this.settleTimer) {
      return;
    }
    this.settleTimer = setTimeout(() => this.finish?.(), this.events.hadChildren ? BACKGROUND_DELIVERY_GRACE_MS : 0);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.finish?.();
  }
}
/** Codex provider's main runtime and replayable approval/background-work gateways. */
export const codexRuntime = {
  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const previous = active.get(options.sessionId);
    if (previous?.canContinue(context.resolveProviderSessionId(options.sessionId))) {
      await previous.continueRun(command, options, writer, context);
      return;
    }
    if (previous) {
      await previous.abort();
      await previous.lifetime;
    }
    const run = new CodexRun(options, writer, context);
    if (options.sessionId) {
      active.set(options.sessionId, run);
    }
    run.lifetime = run.run(command);
    await run.lifetime;
  },
  async abort(sessionId: string): Promise<boolean> {
    const run = active.get(sessionId);
    if (!run) {
      return false;
    }
    await run.abort();
    return true;
  },
  permissions: codexPermissions,
  listBackgroundWork() {
    return [...active].filter(([, run]) => run.events.tasks.size > 0).map(([sessionId, run]) => ({ sessionId, tasks: [...run.events.tasks.values()] }));
  },
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
    return await active.get(sessionId)?.stopTask(taskId) ?? false;
  },
};
