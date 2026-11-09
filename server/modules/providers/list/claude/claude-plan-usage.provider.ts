import os from 'node:os';

import { query, type SDKControlGetUsageResponse, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeSdkEnv } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { SubscriptionUsage, SubscriptionUsageWindow } from '@/shared/types.js';

type ClaudeRateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type ClaudeRateLimitWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

/** Starting the CLI on a Raspberry Pi takes a few seconds; a stuck start must not hang the modal. */
const CLAUDE_USAGE_TIMEOUT_MS = 30_000;

function toWindow(
  key: string,
  period: SubscriptionUsageWindow['period'],
  scope: string | null,
  value: ClaudeRateLimitWindow,
): SubscriptionUsageWindow | null {
  if (!value) {
    return null;
  }

  // The endpoint sends microsecond `+00:00` offsets; normalize to the contract's UTC ISO form.
  const resetsAtMs = value.resets_at ? Date.parse(value.resets_at) : Number.NaN;
  return {
    key,
    period,
    windowMinutes: period === 'five_hour' ? 300 : 10_080,
    scope,
    usedPercent: typeof value.utilization === 'number' ? value.utilization : null,
    resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
  };
}

/**
 * Used by this file and the providers tests: turns the SDK's `/usage` answer
 * into the shared contract. Plan-wide 5-hour and weekly windows come first,
 * then the per-model weekly windows the account has.
 */
export function mapClaudePlanUsage(response: Pick<SDKControlGetUsageResponse, 'subscription_type' | 'rate_limits_available' | 'rate_limits'>, observedAt: string): SubscriptionUsage {
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      provider: 'claude',
      status: 'unavailable',
      plan: response.subscription_type ?? null,
      windows: [],
      observedAt,
      message: 'Claude is not signed in with a Claude.ai subscription (API key or third-party provider).',
    };
  }

  const limits: ClaudeRateLimits = response.rate_limits;
  const windows = [
    toWindow('five_hour', 'five_hour', null, limits.five_hour),
    toWindow('seven_day', 'weekly', null, limits.seven_day),
    toWindow('seven_day_opus', 'weekly', 'Opus', limits.seven_day_opus),
    toWindow('seven_day_sonnet', 'weekly', 'Sonnet', limits.seven_day_sonnet),
    ...(limits.model_scoped ?? []).map((entry) =>
      toWindow(`model_${entry.display_name}`, 'weekly', entry.display_name, entry)),
  ].filter((window): window is SubscriptionUsageWindow => window !== null);

  return {
    provider: 'claude',
    status: 'ok',
    plan: response.subscription_type ?? null,
    windows,
    observedAt,
  };
}

/**
 * Used by the provider subscription-usage service to read the Claude.ai plan
 * limits. The SDK's `/usage` control request is answered by a short-lived CLI
 * process, which also owns OAuth token refresh — reading the token ourselves
 * would race the CLI's refresh-token rotation. No prompt is ever sent, so no
 * transcript is written and no quota is spent.
 */
export async function fetchClaudePlanUsage(): Promise<SubscriptionUsage> {
  let releasePrompt: () => void = () => {};
  const promptHeld = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  // The control channel only exists in streaming-input mode; this stream ends
  // without yielding a message once the answer is in.
  const idlePrompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await promptHeld;
        return { done: true, value: undefined };
      },
    }),
  };

  const executablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const usageQuery = query({
    prompt: idlePrompt,
    options: {
      cwd: os.homedir(),
      env: buildClaudeSdkEnv(),
      // No user/project settings: hooks and plugins have no business running for a quota lookup.
      settingSources: [],
      ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    },
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for Claude usage.')), CLAUDE_USAGE_TIMEOUT_MS);
      }),
    ]);
    return mapClaudePlanUsage(response, new Date().toISOString());
  } finally {
    clearTimeout(timer);
    releasePrompt();
    usageQuery.close();
  }
}
