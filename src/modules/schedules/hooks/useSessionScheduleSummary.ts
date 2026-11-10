import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useOptionalWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent, SessionScheduleSummary } from '@/shared/types';

type Summary = Map<string, SessionScheduleSummary>;

// One copy for the whole page: every sidebar row reads it, and a change announced
// over the websocket reloads it once rather than once per row.
let summary: Summary | null = null;
let inflight: Promise<Summary> | null = null;
const listeners = new Set<(next: Summary) => void>();

const load = (): Promise<Summary> => {
  if (!inflight) {
    inflight = (async () => {
      try {
        const body = await readApiJson<{ items: SessionScheduleSummary[] }>(await api.schedules.summary());
        summary = new Map(body.items.map((item) => [item.sessionId, item]));
      } catch {
        // A failed read keeps the last known counts; the sidebar must not lose
        // its indicators because one request failed.
        summary ??= new Map();
      } finally {
        inflight = null;
      }
      listeners.forEach((listener) => listener(summary as Summary));
      return summary as Summary;
    })();
  }
  return inflight;
};

/**
 * How many scheduled tasks one session has, for the sidebar's indicator next to
 * the session. Null until the first read answers. Reloaded when the server
 * announces a schedule change and after a websocket reconnect.
 */
export function useSessionScheduleSummary(sessionId: string): SessionScheduleSummary | null {
  // The row's own slice of the shared summary; null until the shared read has answered once.
  const [entry, setEntry] = useState<SessionScheduleSummary | null>(() => summary?.get(sessionId) ?? null);
  const socket = useOptionalWebSocket();
  const subscribe = socket?.subscribe;

  useEffect(() => {
    const listener = (next: Summary) => setEntry(next.get(sessionId) ?? null);
    listeners.add(listener);
    if (summary) {
      listener(summary);
    } else {
      void load();
    }
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event: ServerEvent) => {
      if (event.kind === 'schedules_changed' || event.kind === 'websocket_reconnected') {
        void load();
      }
    });
  }, [subscribe]);

  return entry;
}
