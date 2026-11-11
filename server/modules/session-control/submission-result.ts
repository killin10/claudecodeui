import type { NormalizedMessage, SessionSubmission } from '@/shared/types.js';

import { transitionSubmission } from './submission-transition.js';

const ACTIVE: SessionSubmission['state'][] = ['running', 'waiting-for-input'];

/**
 * Accumulates bounded final responses and translates provider events for the
 * submission dispatcher. With `recordResult: false` only state and error are
 * tracked and the stored result stays empty.
 */
export function createSubmissionResult(row: SessionSubmission, isCancelling: () => boolean, { recordResult = true }: { recordResult?: boolean } = {}) {
  const messages: NormalizedMessage[] = [];
  let terminal = false;
  let failure: string | null = null;
  let bytes = 0;
  let truncated = false;
  const pendingPermissions = new Set<string>();
  function recordText(event: NormalizedMessage) {
    if (truncated) {
      return;
    }
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (messages.length < 1000 && bytes <= 4000000) {
      messages.push({ ...event, sessionId: row.sessionId });
      return;
    }
    truncated = true;
    messages.push({
      id: 'result-truncated', kind: 'history_truncated', provider: event.provider,
      sessionId: row.sessionId, timestamp: new Date().toISOString(),
      content: 'Submission result exceeded 1000 messages or 4 MB; read session history for the full transcript.',
    });
  }
  function observe(raw: unknown) {
    const event = raw as NormalizedMessage & {
      exitCode?: number;
      aborted?: boolean;
    };
    if (!event || typeof event.kind !== 'string' || terminal) {
      return;
    }
    if (recordResult && event.kind === 'text' && event.role === 'assistant') {
      recordText(event);
    }
    if (event.kind === 'error') {
      failure = event.content ?? event.text ?? 'Provider error';
    }
    if (event.kind === 'permission_request') {
      pendingPermissions.add(event.requestId ?? 'unknown');
      transitionSubmission(row, ACTIVE, 'waiting-for-input');
    }
    if (event.kind === 'permission_resolved' || event.kind === 'permission_cancelled') {
      pendingPermissions.delete(event.requestId ?? 'unknown');
      if (!pendingPermissions.size) {
        transitionSubmission(row, ACTIVE, 'running');
      }
    }
    if (event.kind !== 'complete' || isCancelling()) {
      return;
    }
    terminal = true;
    const state = event.aborted ? 'cancelled' : event.exitCode === 0 && !failure ? 'succeeded' : 'failed';
    transitionSubmission(row, ACTIVE, state, messages, failure ?? (state === 'failed' ? 'Provider did not complete successfully.' : null));
  }
  return {
    observe,
    cancel() { transitionSubmission(row, ACTIVE, 'cancelled', messages); },
    fail(error: string) { transitionSubmission(row, ACTIVE, 'failed', messages, error); },
    finish(result: {
      started: boolean;
      error: string | null;
    }, gatewayComplete?: NormalizedMessage) {
      if (gatewayComplete) {
        observe(gatewayComplete);
      }
      if (!result.started && result.error?.includes('in progress')) {
        transitionSubmission(row, ACTIVE, 'queued');
      }
      else if (!terminal) {
        transitionSubmission(row, ACTIVE, 'failed', messages, result.error ?? 'Provider ended without a completion event.');
      }
    },
  };
}
