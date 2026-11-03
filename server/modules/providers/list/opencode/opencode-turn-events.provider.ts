import path from 'node:path';

import Database from 'better-sqlite3';
import type { OpenCodeClient, OpenCodeEvent, SessionMessageInfo, JsonValue } from '@opencode/client';

import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { getOpenCodeDatabasePath, isOpenCodeNotFoundError, readOpenCodeErrorMessage } from '@/shared/utils.js';

import { OpenCodeEventProjector } from './opencode-events.provider.js';
import type { OpenCodeBackgroundWork } from './opencode-background.provider.js';
import { settleOpenCodePermission, type OpenCodePermissionGateway } from './opencode-permissions.provider.js';

function findShellMessageId(sessionId: string, shellId: string): string {
  const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT id FROM session_message WHERE session_id = ? AND type = 'shell' AND json_extract(data, '$.shellID') = ?")
      .get(sessionId, shellId) as { id: string } | undefined;
    if (!row) throw new Error(`OpenCode shell message not found: ${shellId}`);
    return row.id;
  } finally {
    db.close();
  }
}

/** Runtime delegates native event ownership, ordered snapshot reads and child projection to this router. */
export class OpenCodeTurnEvents {
  private readonly shellMessageIds = new Map<string, string>();
  private readonly ownedSessions = new Set<string>();
  private messageQueue = Promise.resolve();
  private sawBusy = false;
  private readonly rootToolMessages = new Set<string>();
  private readonly settledChildren = new Set<string>();
  private readonly childToolIds = new Map<string, string>();
  private readonly childProjectors = new Map<string, OpenCodeEventProjector>();
  private readonly toolProgress = new Map<string, Record<string, JsonValue>>();
  private readonly projector: OpenCodeEventProjector;

  constructor(private readonly host: {
    client: OpenCodeClient | null;
    providerSessionId: string | null;
    abortController: AbortController;
    aborted: boolean;
    work: OpenCodeBackgroundWork;
  }, private readonly context: {
    directory: string;
    gateway: OpenCodePermissionGateway;
    sessionId(): string;
    normalize: ProviderRuntimeContext['normalizeMessage'];
    send: ProviderRuntimeWriter['send'];
    finished(): boolean;
    fail(message: string): void;
    foregroundBusy(): void;
    foregroundFinished(): void;
    settleBackground(): void;
    sendTokenUsage(): void;
  }) {
    this.projector = new OpenCodeEventProjector(context.sessionId, context.send, context.normalize);
    if (host.providerSessionId) this.register(host.providerSessionId);
  }

  register(sessionId: string): void { this.ownedSessions.add(sessionId); }

  flush(): Promise<void> { return this.messageQueue; }

  /** Runtime reconciliation republishes cards after correcting missed terminal events. */
  async refreshBackgroundCards(): Promise<void> {
    for (const messageID of this.rootToolMessages) this.forwardMessage(messageID);
    await this.messageQueue;
  }

  // A resumed child emits no session.created event. Verify its ancestry before
  // routing requests; never accept an unrelated session just because it shares a server.
  private ownsSession = async (sessionID: string): Promise<boolean> => {
    const ancestors = new Set<string>();
    let current: string | undefined = sessionID;
    while (current && !this.ownedSessions.has(current)) {
      if (ancestors.has(current)) return false;
      ancestors.add(current);
      try {
        const session = await this.host.client!.session.get({ sessionID: current }, {
          signal: AbortSignal.any([this.host.abortController.signal, AbortSignal.timeout(5000)]),
        });
        current = session.parentID;
      } catch (error) {
        if (isOpenCodeNotFoundError(error)) return false;
        throw error;
      }
    }
    if (!current) return false;
    for (const ancestor of ancestors) this.ownedSessions.add(ancestor);
    return true;
  };

  private applyToolProgress = (message: SessionMessageInfo) => {
    if (message.type !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool') continue;
      const key = `${message.id}:${part.id}`;
      if (part.state.status === 'running') {
        part.state.metadata = { ...part.state.metadata, ...this.toolProgress.get(key) };
      } else {
        this.toolProgress.delete(key);
      }
    }
  };

