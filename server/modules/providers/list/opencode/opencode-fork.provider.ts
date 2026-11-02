import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { startOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.provider.js';
import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

function readMessages(sessionId: string): Array<{ id: string; type: string }> {
  const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT id, type FROM session_message WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ id: string; type: string }>;
  } finally {
    db.close();
  }
}

function nextMessage(sessionId: string, keepThroughId: string | null): string | undefined {
  const rows = readMessages(sessionId);
  if (keepThroughId === null) return rows[0]?.id;
  const index = rows.findIndex((row) => row.id === keepThroughId);
  if (index < 0) throw new AppError('The fork anchor no longer exists.', { code: 'INVALID_ANCHOR', statusCode: 409 });
  return rows[index + 1]?.id;
}

/** Used by the provider and sessions adapter for native V2 branching and edit-before semantics. */
export class OpenCodeForkProvider implements IProviderFork {
  readonly requiresTranscriptFile = false;

  async forkSession(input: Parameters<IProviderFork['forkSession']>[0]) {
    const before = input.upToAnchorId ? nextMessage(input.providerSessionId, input.upToAnchorId) : undefined;
    return this.createFork(input.providerSessionId, before);
  }

  async resolveEditAnchor(sessionId: string, anchorId: string) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.provider_session_id) return { found: false, resumeThroughId: null };
    const rows = readMessages(session.provider_session_id);
    const index = rows.findIndex((row) => row.id === anchorId && row.type === 'user');
    return { found: index >= 0, resumeThroughId: index > 0 ? rows[index - 1].id : null };
  }

  async rewindSession(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.provider_session_id) {
      throw new AppError('This session has not run yet.', { code: 'EDIT_SOURCE_NOT_READY', statusCode: 409 });
    }
    const before = nextMessage(session.provider_session_id, keepThroughId);
    const fork = await this.createFork(session.provider_session_id, before);
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: session.provider_session_id, provider: 'opencode', sessionId, jsonlPath: null,
    });
    sessionsDb.repointSessionToProviderSession(sessionId, fork);
  }

  private async createFork(sessionID: string, before?: string) {
    const signal = AbortSignal.timeout(90_000);
    const { client, server } = await startOpenCodeServer(signal);
    try {
      const fork = await client.session.fork({ sessionID, ...(before ? { before } : {}) }, { signal });
      return { providerSessionId: fork.id, jsonlPath: null };
    } finally {
      server.close();
    }
  }
}
