import os from 'node:os';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string, workspacePath?: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    const status = await provider.auth.getStatus();
    // A saved account and a runnable project are different facts. Only explicit
    // project checks start native discovery; ordinary installation probes stay cheap.
    if (providerName !== 'opencode' || workspacePath === undefined) return status;
    const directory = path.resolve(workspacePath || os.homedir());
    if (!status.installed) {
      return { ...status, projectAvailability: { directory, modelCount: null, error: 'OpenCode CLI is not installed.' } };
    }
    try {
      const models = await provider.models.getSupportedModels(directory);
      return { ...status, projectAvailability: { directory, modelCount: models.OPTIONS.length } };
    } catch (error) {
      console.error('[OpenCode] Project model availability check failed:', error);
      return { ...status, projectAvailability: { directory, modelCount: null, error: 'Could not check project models. Retry the check.' } };
    }
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
