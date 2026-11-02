import type Database from 'better-sqlite3';
import type { OpenCodeClient } from '@opencode/client';

import type { AnyRecord } from '@/shared/types.js';
import { readJsonRecord } from '@/shared/utils.js';

const usageOf = (tokens: AnyRecord) => {
  const inputTokens = Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
  const outputTokens = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
  return { used: inputTokens + outputTokens, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } };
};

/** Used by OpenCode live events, history and the token endpoint; one request is not the cumulative bill. */
export function readOpenCodeUsage(db: Database.Database, sessionId: string) {
  const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(sessionId) as AnyRecord | undefined;
  if (!row) return undefined;
  const latest = db.prepare(`
    SELECT type, data FROM session_message WHERE session_id = ?
      AND ((type = 'assistant' AND json_type(data, '$.tokens') = 'object')
        OR (type = 'compaction' AND json_extract(data, '$.status') = 'completed'))
    ORDER BY seq DESC LIMIT 1
  `).get(sessionId) as { type: string; data: string } | undefined;
  const message = readJsonRecord(latest?.data);
  // Compaction's tokens describe the summarization request, not its new context.
  // Until the next model request measures it, explicitly report unavailable.
  const contextUnavailable = !message || latest?.type === 'compaction';
  const model = message?.model ?? readJsonRecord(row.model);
  const limits = readJsonRecord(row.metadata)?.cloudcliModelContextWindows;
  const total = limits?.[`${model?.providerID}/${model?.id}`];
  const cumulative = usageOf({
    input: row.tokens_input, output: row.tokens_output, reasoning: row.tokens_reasoning,
    cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
  });
  return {
    ...usageOf(contextUnavailable ? {} : message.tokens),
    ...(Number.isFinite(total) && total > 0 ? { total } : {}),
    contextUnavailable,
    cumulative: { ...cumulative, ...(typeof row.cost === 'number' ? { cost: row.cost } : {}) },
  };
}

/** Runtime records the native model catalog's windows so history remains accurate after a CloudCLI restart. */
export async function recordOpenCodeContextWindows(client: OpenCodeClient, sessionID: string, directory: string, signal: AbortSignal): Promise<void> {
  const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) };
  const catalog = await client.model.list({ location: { directory } }, options);
  const windows = Object.fromEntries(catalog.data
    .filter((model) => Number.isFinite(model.limit.context) && model.limit.context > 0)
    .map((model) => [`${model.providerID}/${model.id}`, model.limit.context]));
  if (Object.keys(windows).length === 0) return;
  const session = await client.session.get({ sessionID }, options);
  await client.session.update({ sessionID, metadata: { ...session.metadata, cloudcliModelContextWindows: windows } }, options);
}
