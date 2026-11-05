import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { broadcastSidebarInvalidated } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): delete each indexed session through its provider
 *   before removing the project. A failure leaves the project and remaining
 *   sessions available for retry; project source files are never removed.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    broadcastSidebarInvalidated();
    return;
  }

  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(row.project_path);
  for (const session of sessions) {
    await sessionsService.deleteOrArchiveSessionById(session.session_id, {
      force: true,
      deletedFromDisk: true,
    });
  }
  projectsDb.deleteProjectById(projectId);
  broadcastSidebarInvalidated();
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
  broadcastSidebarInvalidated();
}
