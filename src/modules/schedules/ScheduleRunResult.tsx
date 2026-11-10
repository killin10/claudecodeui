import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Shimmer } from '@/shared/ui';

type RunResult = {
  submission: { result: { content?: string; text?: string }[]; error: string | null } | null;
  reason: string | null;
};

/** History mounts one result beneath its owning row; closing it discards any pending response. */
export function ScheduleRunResult({ scheduleId, runId }: { scheduleId: string; runId: string }) {
  const { t } = useTranslation('common');
  // Loading, failure and output remain local to the expanded execution.
  const [result, setResult] = useState<{ content: string } | { error: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    void api.schedules.run(scheduleId, runId)
      .then(readApiJson<RunResult>)
      .then((data) => {
        const output = data.submission?.result
          ?.map((message) => message.content ?? message.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        if (!disposed) {
          setResult({ content: [output, data.submission?.error ?? data.reason].filter(Boolean).join('\n\n') });
        }
      })
      .catch((error: Error) => {
        if (!disposed) setResult({ error: error.message });
      });
    return () => { disposed = true; };
  }, [scheduleId, runId]);
  return (
    <div className="pt-2" aria-live="polite">
      {!result ? (
        <p role="status" className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <Shimmer>{t('schedules.loading')}</Shimmer>
        </p>
      ) : 'error' in result ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{result.error}</p>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          {result.content || t('schedules.noResult')}
        </pre>
      )}
    </div>
  );
}
