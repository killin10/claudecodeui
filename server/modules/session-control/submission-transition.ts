import { sessionControlDb } from '@/modules/database/index.js';
import { broadcastToConnectedClients } from '@/modules/websocket/index.js';
import type { SessionSubmission } from '@/shared/types.js';

/**
 * Moves a submission between states and, when the row actually changed, tells
 * every open socket which session's submission moved.
 *
 * The schedules page derives a run's state from its submission, so without this
 * it could only learn about progress by polling. The frame carries ids and the
 * new state only; clients read the detail through their own authenticated GET.
 *
 * Used by the submission result tracker and the submission dispatcher, which
 * are the only two places a submission's state is written.
 */
export function transitionSubmission(
  row: Pick<SessionSubmission, 'submissionId' | 'sessionId'>,
  from: SessionSubmission['state'][],
  state: SessionSubmission['state'],
  result: unknown = null,
  error: string | null = null,
): boolean {
  const changed = sessionControlDb.transition(row.submissionId, from, state, result, error);
  if (changed) {
    broadcastToConnectedClients(JSON.stringify({
      kind: 'session_submission_changed',
      sessionId: row.sessionId,
      submissionId: row.submissionId,
      state,
      timestamp: new Date().toISOString(),
    }));
  }
  return changed;
}
