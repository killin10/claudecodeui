import type { SideQuestionOutcome, SideQuestionRequest, SideQuestionSink } from '@/shared/types.js';
import { readOpenCodeErrorMessage, SIDE_CONVERSATION_BOUNDARY_PROMPT } from '@/shared/utils.js';

import { startOpenCodeServer } from './opencode-server.provider.js';

const servers = new Set<{ close(): void }>();
process.once('exit', () => {
  for (const server of servers) server.close();
});

/**
 * OpenCode runtime uses V2's transient generation API. Its native contract is
 * to read the session context without mutating history, so no V1 fork, agent
 * config injection or synchronizer suppression is required. The native session
 * selects the model; the API returns one complete answer rather than SSE text.
 */
export async function askOpenCodeSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
): Promise<SideQuestionOutcome> {
  if (!request.providerSessionId) {
    return { status: 'error', error: 'This OpenCode session has no provider session to ask a side question on yet.', answer: '' };
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5 * 60_000)]);
  let server: { close(): void } | undefined;
  try {
    signal.throwIfAborted();
    const started = await startOpenCodeServer(signal);
    server = started.server;
    servers.add(server);
    const result = await started.client.session.generate({
      sessionID: request.providerSessionId,
      prompt: `${SIDE_CONVERSATION_BOUNDARY_PROMPT}\n\n${request.question}`,
    }, { signal });
    signal.throwIfAborted();
    if (typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('OpenCode returned no answer to the side question.');
    }
    sink.delta(result.text);
    return { status: 'done', answer: result.text };
  } catch (error) {
    return {
      status: 'error', answer: '',
      error: request.signal.aborted ? 'The side question was dismissed.' : readOpenCodeErrorMessage(error),
    };
  } finally {
    if (server) servers.delete(server);
    server?.close();
  }
}
