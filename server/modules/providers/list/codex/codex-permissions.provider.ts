import { randomUUID } from 'node:crypto';

import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';
import type { AnyRecord, ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';
import type { CodexRpcConnection } from '@/modules/providers/list/codex/codex-app-server.client.js';
type PendingApproval = {
  sessionId: string;
  nativeId: string | number;
  threadId: string;
  request: AnyRecord;
  reply(decision: ProviderPermissionDecision): void;
};
const pending = new Map<string, PendingApproval>();
function questionAnswers(params: AnyRecord, decision: ProviderPermissionDecision) {
  const input = readObjectRecord(decision.updatedInput);
  const answers = input?.answers;
  return Object.fromEntries((params.questions ?? []).map((question: AnyRecord, index: number) => {
    const value = Array.isArray(answers) ? answers[index] : answers?.[question.question];
    return [question.id, { answers: !decision.allow ? [] : Array.isArray(value) ? value : typeof value === 'string' ? [value] : [] }];
  }));
}
/** Only native-proposed command prefixes may become persistent exec rules. */
function proposedRule(params: AnyRecord): string[] | undefined {
  const rule = params.proposedExecpolicyAmendment;
  const choices = params.availableDecisions;
  const offered = !Array.isArray(choices) || choices.some(choice => choice && typeof choice === 'object' && 'acceptWithExecpolicyAmendment' in choice);
  return offered && Array.isArray(rule) && rule.length > 0 && rule.every(token => typeof token === 'string') ? rule : undefined;
}

function approvalReply(method: string, params: AnyRecord, decision: ProviderPermissionDecision) {
  if (method === 'item/tool/requestUserInput') {
    return { answers: questionAnswers(params, decision) };
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: decision.allow ? params.permissions : {}, scope: decision.rememberEntry === 'session' ? 'session' : 'turn' };
  }
  const rule = proposedRule(params);
  if (decision.allow && decision.rememberEntry === 'always' && rule) {
    return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } };
  }
  const sessionAllowed = !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('acceptForSession');
  return { decision: !decision.allow ? 'decline' : decision.rememberEntry === 'session' && sessionAllowed ? 'acceptForSession' : 'accept' };
}
/** UI approval gateway; pending requests are replayable to reconnecting clients. */
export const codexPermissions = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    pending.get(requestId)?.reply(decision);
  },
  listPending(sessionId: string): unknown[] {
    return [...pending.values()].filter(entry => entry.sessionId === sessionId).map(entry => entry.request);
  },
};
/** Owns native requests for one run and retracts prompts on cancellation or native resolution. */
export class CodexRunPermissions {
  constructor(private readonly connection: CodexRpcConnection, private readonly writer: ProviderRuntimeWriter, private readonly sessionId: () => string, private readonly mode: string) {
  }

  handle(nativeId: string | number, method: string, params: AnyRecord): void {
    if (method === 'currentTime/read') {
      this.connection.respond(nativeId, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    const question = method === 'item/tool/requestUserInput';
    const edit = method === 'item/fileChange/requestApproval';
    const command = method === 'item/commandExecution/requestApproval';
    const permissions = method === 'item/permissions/requestApproval';
    if (!(question || edit || command || permissions)) {
      this.connection.rejectRequest(nativeId, `Unsupported Codex request: ${method}`);
      return;
    }
    if (!question && (this.mode === 'bypassPermissions' || (edit && this.mode === 'acceptEdits'))) {
      this.connection.respond(nativeId, approvalReply(method, params, { allow: true }));
      return;
    }
    const requestId = `codex:${randomUUID()}`;
    const persistentRule = command ? proposedRule(params) : undefined;
    const request = createNormalizedMessage({
      provider: 'codex', kind: 'permission_request', sessionId: this.sessionId(), requestId,
      toolName: question ? 'AskUserQuestion' : edit ? 'Edit' : command ? 'Bash' : 'RequestPermissions',
      input: question ? { questions: params.questions } : command ? { command: params.command, reason: params.reason } : params,
      context: question ? { answerFormat: 'label-lists' } : { provider: 'codex', reason: params.reason, ...(persistentRule ? { always: [JSON.stringify(persistentRule)], patterns: [params.command] } : {}), approvalPersistence: !persistentRule && (!Array.isArray(params.availableDecisions) || params.availableDecisions.includes('acceptForSession')) ? 'session' : 'none' },
    });
    pending.set(requestId, {
      sessionId: this.sessionId(), nativeId, threadId: params.threadId, request,
      reply: decision => {
        if (!pending.delete(requestId)) {
          return;
        }
        this.connection.respond(nativeId, approvalReply(method, params, decision));
        this.writer.send(createNormalizedMessage({ provider: 'codex', kind: 'permission_resolved', sessionId: this.sessionId(), requestId }));
      },
    });
    this.publish(request);
  }

  proposePlan(plan: string, onDecision: (decision: ProviderPermissionDecision) => void): void {
    const requestId = `codex:plan:${randomUUID()}`;
    const request = createNormalizedMessage({ provider: 'codex', sessionId: this.sessionId(), kind: 'permission_request', requestId, toolName: 'ExitPlanMode', input: { plan } });
    pending.set(requestId, {
      sessionId: this.sessionId(), nativeId: requestId, threadId: '', request,
      reply: decision => {
        if (!pending.delete(requestId)) {
          return;
        }
        this.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: this.sessionId(), kind: 'permission_resolved', requestId }));
        onDecision(decision);
      },
    });
    this.publish(request);
  }

  private publish(request: AnyRecord): void {
    this.writer.send(request);
    notifyUserIfEnabled({ userId: this.writer.userId, event: createNotificationEvent({
        provider: 'codex', sessionId: request.sessionId, kind: 'action_required', code: 'permission.required',
        severity: 'warning', requiresUserAction: true, meta: { toolName: request.toolName },
        dedupeKey: `codex:permission:${request.requestId}` as AnyRecord['dedupeKey'],
      }) });
  }

  resolved(nativeId?: string | number, threadId?: string): void {
    for (const [requestId, entry] of pending) {
      if (entry.sessionId !== this.sessionId()) {
        continue;
      }
      if (nativeId !== undefined && entry.nativeId !== nativeId) {
        continue;
      }
      if (threadId !== undefined && entry.threadId !== threadId) {
        continue;
      }
      pending.delete(requestId);
      this.writer.send(createNormalizedMessage({ provider: 'codex', kind: 'permission_cancelled', sessionId: this.sessionId(), requestId }));
    }
  }
}
