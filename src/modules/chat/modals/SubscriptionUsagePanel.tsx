import { Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { useSubscriptionUsage } from '@/modules/chat/hooks/useSubscriptionUsage';
import { Badge, Button, LLMProviderLogo } from '@/shared/ui';
import type { SubscriptionUsage, SubscriptionUsageWindow } from '@/shared/types';

const SUBSCRIPTION_NAMES: Record<SubscriptionUsage['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  zai: 'Z.ai Coding Plan',
};

const MINUTE_MS = 60_000;

function formatTimeUntil(t: TFunction, milliseconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / MINUTE_MS));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t('chat:subscriptionUsage.durationDays', { days, hours });
  if (hours > 0) return t('chat:subscriptionUsage.durationHours', { hours, minutes });
  return t('chat:subscriptionUsage.durationMinutes', { minutes });
}

function windowLabel(t: TFunction, window: SubscriptionUsageWindow): string {
  const period = window.period === 'custom'
    ? t('chat:subscriptionUsage.period.customHours', { count: Math.round((window.windowMinutes ?? 0) / 60) })
    : t(`chat:subscriptionUsage.period.${window.period}`);
  return window.scope ? `${period} · ${window.scope}` : period;
}

function barTone(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-primary';
}

function QuotaRow({ window, now }: { window: SubscriptionUsageWindow; now: number }) {
  const { t } = useTranslation();
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // Data captured before the reset (Codex logs, cached answers) no longer says anything about the new window.
  const hasReset = Number.isFinite(resetsAtMs) && resetsAtMs <= now;
  const percent = window.usedPercent === null ? null : Math.min(100, Math.max(0, window.usedPercent));

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{windowLabel(t, window)}</span>
        <span className={`font-mono font-semibold ${hasReset ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
          {percent === null ? '—' : `${Math.round(percent)}%`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={windowLabel(t, window)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className={`h-full rounded-full transition-[width] ${hasReset ? 'bg-muted-foreground/30' : barTone(percent ?? 0)}`}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-[11px] text-muted-foreground">
        <span>
          {hasReset
            ? t('chat:subscriptionUsage.resetPassed')
            : Number.isFinite(resetsAtMs)
              ? t('chat:subscriptionUsage.resetsIn', { time: formatTimeUntil(t, resetsAtMs - now) })
              : null}
        </span>
        {window.used !== undefined && window.limit !== undefined && (
          <span>{t('chat:subscriptionUsage.calls', { used: window.used.toLocaleString(), limit: window.limit.toLocaleString() })}</span>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({ usage, now }: { usage: SubscriptionUsage; now: number }) {
  const { t } = useTranslation();
  const observedAt = usage.observedAt ? new Date(usage.observedAt) : null;

  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {usage.provider === 'zai' ? (
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-bold text-background">Z</span>
          ) : (
            <LLMProviderLogo provider={usage.provider} className="h-5 w-5 shrink-0" />
          )}
          <span className="truncate text-sm font-semibold text-foreground">{SUBSCRIPTION_NAMES[usage.provider]}</span>
          {usage.plan && <Badge variant="secondary" className="shrink-0 uppercase">{usage.plan}</Badge>}
        </div>
        {observedAt && !Number.isNaN(observedAt.getTime()) && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('chat:subscriptionUsage.updatedAt', {
              time: observedAt.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
            })}
          </span>
        )}
      </div>

      {usage.status !== 'ok' ? (
        <p className={`text-xs ${usage.status === 'error' ? 'text-red-500' : 'text-muted-foreground'}`}>{usage.message}</p>
      ) : usage.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('chat:subscriptionUsage.noWindows')}</p>
      ) : (
        <div className="space-y-3">
          {usage.windows.map((window) => <QuotaRow key={window.key} window={window} now={now} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Rendered by the chat Token Usage modal under the session's context numbers:
 * the 5-hour, weekly and monthly quotas of the Claude, Codex and Z.ai plans.
 */
export default function SubscriptionUsagePanel() {
  const { t } = useTranslation();
  // Reset countdowns are measured from when the report arrived; each refresh moves it.
  const { report, receivedAt: now, isLoading, hasError, refresh } = useSubscriptionUsage();

  return (
    <section className="space-y-3" aria-busy={isLoading}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('chat:subscriptionUsage.title')}</p>
          <p className="text-xs text-muted-foreground">{t('chat:subscriptionUsage.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 rounded-xl"
          onClick={() => void refresh()}
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('chat:subscriptionUsage.refresh')}
        </Button>
      </div>

      {!report ? (
        <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {hasError && !isLoading ? t('chat:subscriptionUsage.loadFailed') : t('chat:subscriptionUsage.loading')}
        </div>
      ) : (
        <>
          {hasError && <p className="text-xs text-red-500">{t('chat:subscriptionUsage.loadFailed')}</p>}
          <div className="grid gap-3 md:grid-cols-3">
            {report.subscriptions.map((usage) => <SubscriptionCard key={usage.provider} usage={usage} now={now} />)}
          </div>
        </>
      )}
    </section>
  );
}
