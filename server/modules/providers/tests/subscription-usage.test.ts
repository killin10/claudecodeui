import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { mapClaudePlanUsage } from '@/modules/providers/list/claude/claude-plan-usage.provider.js';
import {
  fetchCodexPlanUsage,
  findCodexPlanUsage,
  mapCodexRateLimitsResponse,
  readCodexPlanUsage,
} from '@/modules/providers/list/codex/codex-plan-usage.provider.js';
import {
  fetchZaiPlanUsage,
  mapZaiQuota,
  readZaiCodingPlanCredential,
} from '@/modules/providers/list/opencode/zai-plan-usage.provider.js';
import { createProviderSubscriptionUsageService } from '@/modules/providers/services/provider-subscription-usage.service.js';
import type { SubscriptionUsage } from '@/shared/types.js';

const OBSERVED_AT = '2026-11-09T16:00:00.000Z';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-usage-'));
}

test('Claude /usage maps plan-wide and per-model windows, and reports API-key logins as unavailable', () => {
  const usage = mapClaudePlanUsage({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 9, resets_at: '2026-11-09T20:30:00Z' },
      seven_day: { utilization: 3, resets_at: '2026-11-14T19:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 12, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: '2026-11-14T19:00:00Z' }],
    },
  }, OBSERVED_AT);

  assert.equal(usage.status, 'ok');
  assert.equal(usage.plan, 'max');
  assert.deepEqual(usage.windows.map((window) => [window.period, window.scope, window.usedPercent]), [
    ['five_hour', null, 9],
    ['weekly', null, 3],
    ['weekly', 'Sonnet', 12],
    ['weekly', 'Fable', 40],
  ]);

  const apiKey = mapClaudePlanUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, OBSERVED_AT);
  assert.equal(apiKey.status, 'unavailable');
  assert.deepEqual(apiKey.windows, []);
});

test('Codex reads the newest rate_limits row, orders 5-hour before weekly, and skips rows without limits', () => {
  const row = (timestamp: string, rateLimits: unknown) => JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: rateLimits },
  });
  const content = [
    row('2026-11-09T10:00:00Z', { limit_id: 'codex', primary: { used_percent: 1, window_minutes: 300, resets_at: 1 }, plan_type: 'plus' }),
    row('2026-11-09T11:00:00Z', {
      limit_id: 'codex',
      primary: { used_percent: 40, window_minutes: 10080, resets_at: 1794844864 },
      secondary: { used_percent: 12.5, window_minutes: 300, resets_at: 1794247214 },
      plan_type: 'pro',
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    '{"partial": "rate_limits',
  ].join('\n');

  const usage = findCodexPlanUsage(content);
  assert.ok(usage);
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.observedAt, '2026-11-09T11:00:00Z');
  assert.deepEqual(usage.windows.map((window) => [window.period, window.usedPercent]), [
    ['five_hour', 12.5],
    ['weekly', 40],
  ]);
  assert.equal(usage.windows[1].resetsAt, new Date(1794844864 * 1000).toISOString());
  assert.equal(findCodexPlanUsage('{"type":"session_meta"}'), null);
});

test('Codex scan walks the newest day folders first and reports unavailable without data', async () => {
  const root = tempDir();
  try {
    assert.equal((await readCodexPlanUsage(root)).status, 'unavailable');

    const olderDay = path.join(root, '2026', '10', '31');
    const newerDay = path.join(root, '2026', '11', '09');
    fs.mkdirSync(olderDay, { recursive: true });
    fs.mkdirSync(newerDay, { recursive: true });
    const limitRow = (percent: number) => JSON.stringify({
      timestamp: 'now',
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: percent, window_minutes: 300 } } },
    });
    fs.writeFileSync(path.join(olderDay, 'rollout-old.jsonl'), `${limitRow(80)}\n`);
    // The newest rollout has no model reply yet, so the scan falls through to the next one.
    fs.writeFileSync(path.join(newerDay, 'rollout-empty.jsonl'), '{"type":"session_meta"}\n');
    fs.writeFileSync(path.join(newerDay, 'rollout-new.jsonl'), `${limitRow(20)}\n`);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(newerDay, 'rollout-new.jsonl'), past, past);

    const usage = await readCodexPlanUsage(root);
    assert.equal(usage.status, 'ok');
    assert.equal(usage.windows[0].usedPercent, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex live rate limits map the plan-wide bucket first, then named buckets', () => {
  const window = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: 1794844865 });
  const usage = mapCodexRateLimitsResponse({
    rateLimits: { limitId: 'codex', primary: window(1, 10080), planType: 'prolite' },
    rateLimitsByLimitId: {
      gpt_spark: { limitId: 'gpt_spark', limitName: 'Spark', primary: window(70, 300), secondary: null },
      codex: { limitId: 'codex', primary: window(40, 10080), secondary: window(12, 300), planType: 'pro' },
    },
  }, OBSERVED_AT);

  assert.ok(usage);
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.observedAt, OBSERVED_AT);
  assert.deepEqual(usage.windows.map((entry) => [entry.key, entry.period, entry.scope, entry.usedPercent]), [
    ['secondary', 'five_hour', null, 12],
    ['primary', 'weekly', null, 40],
    ['gpt_spark_primary', 'five_hour', 'Spark', 70],
  ]);
  assert.equal(usage.windows[1].resetsAt, new Date(1794844865 * 1000).toISOString());

  // Older protocol answers carry only `rateLimits`.
  const single = mapCodexRateLimitsResponse({ rateLimits: { primary: window(5, 300), planType: 'plus' } }, OBSERVED_AT);
  assert.deepEqual(single?.windows.map((entry) => entry.usedPercent), [5]);
  assert.equal(mapCodexRateLimitsResponse(null, OBSERVED_AT), null);
});