  private trackSpawnedChildren = (message: SessionMessageInfo, messageID: string, nativeSessionId: string) => {
    if (message.type !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool' || (part.name !== 'subagent' && part.name !== 'task')) continue;
      if (nativeSessionId === this.host.providerSessionId) this.rootToolMessages.add(messageID);
      const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
      const childID = metadata?.sessionID;
      if (metadata?.status !== 'running' || typeof childID !== 'string' || this.settledChildren.has(childID)) continue;
      this.ownedSessions.add(childID);
      this.childToolIds.set(childID, part.id);
    }
  };

  // Serialize message reads so text, tools and the final completion stay ordered.
  private forwardMessage = (
    messageID: string,
    progress?: { id: string; metadata: Record<string, JsonValue> },
    nativeSessionId = this.host.providerSessionId!,
    parentToolUseId?: string,
  ) => {
    if (progress) {
      const key = `${messageID}:${progress.id}`;
      this.toolProgress.set(key, { ...this.toolProgress.get(key), ...progress.metadata });
    }
    this.messageQueue = this.messageQueue.then(async () => {
      const message = await this.host.client!.session.message.get({
        sessionID: nativeSessionId, messageID,
      }, { signal: this.host.abortController.signal });
      this.applyToolProgress(message);
      this.trackSpawnedChildren(message, messageID, nativeSessionId);
      this.host.work.track(message, nativeSessionId !== this.host.providerSessionId);
      for (const normalized of this.context.normalize({ type: 'session.message', message }, this.context.sessionId())) {
        this.projector.publish(parentToolUseId ? { ...normalized, parentToolUseId } : normalized);
      }
    }).catch((error) => {
      if (!this.host.aborted) this.context.fail(`Cannot read OpenCode message: ${readOpenCodeErrorMessage(error)}`);
    });
  };

  private forwardShell = (event: Extract<OpenCodeEvent, { type: 'session.shell.started' | 'session.shell.ended' }>, parentToolUseId?: string) => {
    const { shell, sessionID } = event.data;
    const key = `${sessionID}:${shell.id}`;
    const messageId = event.type === 'session.shell.started'
      ? event.id.replace(/^evt_/, 'msg_')
      : this.shellMessageIds.get(key) ?? findShellMessageId(sessionID, shell.id);
    this.shellMessageIds.set(key, messageId);
    this.host.work.trackNativeShell(event, Boolean(parentToolUseId));
    this.forwardMessage(messageId, undefined, sessionID, parentToolUseId);
    if (event.type === 'session.shell.ended') void this.messageQueue.then(this.context.settleBackground);
  };

