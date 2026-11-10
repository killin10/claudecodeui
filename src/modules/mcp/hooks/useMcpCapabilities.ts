import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { McpProvider, ProviderCapabilities, ProviderMcpCapabilities } from '@/shared/types';

type CapabilitiesApiResponse = {
  success?: boolean;
  data?: { providers?: ProviderCapabilities[] };
};

/** Per-provider MCP capabilities keyed by provider id, or null until the capabilities request has resolved. */
export type McpCapabilitiesByProvider = Partial<Record<McpProvider, ProviderMcpCapabilities>>;

// Capabilities are static for a server process, so one request per page
// lifetime is enough; the settings dialog remounts often and should not refetch.
let cachedCapabilities: McpCapabilitiesByProvider | null = null;
let inflight: Promise<McpCapabilitiesByProvider> | null = null;

const loadMcpCapabilities = (): Promise<McpCapabilitiesByProvider> => {
  if (cachedCapabilities) {
    return Promise.resolve(cachedCapabilities);
  }
  if (!inflight) {
    inflight = (async () => {
      const response = await api.providers.capabilities();
      const body = (await response.json()) as CapabilitiesApiResponse;
      if (!response.ok || !body.success || !Array.isArray(body.data?.providers)) {
        throw new Error('Failed to load provider capabilities');
      }
      const byProvider: McpCapabilitiesByProvider = {};
      body.data.providers.forEach((capabilities) => {
        if (capabilities.mcp) {
          byProvider[capabilities.provider] = capabilities.mcp;
        }
      });
      cachedCapabilities = byProvider;
      return byProvider;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
};

/**
 * Loads which scopes, transports and extra fields each provider's MCP config
 * can hold. The MCP settings page and its form read this instead of a
 * frontend table so a provider change on the backend needs no UI change.
 */
export function useMcpCapabilities() {
  // Null until loaded: the form and the provider chips wait for it rather than
  // guessing what a provider accepts.
  const [capabilities, setCapabilities] = useState<McpCapabilitiesByProvider | null>(cachedCapabilities);
  // Shown in place of the list when the capabilities request fails, since nothing below can work without it.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadMcpCapabilities()
      .then((loaded) => {
        if (!cancelled) {
          setCapabilities(loaded);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load provider capabilities');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { capabilities, error };
}
