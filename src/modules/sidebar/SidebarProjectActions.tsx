import { CheckSquare, Edit3, Plus, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';

function ProjectActionButton({ icon: Icon, label, compact, pressed, destructive, onClick }: {
  icon: LucideIcon;
  label: string;
  compact: boolean;
  pressed?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label} position="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          'flex shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          compact ? 'h-8 w-8' : 'h-6 w-6',
          destructive ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          pressed && 'bg-primary/10 text-primary',
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <Icon aria-hidden="true" className={compact ? 'h-4 w-4' : 'h-3 w-3'} />
      </button>
    </Tooltip>
  );
}

/** Project rows in Projects and Running share these icon-only session and project actions. */
export function SidebarProjectActions({ compact, canSelect, isSelecting, onNewSession, onToggleSelection, onRename, onDelete, t }: {
  compact: boolean;
  canSelect: boolean;
  isSelecting: boolean;
  onNewSession: () => void;
  onToggleSelection: () => void;
  onRename: () => void;
  onDelete: () => void;
  t: TFunction;
}) {
  return (
    <div className={cn(
      'flex shrink-0 items-center gap-0.5 transition-opacity',
      !compact && !isSelecting && 'touch:opacity-100 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
    )}>
      <ProjectActionButton icon={Plus} label={t('sessions.newSession')} compact={compact} onClick={onNewSession} />
      {(canSelect || isSelecting) && (
        <ProjectActionButton icon={CheckSquare} compact={compact} pressed={isSelecting}
          label={isSelecting ? t('sessions.exitSelection', 'Exit selection') : t('sessions.selectConversations', 'Select conversations')}
          onClick={onToggleSelection} />
      )}
      <ProjectActionButton icon={Edit3} label={t('tooltips.renameProject')} compact={compact} onClick={onRename} />
      <ProjectActionButton icon={Trash2} label={t('tooltips.deleteProject')} compact={compact} destructive onClick={onDelete} />
    </div>
  );
}