  private handleChildEvent = async (event: OpenCodeEvent) => {
    const data = event.data as AnyRecord;
    await this.messageQueue;
    const parentToolUseId = this.childToolIds.get(data.sessionID);
    if (parentToolUseId) {
      let childProjector = this.childProjectors.get(data.sessionID);
      if (!childProjector) {
        childProjector = new OpenCodeEventProjector(this.context.sessionId, (message) => this.context.send({ ...message, parentToolUseId }), this.context.normalize);
        this.childProjectors.set(data.sessionID, childProjector);
      }
      if (childProjector.handle(event)) return;
      switch (event.type) {
        case 'session.shell.started':
        case 'session.shell.ended':
          this.forwardShell(event, parentToolUseId);
          break;
        case 'session.text.ended':
        case 'session.reasoning.ended':
        case 'session.tool.called':
        case 'session.tool.success':
        case 'session.tool.failed':
          this.forwardMessage(event.data.assistantMessageID, undefined, data.sessionID, parentToolUseId);
          break;
        case 'session.tool.progress':
          this.forwardMessage(event.data.assistantMessageID, event.data, data.sessionID, parentToolUseId);
          break;
      }
    }
    if (event.type === 'session.execution.started') {
      this.settledChildren.delete(data.sessionID);
      this.host.work.executionStarted(data.sessionID);
      const child = await this.host.client!.session.get({ sessionID: data.sessionID }, { signal: this.host.abortController.signal });
      if (!this.host.work.tasks.has(data.sessionID)) this.host.work.tasks.set(data.sessionID, {
        taskId: data.sessionID, toolUseId: data.sessionID, taskType: 'subagent',
        description: child.title || 'OpenCode subagent', startedAt: event.created, nested: true,
      });
    }
    if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
      this.settledChildren.add(data.sessionID);
      this.host.work.executionEnded(data.sessionID);
      this.context.settleBackground();
    }
    for (const messageID of this.rootToolMessages) this.forwardMessage(messageID);
    return;
  };

  private handleRootEvent = async (event: OpenCodeEvent) => {
    const data = event.data as AnyRecord;
    switch (event.type) {
      case 'session.shell.started':
      case 'session.shell.ended':
        this.forwardShell(event);
        return;
      case 'permission.replied':
        settleOpenCodePermission(event.data.requestID);
        return;
      case 'session.tool.progress':
        this.forwardMessage(event.data.assistantMessageID, event.data);
        return;
      case 'session.text.ended':
      case 'session.reasoning.ended':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.step.ended':
        if (data.sessionID === this.host.providerSessionId) this.forwardMessage(event.data.assistantMessageID);
        return;
      case 'session.execution.failed':
        if (data.sessionID === this.host.providerSessionId) this.context.fail(event.data.error.message);
        return;
      case 'session.execution.started':
        this.sawBusy = true;
        this.context.foregroundBusy();
        return;
      case 'session.execution.succeeded':
        await this.messageQueue;
        this.host.work.executionEnded(data.sessionID);
        if (data.sessionID === this.host.providerSessionId) this.context.foregroundFinished();
        return;
      case 'session.execution.interrupted':
        if (data.sessionID === this.host.providerSessionId) this.context.fail(`OpenCode execution interrupted: ${event.data.reason}`);
        return;
      case 'session.idle':
        if (data.sessionID === this.host.providerSessionId && this.sawBusy) this.context.foregroundFinished();
        return;
      case 'session.status':
        if (data.sessionID !== this.host.providerSessionId) return;
        if (event.data.status.type === 'busy') this.sawBusy = true;
        if (event.data.status.type === 'idle' && this.sawBusy) this.context.foregroundFinished();
        return;
      default:
        return;
    }
  };

  handleEvent = async (event: OpenCodeEvent) => {
    if (this.context.finished() || this.host.aborted) return;
    if (event.type === 'session.created') {
      if (event.data.parentID && await this.ownsSession(event.data.parentID)) this.ownedSessions.add(event.data.sessionID);
      return;
    }
    if (event.type === 'form.created') {
      const form = event.data.form;
      const directory = event.location?.directory;
      const belongs = form.sessionID === 'global'
        ? directory && path.resolve(directory) === path.resolve(this.context.directory) && form.metadata?.kind === 'mcp-elicitation'
        : await this.ownsSession(form.sessionID);
      if (belongs) {
        this.context.gateway.askQuestion(form, directory ?? this.context.directory);
      }
      return;
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      this.context.gateway.settleForm(event.data.id, event.data.sessionID);
      return;
    }
    const data = event.data as AnyRecord;
    if (event.type === 'permission.asked' && await this.ownsSession(event.data.sessionID)) {
      this.context.gateway.handlePermissionAsked(event.data);
      return;
    }
    if (!this.ownedSessions.has(data.sessionID) && typeof data.sessionID === 'string') {
      if (!await this.ownsSession(data.sessionID)) return;
    }
    if (!this.ownedSessions.has(data.sessionID) || this.context.finished()) return;
    if (event.type === 'session.synthetic') {
      this.host.work.notificationDelivered(data.sessionID, data.metadata, event.created);
    }
    if (event.type === 'permission.replied') settleOpenCodePermission(event.data.requestID);
    if (data.sessionID !== this.host.providerSessionId) {
      await this.handleChildEvent(event);
      return;
    }
    if (data.sessionID === this.host.providerSessionId && event.type === 'session.compaction.ended') this.context.sendTokenUsage();
    if (data.sessionID === this.host.providerSessionId && this.projector.handle(event)) return;
    await this.handleRootEvent(event);
  };

}
