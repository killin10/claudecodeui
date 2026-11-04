import { getConnection, sessionsDb, sessionControlDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

import { sessionControlService } from './session-control.service.js';

const RESUME_MESSAGE = '上一轮执行因 CloudCLI 服务重启中断。请根据会话历史核对已完成的操作，继续完成尚未完成的任务，避免重复执行已经完成的操作。';

/** Server startup calls this before opening execution admission and starting dispatchers. */
export async function resumeSessionsAfterRestart(): Promise<void> {
  for (const session of sessionsDb.listRestartSessions()) {
    try {
      if (session.isArchived || !session.provider_session_id) {
        console.info('[SessionRestart] Skipping archived or uninitialized session', session.session_id);
        sessionsDb.setResumeAfterRestart(session.session_id, false);
        continue;
      }
      const history = await sessionsService.fetchHistory(session.session_id, { limit: 1 });
      if (!history.messages.length) {
        console.warn('[SessionRestart] No native history; refusing to start a replacement session', session.session_id);
        sessionsDb.setResumeAfterRestart(session.session_id, false);
        continue;
      }
      getConnection().transaction(() => {
        const current = sessionsDb.getSessionById(session.session_id);
        if (!current?.resume_after_restart) return;
        if (!current.isArchived && !sessionControlDb.hasReadyFollowup(current.session_id)) {
          if (current.user_id === null || !userDb.getUserById(current.user_id)) {
            throw new Error('Session has no active owner');
          }
          sessionControlService.enqueue(current.user_id, current.session_id, RESUME_MESSAGE);
        }
        sessionsDb.setResumeAfterRestart(current.session_id, false);
      })();
    } catch (error) {
      // Keep the marker if persistence/history access fails, so a later startup
      // can retry. Never guess a replacement session or another user's identity.
      console.error('[SessionRestart] Could not enqueue recovery', session.session_id, error);
    }
  }
}

/** Server shutdown saves candidates before stopping the provider-owned main turns. */
export async function stopSessionsForRestart(runtime: ProviderRuntimeGateway): Promise<void> {
  const runs = chatRunRegistry.saveRestartCandidates(
    sessionId => runtime.getPendingApprovalsForSession(sessionId).length > 0,
  );
  const aborts = runs.map(async run => {
    if (!chatRunRegistry.markRestartAbort(run)) return;
    try {
      if (!await runtime.abort(run.provider, run.appSessionId)) {
        console.warn('[SessionRestart] Provider did not acknowledge shutdown', run.appSessionId);
      }
    } catch (error) {
      console.error('[SessionRestart] Provider shutdown failed', run.appSessionId, error);
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(aborts),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
