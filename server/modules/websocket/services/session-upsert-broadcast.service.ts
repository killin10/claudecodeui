import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionUpsertedEvent } from '@/shared/types.js';

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  let row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  if (project?.isArchived) return null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  // Display-name discovery may yield; do not resurrect a row archived/deleted meanwhile.
  row = sessionsDb.getSessionById(row.session_id);
  if (!row || row.isArchived || (project && projectsDb.getProjectById(project.project_id)?.isArchived)) return null;

  return {
    kind: 'session_upserted',
    total: sessionsDb.getRecentSessionsPage(0, 0).total,
    projectTotal: projectPath ? sessionsDb.countSessionsByProjectPath(projectPath) : 0,
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  };
}

function sendToConnectedClients(payloads: string[]): void {
  if (payloads.length === 0) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string, metadataOnly = false): Promise<void> {
  if (connectedClients.size === 0) return;
  const event = await buildSessionUpsertedEvent(sessionIdOrProviderSessionId);
  if (event) {
    sendToConnectedClients([JSON.stringify({ ...event, metadataOnly })]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once.
 * Each event is sent before building the next one, so a mutation during async
 * display-name discovery cannot overtake an older buffered event.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  for (const sessionId of sessionIds) {
    await broadcastSessionUpserted(sessionId);
  }
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionUpsertedEvent };

/** Used by session mutations to remove rows from every connected sidebar. */
export function broadcastSessionRemoved(sessionId: string, projectPath: string | null): void {
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  sendToConnectedClients([JSON.stringify({
    kind: 'session_removed', sessionId, projectId: project?.project_id ?? null,
    total: sessionsDb.getRecentSessionsPage(0, 0).total,
    projectTotal: projectPath ? sessionsDb.countSessionsByProjectPath(projectPath) : 0,
  })]);
}

/** Project archive/restore/delete changes list membership beyond a single row. */
export function broadcastSidebarInvalidated(): void {
  sendToConnectedClients([JSON.stringify({ kind: 'sidebar_invalidated' })]);
}
