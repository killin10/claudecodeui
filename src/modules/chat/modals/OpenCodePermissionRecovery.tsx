import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { ToolResult } from '@/shared/types';

const OpenCodePermissionsContent = lazy(() => import('@/modules/settings').then((module) => ({ default: module.OpenCodePermissionsContent })));

/** MessageComponent offers the native permission editor only for a structured OpenCode denial. */
export function OpenCodePermissionRecovery({ result, workspacePath }: { result: ToolResult; workspacePath: string }) {
  const { t } = useTranslation('chat');
  // Keep the editor closed until the user explicitly chooses to review the denial.
  const [open, setOpen] = useState(false);
  // V2's toSessionError preserves permission failures as permission.rejected.
  // Command output and generic tool errors must never trigger this affordance.
  const denied = result.isError && result.errorType === 'permission.rejected';
  if (!denied) return null;
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      {t('permissions.reviewNative', 'Review OpenCode permissions')}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-3xl space-y-3 overflow-y-auto p-4">
        <DialogTitle>{t('permissions.reviewNative', 'Review OpenCode permissions')}</DialogTitle>
        <p className="break-all text-sm">{workspacePath}</p>
        <p className="text-sm text-muted-foreground">{t('permissions.reviewNativeHint', 'Review the matching rules before changing access. User rules apply across projects; agent and session rules can still deny access. Saving does not retry the failed tool.')}</p>
        {open && <Suspense fallback={<p role="status">{t('permissions.loadingNative', 'Loading permissions…')}</p>}>
          <OpenCodePermissionsContent key={workspacePath} projects={[]} fixedWorkspacePath={workspacePath} />
        </Suspense>}
        <Button variant="outline" onClick={() => setOpen(false)}>{t('permissions.closeNative', 'Close')}</Button>
      </DialogContent>
    </Dialog>
  </>;
}
