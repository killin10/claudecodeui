import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SubscriptionUsageReport } from '@/shared/types';

type LoadedSubscriptionUsage = {
  report: SubscriptionUsageReport;
  /** Client clock when the report arrived; reset countdowns are measured from it. */
  receivedAt: number;
};

/**
 * Loads the Claude / Codex / Z.ai plan quotas for the Token Usage modal. Reads
 * once on mount; `refresh` asks the server to skip its one-minute cache.
 */
export function useSubscriptionUsage() {
  // The last report; kept while a refresh runs so the cards do not blank out.
  const [loaded, setLoaded] = useState<LoadedSubscriptionUsage | null>(null);
  // True while a request is in flight, to show the spinner and disable Refresh.
  const [isLoading, setIsLoading] = useState(true);
  // Set when the request itself failed (per-provider failures arrive inside the report).
  const [hasError, setHasError] = useState(false);
  // Ignores answers that land after the modal closed or after a newer request started.
  const requestIdRef = useRef(0);

  // Sets state only after the request settles; callers flip `isLoading` on themselves.
  const request = useCallback(async (refresh: boolean) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const body = await readApiJson<{ data: SubscriptionUsageReport }>(await api.providers.subscriptionUsage(refresh));
      if (requestIdRef.current === requestId) {
        setLoaded({ report: body.data, receivedAt: Date.now() });
        setHasError(false);
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setHasError(true);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void request(false);
    return () => {
      // Invalidate any pending answer on unmount.
      requestIdRef.current += 1;
    };
  }, [request]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    return request(true);
  }, [request]);

  return {
    report: loaded?.report ?? null,
    receivedAt: loaded?.receivedAt ?? 0,
    isLoading,
    hasError,
    refresh,
  };
}
