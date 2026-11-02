import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OpenCodeSavedPermission } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

/** Permissions content renders one native approval with independent, retryable edits. */
export function OpenCodeSavedApproval({ approval, busy, onChange }: {
  approval: OpenCodeSavedPermission;
  busy: boolean;
  onChange(approval: OpenCodeSavedPermission, rule: Pick<OpenCodeSavedPermission, 'action' | 'resource'> | null): Promise<void>;
}) {
  const { t } = useTranslation('settings');
  // Preserve the edited rule on native validation or transport failures.
  const [draft, setDraft] = useState({ action: approval.action, resource: approval.resource });
  return <div className="space-y-2 rounded border p-3">
    <p className="break-all font-mono text-xs">{approval.action} · {approval.resource} → allow</p>
    <Input aria-label={`${t('opencodePermissions.action')} ${approval.id}`} disabled={busy}
      value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} />
    <Input aria-label={`${t('opencodePermissions.resource')} ${approval.id}`} disabled={busy}
      value={draft.resource} onChange={(event) => setDraft({ ...draft, resource: event.target.value })} />
    <div className="flex gap-2">
      <Button disabled={busy || !draft.action.trim() || !draft.resource.trim()} onClick={() => void onChange(approval, draft)}>
        {t('opencodePermissions.updateSaved', 'Update approval')}
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => void onChange(approval, null)}>
        {t('opencodePermissions.revoke', 'Revoke approval')}
      </Button>
    </div>
  </div>;
}
