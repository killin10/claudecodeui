import { sessionControlDb, sessionsDb, sessionDraftsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { SessionSubmission } from '@/shared/types.js';

import { sessionControlService } from './session-control.service.js';
import { createSubmissionResult } from './submission-result.js';
import { invalid } from './session-control.validation.js';

const ACTIVE: SessionSubmission['state'][] = ['running', 'waiting-for-input'];

/** Durable submission dispatcher, instantiated once by the server composition root (or with a fake runtime in tests). */
export function createSubmissionDispatcher(runtime: ProviderRuntimeGateway) {
  const owned = new Map<string, NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>();
  const executing = new Set<string>();
  const cancellations = new Map<string, Promise<boolean>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;
  async function execute(row: SessionSubmission): Promise<void> {
    const resultTracker = createSubmissionResult(row, () => cancellations.has(row.submissionId));
    const observedRuntime: ProviderRuntimeGateway = {
      ...runtime,
      run: (provider, command, options, writer) => {
        const run = chatRunRegistry.getRun(row.sessionId);
        if (run) {
          owned.set(row.submissionId, run);
        }
        return runtime.run(provider, command, options, {
          ...writer,
          userId: writer.userId,
          isWebSocketWriter: writer.isWebSocketWriter,
          setSessionId: writer.setSessionId?.bind(writer),
          send: (event) => { writer.send(event); resultTracker.observe(event); },
        });
      },
    };
    try {
      const result = await runDetachedChatTurn({ sessionId: row.sessionId, userId: row.userId, content: row.content, options: row.options }, { runtime: observedRuntime });
      const cancelled = await cancellations.get(row.submissionId);
      if (cancelled) {
        resultTracker.cancel();
        return;
      }
      const gatewayComplete = owned.get(row.submissionId)?.events.find((event) => event.kind === 'complete');
      resultTracker.finish(result, gatewayComplete);
    } catch (error) {
      resultTracker.fail(error instanceof Error ? error.message : String(error));
    } finally {
      owned.delete(row.submissionId);
      executing.delete(row.sessionId);
    }
  }
  async function poll(): Promise<void> {
    if (closed || polling || !chatRunRegistry.isAcceptingRuns()) {
      return;
    }
    polling = true;
    try {
      if (!sessionControlDb.hasQueued()) {
        return;
      }
      const busy = new Set((await sessionsService.listRunningSessions()).map((row) => row.sessionId));
      for (const row of sessionDraftsDb.listQueuedMessages())
        busy.add(row.sessionId);
      for (const row of sessionControlDb.queued([...busy, ...executing])) {
        if (closed || !chatRunRegistry.isAcceptingRuns() || executing.size >= 8) {
          break;
        }
        if (chatRunRegistry.isMutationReserved(row.sessionId) || busy.has(row.sessionId) || executing.has(row.sessionId) || chatRunRegistry.isProcessing(row.sessionId) || runtime.hasBackgroundWork(row.sessionId)) {
          continue;
        }
        const session = sessionsDb.getSessionById(row.sessionId);
        if (!session || session.isArchived) {
          sessionControlDb.transition(row.submissionId, ['queued'], 'failed', null, 'Session was deleted or archived before execution.');
          continue;
        }
        if (!sessionControlDb.transition(row.submissionId, ['queued'], 'running')) {
          continue;
        }
        executing.add(row.sessionId);
        void execute(row).catch((error) => console.error('[SessionControl] Execution persistence failed', error));
      }
    } finally {
      polling = false;
    }
  }
  return {
    poll,
    start() {
      if (timer) {
        return;
      }
      closed = false;
      sessionControlDb.recover();
      const tick = () => { void poll().catch((error) => console.error('[SessionControl] Dispatch failed', error)); };
      timer = setInterval(tick, 1000);
      timer.unref();
      tick();
    },
    close() { closed = true; clearInterval(timer); timer = undefined; },
    async cancel(userId: number, sessionId: string, submissionId: string) {
      const row = sessionControlService.submission(userId, sessionId, submissionId);
      if (row.state === 'queued') {
        sessionControlDb.transition(submissionId, ['queued'], 'cancelled');
      }
      if (ACTIVE.includes(row.state)) {
        const run = owned.get(submissionId);
        if (!run || run !== chatRunRegistry.getRun(sessionId) || run.status !== 'running') {
          invalid('This submission no longer owns an active run.', 'RUN_NOT_OWNED', 409);
        }
        const pending = cancellations.get(submissionId) ?? Promise.resolve().then(() => runtime.abort(run.provider, sessionId));
        cancellations.set(submissionId, pending);
        run.userCancelling = true;
        let aborted: boolean;
        try {
          aborted = await pending;
        }
        finally {
          cancellations.delete(submissionId);
          run.userCancelling = false;
        }
        if (!aborted) {
          invalid('Provider did not acknowledge cancellation.', 'CANCEL_FAILED', 409);
        }
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
        sessionControlDb.transition(submissionId, ACTIVE, 'cancelled');
      }
      return sessionControlService.submission(userId, sessionId, submissionId);
    },
  };
}
