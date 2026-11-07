import type { AnyRecord, BackgroundTaskSummary, NormalizedMessage, ProviderRuntimeContext, ProviderRuntimeWriter, SubagentInfo } from '@/shared/types.js';
import { createCompactionMessage, createNormalizedMessage, readCompactionDuration, readCodexContextUsage, unifiedDiffToTexts } from '@/shared/utils.js';
/** Translates native app-server events into the same cards and task lifecycle used by Claude. */
export class CodexRunEvents {
  readonly terminals = new Map<string, {
    threadId: string;
    processId: string;
  }>();
  readonly tasks = new Map<string, BackgroundTaskSummary>();
  readonly activeTurns = new Map<string, string>();
  readonly taskCards = new Map<string, NormalizedMessage>();
  private readonly pendingChildMessages = new Map<string, Map<string, NormalizedMessage>>();
  private readonly items = new Map<string, AnyRecord>();
  private readonly compactions = new Map<string, AnyRecord>();
  hadChildren = false;
  proposedPlan?: string;
  constructor(private readonly writer: ProviderRuntimeWriter, private readonly context: ProviderRuntimeContext, private readonly sessionId: () => string, private readonly rootThread: () => string) {
  }

  emit(message: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): void {
    this.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: this.sessionId(), ...message }));
  }

  handle(method: string, params: AnyRecord): void {
    const threadId = params.threadId;
    if (method === 'turn/started') {
      this.activeTurns.set(threadId, params.turn.id);
      if (threadId !== this.rootThread()) this.taskState(threadId, 'running');
    }
    if (method === 'turn/completed') {
      this.finishCompactions(threadId, params.turn.id, params.turn.status);
      this.activeTurns.delete(threadId);
      if (threadId !== this.rootThread()) {
        this.taskState(threadId, params.turn.status === 'failed' ? 'failed' : params.turn.status === 'interrupted' ? 'stopped' : 'completed');
      }
    }
    if (method === 'thread/tokenUsage/updated' && threadId === this.rootThread()) {
      this.emit({ kind: 'status', text: 'token_budget', tokenBudget: readCodexContextUsage(params.tokenUsage) });
    }
    if (method === 'thread/status/changed' && threadId !== this.rootThread()) {
      const status = params.status?.type;
      if (status === 'active') {
        this.taskState(threadId, 'running');
      }
      if (status === 'idle') {
        this.taskState(threadId, 'completed');
      }
      if (status === 'systemError') {
        this.taskState(threadId, 'failed');
      }
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.item.type === 'contextCompaction') {
        this.compaction(method, params);
        return;
      }
      if (params.item.type === 'userMessage') {
        this.userMessage(method, threadId, params.item);
        return;
      }
      this.items.set(`${threadId}:${params.item.id}`, { ...params.item });
      this.item(threadId, params.item);
      if (method === 'item/completed') {
        this.items.delete(`${threadId}:${params.item.id}`);
      }
    }
    if (method.endsWith('/delta') || method.endsWith('TextDelta') || method.endsWith('/outputDelta')) {
      this.delta(method, params);
    }
    if (method === 'turn/plan/updated') {
      this.emit({ kind: 'tool_use', id: `${params.turnId}:plan`, toolId: `${params.turnId}:plan`, toolName: 'TodoWrite',
        toolInput: { todos: (params.plan ?? []).map((step: AnyRecord) => ({ content: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) } });
    }
  }

  private userMessage(method: string, threadId: string, item: AnyRecord): void {
    if (threadId !== this.rootThread() || !item.clientId || method !== 'item/completed') return;
    const images = (item.content ?? []).filter((part: AnyRecord) => part.type === 'localImage')
      .map((part: AnyRecord) => ({ path: part.path }));
    for (const row of this.context.normalizeMessage({
      uuid: item.id, message: { role: 'user', content: item.content }, images,
    }, this.sessionId())) {
      this.emit({ ...row, steerMessageId: item.clientId });
    }
  }

  private compaction(method: string, params: AnyRecord): void {
    if (params.threadId !== this.rootThread()) return;
    const previous = this.compactions.get(params.item.id);
    const item = { ...previous, ...params.item, turnId: params.turnId };
    if (item.startedAtMs == null) item.startedAtMs = previous?.startedAtMs;
    const phase = method === 'item/started' ? 'running' : 'done';
    if (phase === 'running') this.compactions.set(item.id, item);
    else this.compactions.delete(item.id);
    this.emit(createCompactionMessage({
      id: item.id, sessionId: this.sessionId(), provider: 'codex',
      ...(typeof item.startedAtMs === 'number' ? { timestamp: new Date(item.startedAtMs).toISOString() } : {}),
      compact: { phase, durationMs: readCompactionDuration(item.startedAtMs, item.completedAtMs) },
    }));
  }

  private finishCompactions(threadId: string, turnId?: string, status?: string): void {
    if (threadId !== this.rootThread()) return;
    for (const [id, item] of this.compactions) {
      if (turnId && item.turnId !== turnId) continue;
      this.emit(createCompactionMessage({ id, sessionId: this.sessionId(), provider: 'codex',
        ...(typeof item.startedAtMs === 'number' ? { timestamp: new Date(item.startedAtMs).toISOString() } : {}),
        compact: { phase: 'failed', error: status === 'interrupted' ? 'Compaction interrupted' : 'Compaction ended without a completion event' } }));
      this.compactions.delete(id);
    }
  }

  taskState(threadId: string, status: SubagentInfo['status']): void {
    const card = this.taskCards.get(threadId);
    if (!card) {
      return;
    }
    // Idle/activity notifications have no outcome. They must not turn an
    // explicitly interrupted or failed turn into a successful task.
    if (status === 'completed' && !this.tasks.has(threadId)
      && (card.subagent?.status === 'stopped' || card.subagent?.status === 'failed')) {
      return;
    }
    if (status === 'running') {
      if (!this.tasks.has(threadId)) {
        this.tasks.set(threadId, { taskId: threadId, toolUseId: card.toolId!, taskType: 'agent', description: card.subagent?.description ?? 'Codex agent', startedAt: Date.now() });
      }
    } else {
      this.tasks.delete(threadId);
    }
    card.subagent = { ...card.subagent!, status };
    this.emit(card);
    const waiting = this.pendingChildMessages.get(threadId);
    this.pendingChildMessages.delete(threadId);
    for (const message of waiting?.values() ?? []) {
      this.emitChild(threadId, message);
    }
    this.emit({ kind: 'task_status', event: status === 'running' ? 'started' : 'notification', taskId: threadId, toolUseId: card.toolId, taskType: 'agent', status, description: card.subagent.description });
  }

  setTerminals(threadId: string, terminals: AnyRecord[]): void {
    const current = new Set(terminals.map(terminal => `terminal:${threadId}:${terminal.processId}`));
    for (const [id, terminal] of this.terminals) {
      if (terminal.threadId === threadId && !current.has(id)) {
        this.finishTerminal(id, 'completed');
      }
    }
    for (const terminal of terminals) {
      const taskId = `terminal:${threadId}:${terminal.processId}`;
      if (this.terminals.has(taskId)) {
        continue;
      }
      this.hadChildren = true;
      this.terminals.set(taskId, { threadId, processId: terminal.processId });
      const task = { taskId, toolUseId: terminal.itemId, taskType: 'command', description: terminal.command, startedAt: Date.now() };
      this.tasks.set(taskId, task);
      this.emit({ kind: 'task_status', event: 'started', ...task, status: 'running' });
    }
  }

  finishTerminal(taskId: string, status: 'completed' | 'stopped'): void {
    const task = this.tasks.get(taskId);
    this.terminals.delete(taskId);
    this.tasks.delete(taskId);
    if (task) {
      this.emit({ kind: 'task_status', event: 'notification', ...task, status });
    }
  }

  stopAll(): void {
    this.finishCompactions(this.rootThread(), undefined, 'interrupted');
    for (const id of [...this.terminals.keys()]) {
      this.finishTerminal(id, 'stopped');
    }
    for (const id of [...this.tasks.keys()]) {
      this.taskState(id, 'stopped');
    }
  }

  private delta(method: string, params: AnyRecord): void {
    const item = this.items.get(`${params.threadId}:${params.itemId}`);
    if (!item) {
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      item.text = (item.text ?? '') + params.delta;
    } else if (method === 'item/commandExecution/outputDelta') {
      item.aggregatedOutput = (item.aggregatedOutput ?? '') + params.delta;
    } else if (method === 'item/reasoning/summaryTextDelta') {
      item.summary ??= [];
      item.summary[params.summaryIndex ?? 0] = (item.summary[params.summaryIndex ?? 0] ?? '') + params.delta;
    } else {
      return;
    }
    this.item(params.threadId, item);
  }

  private item(threadId: string, item: AnyRecord): void {
    if (item.type === 'collabAgentToolCall') {
      this.collaboration(item);
      return;
    }
    if (item.type === 'subAgentActivity') {
      this.activity(item);
      return;
    }
    if (item.type === 'fileChange') {
      this.fileChanges(threadId, item);
      return;
    }
    const types: Record<string, string> = { agentMessage: 'agent_message', reasoning: 'reasoning', commandExecution: 'command_execution', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', plan: 'agent_message' };
    const itemType = types[item.type];
    if (!itemType) {
      return;
    }
    const text = item.type === 'reasoning' ? (item.summary ?? []).join('\n') : item.type === 'plan' ? `<proposed_plan>${item.text}</proposed_plan>` : item.text;
    if (threadId === this.rootThread() && item.type === 'plan') {
      this.proposedPlan = item.text;
    }
    if (threadId === this.rootThread() && item.type === 'agentMessage') {
      const plan = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(item.text ?? '');
      if (plan) {
        this.proposedPlan = plan[1];
      }
    }
    const raw = { ...item, type: 'item', itemId: item.id, itemType, message: { content: text }, status: item.status === 'inProgress' ? 'in_progress' : item.status, output: item.aggregatedOutput, query: item.action?.query ?? item.action?.queries?.join('\n') };
    for (const message of this.context.normalizeMessage(raw, this.sessionId())) {
      this.emitChild(threadId, message);
    }
  }

  private emitChild(threadId: string, message: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): void {
    const parentToolUseId = threadId === this.rootThread() ? undefined : this.taskCards.get(threadId)?.toolId;
    if (threadId !== this.rootThread() && !parentToolUseId) {
      const waiting = this.pendingChildMessages.get(threadId) ?? new Map<string, NormalizedMessage>();
      if (message.id) {
        waiting.set(message.id, message as NormalizedMessage);
      }
      if (waiting.size > 200) {
        waiting.delete(waiting.keys().next().value!);
      }
      this.pendingChildMessages.set(threadId, waiting);
      return;
    }
    this.emit({ ...message, ...(parentToolUseId ? { parentToolUseId } : {}) });
  }

  private fileChanges(threadId: string, item: AnyRecord): void {
    for (const [index, change] of (item.changes ?? []).entries()) {
      const id = `${item.id}_${index}`;
      const texts = unifiedDiffToTexts(change.diff ?? '');
      const toolInput = { file_path: change.path, old_string: texts.oldText, new_string: texts.newText, ...(change.kind?.type === 'delete' ? { deleted: true } : {}) };
      this.emitChild(threadId, { kind: 'tool_use', id, toolId: id, toolName: change.kind?.type === 'add' ? 'Write' : 'Edit', toolInput, status: item.status });
      if (item.status !== 'inProgress') {
        this.emitChild(threadId, { kind: 'tool_result', id: `${id}_result`, toolId: id, content: item.status === 'completed' ? 'Applied' : 'Change not applied', isError: item.status !== 'completed' });
      }
    }
  }

  private collaboration(item: AnyRecord): void {
    const statuses: Record<string, SubagentInfo['status']> = { pendingInit: 'running', running: 'running', interrupted: 'stopped', completed: 'completed', errored: 'failed', shutdown: 'stopped', notFound: 'stopped' };
    for (const threadId of item.receiverThreadIds ?? []) {
      if (!this.taskCards.has(threadId) && item.tool === 'spawnAgent') {
        this.hadChildren = true;
        this.taskCards.set(threadId, createNormalizedMessage({ provider: 'codex', sessionId: this.sessionId(), kind: 'tool_use', id: item.id, toolId: item.id, toolName: 'Task', toolInput: { description: item.prompt ?? 'Codex agent', prompt: item.prompt }, subagent: { id: threadId, status: 'running', model: item.model, description: item.prompt ?? 'Codex agent' } }));
      }
      const status = statuses[item.agentsStates?.[threadId]?.status];
      if (status) {
        this.taskState(threadId, status);
      } else if (item.tool === 'spawnAgent') {
        this.taskState(threadId, 'running');
      } else if (item.tool === 'closeAgent' || item.tool === 'interruptAgent') {
        this.taskState(threadId, 'stopped');
      }
    }
  }

  private activity(item: AnyRecord): void {
    if (!this.taskCards.has(item.agentThreadId) && item.kind === 'started') {
      this.hadChildren = true;
      this.taskCards.set(item.agentThreadId, createNormalizedMessage({ provider: 'codex', sessionId: this.sessionId(), kind: 'tool_use', id: item.id, toolId: item.id, toolName: 'Task', toolInput: { description: item.agentPath }, subagent: { id: item.agentThreadId, name: item.agentPath, status: 'running' } }));
    }
    const statuses: Record<string, SubagentInfo['status']> = { started: 'running', interrupted: 'stopped', completed: 'completed' };
    if (statuses[item.kind]) {
      this.taskState(item.agentThreadId, statuses[item.kind]);
    }
  }
}
