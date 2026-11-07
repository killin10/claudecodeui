import { memo, useEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Star, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import { getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { SidebarProjectActions } from '@/modules/sidebar/SidebarProjectActions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  /** The sessions ticked in this project's list, or null when it is not the one selecting. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const sessionCountLabel = `${sessionCountDisplay} session${totalSessionCount === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  const isSelecting = selectedSessionIds !== null;
  const canSelect = isExpanded && initialSessionsLoaded
    && sessions.some((session) => !activeSessions.has(session.id) || backgroundSessionIds.has(session.id));
  const projectActions = (
    <SidebarProjectActions
      compact={isCompact}
      canSelect={canSelect}
      isSelecting={isSelecting}
      onNewSession={() => {
        if (isCompact) {
          onProjectSelect(project);
        }
        onNewSession(project);
      }}
      onToggleSelection={() => {
        if (isSelecting) {
          onCancelSessionSelection();
        } else {
          onSetSessionSelection({ projectId: project.projectId, sessionIds: new Set() });
        }
      }}
      onRename={() => onStartEditingProject(project)}
      onDelete={() => onDeleteProject(project)}
      t={t}
    />
  );

  return (
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="sticky top-0 z-10 md:group group">
        {isCompact && (
        <div className="bg-background">
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-lg bg-card border border-border/50 active:scale-[0.98] transition-all duration-150',
              isSelected && 'bg-primary/5 border-primary/20',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all duration-150 border',
                    isStarred
                      ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                      : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isStarred
                        ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                        : 'text-gray-600 dark:text-gray-400',
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      ref={mobileRenameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          // Cancelling the rename must not also close the code editor.
                          event.stopPropagation();
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <button type="button" className="w-full min-w-0 text-left" aria-expanded={isExpanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleProject();
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <h3 className="truncate text-sm font-normal text-foreground">{project.displayName}</h3>
                        {tasksEnabled && (
                          <TaskIndicator
                            status={taskStatus}
                            size="xs"
                            className="ml-2 hidden flex-shrink-0 md:inline-flex"
                          />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{sessionCountLabel}</p>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    {projectActions}

                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/30">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {!isCompact && (
        <div
          className={cn(
            'sticky top-0 z-10 flex w-full items-start justify-between rounded-md p-2 h-auto font-normal hover:bg-accent/50',
            isSelected
              ? 'bg-accent text-accent-foreground'
              : isStarred
                ? 'bg-background hover:bg-accent/50'
                : 'bg-background',
            isStarred &&
              !isSelected &&
              'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              aria-label={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded cursor-pointer transition-all duration-200',
                isStarred
                  ? 'hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                  : 'opacity-40 hover:opacity-100 hover:bg-accent',
              )}
              onClick={(event) => {
                event.stopPropagation();
                toggleStarProject();
              }}
              title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
            >
              <Star
                className={cn(
                  'w-3 h-3 transition-colors',
                  isStarred
                    ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                    : 'text-muted-foreground',
                )}
              />
            </button>
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        // Cancelling the rename must not also close the code editor.
                        event.stopPropagation();
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <button type="button" className="w-full min-w-0 text-left" aria-expanded={isExpanded}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectAndToggleProject();
                  }}
                >
                  <div className="truncate text-sm font-normal text-foreground" title={project.displayName}>
                    {project.displayName}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {sessionCountDisplay}
                    {project.fullPath !== project.displayName && (
                      <span className="ml-1 opacity-60" title={project.fullPath}>
                        {' - '}
                        {project.fullPath.length > 25 ? `...${project.fullPath.slice(-22)}` : project.fullPath}
                      </span>
                    )}
                  </div>
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <button type="button" aria-label={t('actions.save')}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </button>
                <button type="button" aria-label={t('actions.cancel')}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <>
                {projectActions}
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                )}
              </>
            )}
          </div>
        </div>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        backgroundSessionIds={backgroundSessionIds}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onArchiveSession={onArchiveSession}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        selectedSessionIds={selectedSessionIds}
        onSetSessionSelection={onSetSessionSelection}
        onToggleSessionSelected={onToggleSessionSelected}
        onCancelSessionSelection={onCancelSessionSelection}
        onDeleteSelectedSessions={onDeleteSelectedSessions}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
