import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { Schedule } from '@/shared/types';

/** Schedules page keeps loaded pages current without allowing an older poll to overwrite a newer mutation. */
export function useSchedules() {
  // Server-owned task records and continuation; never used as a second source of scheduling truth.
  const [page, setPage] = useState<{ items: Schedule[]; nextToken: string | null }>({
    items: [],
    nextToken: null,
  });
  // Distinguishes a failed or initial fetch from a valid empty list.
  const [error, setError] = useState('');
  // Initial loading hides the empty-state text until a response arrives.
  const [loading, setLoading] = useState(true);
  const pages = useRef(1);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      let nextToken: string | null = null;
      const items: Schedule[] = [];
      for (let i = 0; i < pages.current; i++) {
        const result: { items: Schedule[]; nextToken: string | null } = await readApiJson(
          await api.schedules.list(nextToken ?? undefined),
        );
        if (generation.current !== current) return;
        items.push(...result.items);
        nextToken = result.nextToken;
        if (!nextToken) break;
      }
      setPage({ items, nextToken });
      setError('');
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const requestEpoch = generation;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      requestEpoch.current++;
    };
  }, [refresh]);
  return {
    ...page,
    error,
    loading,
    refresh,
    more: () => {
      pages.current++;
      return refresh();
    },
  };
}
