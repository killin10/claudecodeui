import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

/** Builds the read-only external CLI observer; tests supply a temporary service registration. */
export function createOpenCodeCliLivenessReader(options: { file?: string; now?: () => number } = {}) {
  const observed = new Map<string, number>();
  const now = options.now ?? Date.now;
  let pending: Promise<Array<{ providerSessionId: string; startedAt: number }>> | undefined;

  async function read() {
    try {
      // discover verifies the registered owner's health, PID and version. Never
      // ensure/start a host here: active executions are process-local in V2.
      const endpoint = await Service.discover({
        file: options.file,
        version: (version) => /^2\./.test(version),
      });
      if (!endpoint) {
        observed.clear();
        return [];
      }
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      const active = await client.session.active({ signal: AbortSignal.timeout(2000) });
      const ids = new Set(Object.entries(active).filter(([, state]) => state.type === 'running').map(([id]) => id));
      for (const id of observed.keys()) {
        if (!ids.has(id)) observed.delete(id);
      }
      return Array.from(ids, (providerSessionId) => {
        // The active endpoint has no start timestamp. Keep first-observed time
        // stable until idle rather than inventing it from transcript activity.
        const startedAt = observed.get(providerSessionId) ?? now();
        observed.set(providerSessionId, startedAt);
        return { providerSessionId, startedAt };
      });
    } catch (error) {
      // This optional indicator needs positive live evidence. Failed probes
      // must not leave old busy markers behind or fail the whole sidebar poll.
      observed.clear();
      console.warn('[OpenCode] External CLI status is unavailable:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  return () => {
    pending ??= read().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Sessions service uses the existing registered V2 service to observe external CLI turns. */
export const listBusyOpenCodeCliSessions = createOpenCodeCliLivenessReader();