test('Codex prefers the live lookup and falls back to the rollout log when it fails', async () => {
  const root = tempDir();
  try {
    const day = path.join(root, '2026', '11', '09');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout.jsonl'), `${JSON.stringify({
      timestamp: '2026-11-09T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 300 } } },
    })}\n`);

    const live = await fetchCodexPlanUsage(root, async () => ({
      rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1 } },
    }));
    assert.equal(live.windows[0].usedPercent, 7);
    assert.notEqual(live.observedAt, '2026-11-09T10:00:00Z');

    const logged = await fetchCodexPlanUsage(root, async () => { throw new Error('not signed in'); });
    assert.equal(logged.windows[0].usedPercent, 33);
    assert.equal(logged.observedAt, '2026-11-09T10:00:00Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z.ai quota maps token windows by unit and MCP calls as a counted monthly quota', () => {
  const usage = mapZaiQuota({
    success: true,
    data: {
      level: 'max',
      limits: [
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 38, percentage: 1, nextResetTime: 1796035590998 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 46, nextResetTime: 1794472680977 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1794247214967 },
      ],
    },
  }, OBSERVED_AT);

  assert.equal(usage.plan, 'max');
  assert.deepEqual(usage.windows.map((window) => [window.period, window.scope, window.usedPercent]), [
    ['five_hour', null, 1],
    ['weekly', null, 46],
    ['monthly', 'MCP', 1],
  ]);
  assert.equal(usage.windows[2].used, 38);
  assert.equal(usage.windows[2].limit, 4000);
  assert.equal(usage.windows[0].resetsAt, new Date(1794247214967).toISOString());
});

test('Z.ai key comes from the OpenCode credential table, then auth.json, and the request uses the matching host', async () => {
  const dir = tempDir();
  const databasePath = path.join(dir, 'opencode.db');
  const authFilePath = path.join(dir, 'auth.json');
  try {
    assert.equal(await readZaiCodingPlanCredential(databasePath, authFilePath), null);

    fs.writeFileSync(authFilePath, JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'intl-key' } }));
    assert.deepEqual(await readZaiCodingPlanCredential(databasePath, authFilePath), {
      integrationId: 'zai-coding-plan',
      apiKey: 'intl-key',
    });

    const database = new Database(databasePath);
    database.exec(`CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER)`);
    database.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?, 0, ?)').run(
      'c1', 'zhipuai-coding-plan', 'Zhipu', JSON.stringify({ type: 'key', key: 'cn-key' }), 1, 1,
    );
    database.close();

    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, authorization: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ success: true, data: { level: 'pro', limits: [] } }), { status: 200 });
    }) as typeof fetch;
    const usage = await fetchZaiPlanUsage(databasePath, authFilePath, fakeFetch);
    assert.equal(usage.status, 'ok');
    assert.deepEqual(requests, [{
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      authorization: 'cn-key',
    }]);

    const failingFetch = (async () => new Response(JSON.stringify({ success: false, msg: 'bad key' }), { status: 401 })) as typeof fetch;
    await assert.rejects(fetchZaiPlanUsage(databasePath, authFilePath, failingFetch), /bad key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service caches per provider, shares in-flight lookups, isolates failures and refreshes on demand', async () => {
  let clock = 0;
  const calls = { claude: 0, codex: 0, zai: 0 };
  const ok = (provider: SubscriptionUsage['provider']): SubscriptionUsage => ({
    provider, status: 'ok', plan: null, windows: [], observedAt: null,
  });
  const service = createProviderSubscriptionUsageService({
    now: () => clock,
    cacheTtlMs: 1000,
    readers: {
      claude: async () => { calls.claude += 1; return ok('claude'); },
      codex: async () => { calls.codex += 1; return ok('codex'); },
      zai: async () => { calls.zai += 1; throw new Error('network down'); },
    },
  });

  const [first] = await Promise.all([service.getSubscriptionUsage(), service.getSubscriptionUsage()]);
  assert.deepEqual(first.subscriptions.map((usage) => [usage.provider, usage.status]), [
    ['claude', 'ok'],
    ['codex', 'ok'],
    ['zai', 'error'],
  ]);
  assert.equal(first.subscriptions[2].message, 'network down');
  assert.deepEqual(calls, { claude: 1, codex: 1, zai: 1 });

  clock = 500;
  await service.getSubscriptionUsage();
  // Successes stay cached; the failure is retried.
  assert.deepEqual(calls, { claude: 1, codex: 1, zai: 2 });

  await service.getSubscriptionUsage({ refresh: true });
  assert.deepEqual(calls, { claude: 2, codex: 2, zai: 3 });

  clock = 2000;
  await service.getSubscriptionUsage();
  assert.deepEqual(calls, { claude: 3, codex: 3, zai: 4 });
});
