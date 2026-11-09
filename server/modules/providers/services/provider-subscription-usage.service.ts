import os from 'node:os';
import path from 'node:path';

import { fetchClaudePlanUsage } from '@/modules/providers/list/claude/claude-plan-usage.provider.js';
import { readCodexPlanUsage } from '@/modules/providers/list/codex/codex-plan-usage.provider.js';
import { fetchZaiPlanUsage, getOpenCodeAuthFilePath } from '@/modules/providers/list/opencode/zai-plan-usage.provider.js';
import type { SubscriptionUsage, SubscriptionUsageProvider, SubscriptionUsageReport } from '@/shared/types.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

type SubscriptionUsageReaders = Record<SubscriptionUsageProvider, () => Promise<SubscriptionUsage>>;

type ProviderSubscriptionUsageServiceDependencies = {
  readers: SubscriptionUsageReaders;
  now: () => number;
  cacheTtlMs: number;
};

/**
 * Plan quotas move slowly, and the Claude lookup starts a CLI process, so a
 * modal reopened within this window reuses the last answer. A manual refresh
 * bypasses it.
 */
const SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;

/** Display order in the modal. */
const PROVIDER_ORDER: SubscriptionUsageProvider[] = ['claude', 'codex', 'zai'];

const defaultReaders: SubscriptionUsageReaders = {
  claude: fetchClaudePlanUsage,
  codex: () => readCodexPlanUsage(path.join(os.homedir(), '.codex', 'sessions')),
  zai: () => {
    const databasePath = getOpenCodeDatabasePath();
    return fetchZaiPlanUsage(databasePath, getOpenCodeAuthFilePath(databasePath));
  },
};

function errorUsage(provider: SubscriptionUsageProvider, error: unknown): SubscriptionUsage {
  return {
    provider,
    status: 'error',
    plan: null,
    windows: [],
    observedAt: null,
    message: error instanceof Error ? error.message : 'Usage lookup failed.',
  };
}

/**
 * Creates the subscription-usage service used by the provider routes. Tests
 * pass fake readers and a fake clock.
 */
export function createProviderSubscriptionUsageService(
  dependencyOverrides: Partial<ProviderSubscriptionUsageServiceDependencies> = {},
) {
  const dependencies: ProviderSubscriptionUsageServiceDependencies = {
    readers: defaultReaders,
    now: Date.now,
    cacheTtlMs: SUBSCRIPTION_USAGE_CACHE_TTL_MS,
    ...dependencyOverrides,
  };
  const cache = new Map<SubscriptionUsageProvider, { value: SubscriptionUsage; storedAt: number }>();
  // Two tabs opening the modal at once share one lookup instead of starting two CLIs.
  const inFlight = new Map<SubscriptionUsageProvider, Promise<SubscriptionUsage>>();

  async function readProvider(provider: SubscriptionUsageProvider, refresh: boolean): Promise<SubscriptionUsage> {
    const cached = cache.get(provider);
    if (!refresh && cached && dependencies.now() - cached.storedAt < dependencies.cacheTtlMs) {
      return cached.value;
    }

    const pending = inFlight.get(provider);
    if (pending) {
      return pending;
    }

    const lookup = (async () => {
      try {
        const value = await dependencies.readers[provider]();
        cache.set(provider, { value, storedAt: dependencies.now() });
        return value;
      } catch (error) {
        // Failures are not cached, so the next open retries.
        return errorUsage(provider, error);
      } finally {
        inFlight.delete(provider);
      }
    })();
    inFlight.set(provider, lookup);
    return lookup;
  }

  return {
    /**
     * Plan quotas of every supported subscription. One provider failing or
     * being absent never hides the others.
     */
    async getSubscriptionUsage(options: { refresh?: boolean } = {}): Promise<SubscriptionUsageReport> {
      const refresh = options.refresh === true;
      const subscriptions = await Promise.all(PROVIDER_ORDER.map((provider) => readProvider(provider, refresh)));
      return { subscriptions };
    },
  };
}

/** Used by the provider routes to serve `GET /api/providers/subscription-usage`. */
export const providerSubscriptionUsageService = createProviderSubscriptionUsageService();
