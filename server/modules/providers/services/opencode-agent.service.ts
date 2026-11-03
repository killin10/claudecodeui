import { sessionsDb } from '@/modules/database/index.js';
import { readOpenCodeAgent } from '@/modules/providers/list/opencode/opencode-agent.provider.js';
import { AppError } from '@/shared/utils.js';

/** Provider routes use this read-only lookup to synchronize the composer's mode with native state. */
export const opencodeAgentService = {
  read(sessionId: string) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session || session.provider !== 'opencode') {
      throw new AppError('OpenCode session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    const nativeId = session.provider_session_id;
    return { agent: nativeId?.startsWith('ses_') ? readOpenCodeAgent(nativeId) : null };
  },
};
