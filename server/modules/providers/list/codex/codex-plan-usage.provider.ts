import fsp from 'node:fs/promises';
import path from 'node:path';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { AnyRecord, SubscriptionUsage, SubscriptionUsageWindow } from '@/shared/types.js';

/** The newest rate-limit row sits at the end of a rollout; this much tail always holds the last turns. */
const ROLLOUT_TAIL_BYTES = 1024 * 1024;

/** Rollouts checked newest-first before giving up; a session that never got a model reply has no row. */
const MAX_ROLLOUTS_SCANNED = 20;

const FIVE_HOURS_IN_MINUTES = 300;
const ONE_WEEK_IN_MINUTES = 10_080;

function periodOf(windowMinutes: number | undefined): SubscriptionUsageWindow['period'] {
  if (windowMinutes === FIVE_HOURS_IN_MINUTES) return 'five_hour';
  if (windowMinutes === ONE_WEEK_IN_MINUTES) return 'weekly';
  return 'custom';
}

type RawWindow = { usedPercent: unknown; windowMinutes: unknown; resetsAtSeconds: unknown };

function toWindow(key: string, scope: string | null, raw: RawWindow | null): SubscriptionUsageWindow | null {
  if (!raw) {
    return null;
  }

  const windowMinutes = Number.isFinite(raw.windowMinutes) ? Number(raw.windowMinutes) : undefined;
  const resetsAtSeconds = Number(raw.resetsAtSeconds);
  return {
    key,
    period: periodOf(windowMinutes),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    scope,
    usedPercent: Number.isFinite(raw.usedPercent) ? Number(raw.usedPercent) : null,
    resetsAt: Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0
      ? new Date(resetsAtSeconds * 1000).toISOString()
      : null,
  };
}

/** Rollout logs write snake_case windows. */
function fromLogWindow(value: unknown): RawWindow | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as AnyRecord;
  return { usedPercent: record.used_percent, windowMinutes: record.window_minutes, resetsAtSeconds: record.resets_at };
}

/** The app-server protocol writes camelCase windows. */
function fromRpcWindow(value: unknown): RawWindow | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as AnyRecord;
  return { usedPercent: record.usedPercent, windowMinutes: record.windowDurationMins, resetsAtSeconds: record.resetsAt };
}

/** 5-hour before weekly regardless of which slot Codex used. */
const byWindowLength = (left: SubscriptionUsageWindow, right: SubscriptionUsageWindow) =>
  (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0);

/**
 * Used by this file and the providers tests: maps an `account/rateLimits/read`
 * answer. The plan-wide `codex` bucket comes first; any other bucket (a
 * model-specific limit) is labelled with its name.
 */
export function mapCodexRateLimitsResponse(result: unknown, observedAt: string): SubscriptionUsage | null {
  const record = result && typeof result === 'object' ? result as AnyRecord : null;
  const byId = record?.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === 'object'
    ? Object.values(record.rateLimitsByLimitId as AnyRecord)
    : [];
  const buckets = (byId.length > 0 ? byId : [record?.rateLimits])
    .filter((bucket): bucket is AnyRecord => Boolean(bucket) && typeof bucket === 'object');
  if (buckets.length === 0) {
    return null;
  }

  const planWide = (bucket: AnyRecord) => !bucket.limitId || bucket.limitId === 'codex';
  const windows = [...buckets]
    .sort((left, right) => Number(!planWide(left)) - Number(!planWide(right)))
    .flatMap((bucket) => {
      const scope = planWide(bucket) ? null : String(bucket.limitName || bucket.limitId);
      const prefix = planWide(bucket) ? '' : `${bucket.limitId}_`;
      return [
        toWindow(`${prefix}primary`, scope, fromRpcWindow(bucket.primary)),
        toWindow(`${prefix}secondary`, scope, fromRpcWindow(bucket.secondary)),
      ]
        .filter((window): window is SubscriptionUsageWindow => window !== null)
        .sort(byWindowLength);
    });
  const plan = buckets.find(planWide)?.planType ?? buckets[0].planType;

  return {
    provider: 'codex',
    status: 'ok',
    plan: typeof plan === 'string' ? plan : null,
    windows,
    observedAt,
  };
}

