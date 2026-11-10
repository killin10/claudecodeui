import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useOptionalWebSocket } from '@/shared/context/WebSocketContext';
import type { Schedule, ServerEvent } from '@/shared/types';

/** Realtime kinds after which the list is read again. The ids in the frame are not used: the page re-reads its own view. */
const REFRESH_KINDS = new Set(['schedules_changed', 'session_submission_changed', 'websocket_reconnected']);

/**
 * Schedules page keeps loaded pages current. Changes arrive over the chat
 * websocket (schedule edits, triggers, run progress); a slow safety poll covers
 * a frame lost while the socket was down. An older response never overwrites a
 * newer mutation.
 */
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
  // Optional so the page also renders (without live updates) outside the websocket provider, as in tests.
  const socket = useOptionalWebSocket();
  const subscribe = socket?.subscribe;

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
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      clearInterval(timer);
      // Invalidates any response still in flight for the unmounted page.
      requestEpoch.current++;
    };
  }, [refresh]);

  useEffect(() => {
    if (!subscribe) return;
    // Several frames can land together (a trigger and the run it queues); one read serves them all.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (!REFRESH_KINDS.has(String(event.kind))) return;
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void refresh();
      }, 150);
    });
    return () => {
      unsubscribe();
      if (pending) clearTimeout(pending);
    };
  }, [refresh, subscribe]);

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
