/**
 * HTTP contract shared by the provider subscription-usage endpoint and the chat
 * Token Usage modal. Every instant is a UTC ISO string.
 */

/** Subscriptions whose plan quota CloudCLI can report. */
export type SubscriptionUsageProvider = 'claude' | 'codex' | 'zai';

/**
 * The rolling window a quota is measured over. `custom` covers windows a
 * provider may introduce later; `windowMinutes` then carries the length.
 */
export type SubscriptionUsagePeriod = 'five_hour' | 'weekly' | 'monthly' | 'custom';

/** One quota of a subscription, such as the 5-hour or the weekly limit. */
export type SubscriptionUsageWindow = {
  /** Stable key within its provider, used as the React key. */
  key: string;
  period: SubscriptionUsagePeriod;
  /** Window length in minutes when the provider states it. */
  windowMinutes?: number;
  /** Narrows the quota to a model or tool family (e.g. "Opus", "MCP"); null for the plan-wide quota. */
  scope: string | null;
  /** Percentage of the quota used, 0-100, or null when the provider omits it. */
  usedPercent: number | null;
  /** When the window next resets. A past instant means the data predates the reset. */
  resetsAt: string | null;
  /** Count-based quotas (Z.ai MCP calls) also report the raw used/limit numbers. */
  used?: number;
  limit?: number;
};

/** Plan quota snapshot of one subscription. */
export type SubscriptionUsage = {
  provider: SubscriptionUsageProvider;
  /**
   * `ok` carries windows. `unavailable` means the subscription is not set up
   * on this machine (not logged in, no key, no local data); `error` means the
   * lookup itself failed.
   */
  status: 'ok' | 'unavailable' | 'error';
  /** Plan name as the provider reports it (e.g. "pro", "max"), when known. */
  plan: string | null;
  windows: SubscriptionUsageWindow[];
  /** When the data was observed: fetch time for live lookups, the log row time for Codex. */
  observedAt: string | null;
  /** Why the status is not `ok`. Plain English; the UI shows it as-is. */
  message?: string;
};

/** Response body `data` of `GET /api/providers/subscription-usage`. */
export type SubscriptionUsageReport = {
  subscriptions: SubscriptionUsage[];
};