/**
 * Used by this file and the providers tests: the newest `rate_limits` snapshot
 * in rollout JSONL text, mapped to the shared contract, or null when the text
 * has none. Codex attaches the snapshot to every `token_count` event.
 */
export function findCodexPlanUsage(fileContent: string): SubscriptionUsage | null {
  const lines = fileContent.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"rate_limits"')) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      // Codex may be writing the last line while it is read.
      continue;
    }

    const rateLimits = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
      ? entry.payload.rate_limits
      : null;
    if (!rateLimits || typeof rateLimits !== 'object') {
      continue;
    }

    // `codex` is the plan-wide bucket; any other id is a narrower one, labelled by its name.
    const scope = rateLimits.limit_id && rateLimits.limit_id !== 'codex'
      ? String(rateLimits.limit_name || rateLimits.limit_id)
      : null;
    const windows = [
      toWindow('primary', scope, fromLogWindow(rateLimits.primary)),
      toWindow('secondary', scope, fromLogWindow(rateLimits.secondary)),
    ]
      .filter((window): window is SubscriptionUsageWindow => window !== null)
      .sort(byWindowLength);

    return {
      provider: 'codex',
      status: 'ok',
      plan: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null,
      windows,
      observedAt: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    };
  }

  return null;
}

async function readTail(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listDescending(directoryPath: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Newest rollout files under Codex's `YYYY/MM/DD` session tree, newest first.
 * Walks day folders from the latest down and stops once enough files are found,
 * so the cost does not grow with the length of the history.
 */
async function listRecentRollouts(sessionsRoot: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  for (const year of await listDescending(sessionsRoot)) {
    for (const month of await listDescending(path.join(sessionsRoot, year))) {
      for (const day of await listDescending(path.join(sessionsRoot, year, month))) {
        const dayPath = path.join(sessionsRoot, year, month, day);
        let names: string[];
        try {
          names = (await fsp.readdir(dayPath)).filter((name) => name.endsWith('.jsonl'));
        } catch {
          continue;
        }

        const dated = await Promise.all(names.map(async (name) => {
          const filePath = path.join(dayPath, name);
          try {
            return { filePath, modifiedAt: (await fsp.stat(filePath)).mtimeMs };
          } catch {
            return null;
          }
        }));
        files.push(...dated
          .filter((file): file is { filePath: string; modifiedAt: number } => file !== null)
          .sort((left, right) => right.modifiedAt - left.modifiedAt)
          .map((file) => file.filePath));
        if (files.length >= limit) {
          return files.slice(0, limit);
        }
      }
    }
  }
  return files;
}

/**
 * Used by this file and the providers tests: the fallback when the live lookup
 * fails. Every model reply logs the plan's rate limits into the rollout, so the
 * newest logged snapshot is the freshest local answer; `observedAt` tells the
 * UI how old it is.
 */
export async function readCodexPlanUsage(sessionsRoot: string): Promise<SubscriptionUsage> {
  for (const filePath of await listRecentRollouts(sessionsRoot, MAX_ROLLOUTS_SCANNED)) {
    try {
      const usage = findCodexPlanUsage(await readTail(filePath));
      if (usage) {
        return usage;
      }
    } catch {
      // A rollout removed mid-scan is simply skipped.
    }
  }

  return {
    provider: 'codex',
    status: 'unavailable',
    plan: null,
    windows: [],
    observedAt: null,
    message: 'Codex usage is unavailable: the live lookup failed (signed out or Codex unreachable) and no rate-limit data has been logged yet.',
  };
}

/**
 * Used by the provider subscription-usage service. Asks a short-lived Codex
 * app-server for the live limits (no turn, no quota spent; Codex refreshes its
 * own login), and falls back to the newest snapshot in the rollout logs when
 * Codex is missing, signed out or unreachable.
 */
export async function fetchCodexPlanUsage(
  sessionsRoot: string,
  readLiveRateLimits: () => Promise<unknown> = () => codexAppServer.readRateLimits(),
): Promise<SubscriptionUsage> {
  try {
    const live = mapCodexRateLimitsResponse(await readLiveRateLimits(), new Date().toISOString());
    if (live) {
      return live;
    }
  } catch {
    // Fall through to the logged snapshot.
  }
  return readCodexPlanUsage(sessionsRoot);
}
