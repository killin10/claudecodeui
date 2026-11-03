import type { OpenCodeClient, SessionInfo, ModelRef } from '@opencode/client';
import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

/** Used by the agent-state service to reflect native plan/custom agents without starting a host. */
export function readOpenCodeAgent(sessionID: string): string | null {
  const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT agent FROM session_v2 WHERE id = ?').get(sessionID) as { agent: string | null } | undefined;
    return row?.agent ?? null;
  } finally {
    db.close();
  }
}

async function defaultAgent(client: OpenCodeClient, directory: string, signal: AbortSignal): Promise<string> {
  const entries = await client.config.get({ location: { directory } }, { signal });
  let agent = 'build';
  for (const entry of entries) {
    if (entry.type === 'document' && entry.info.default_agent) agent = entry.info.default_agent;
  }
  return agent;
}

function resumedAgent(existing: SessionInfo, mode: unknown, explicit: boolean, configured: string): string {
  if (!explicit) return existing.agent ?? configured;
  if (mode === 'plan') return 'plan';
  if (existing.agent !== 'plan') return existing.agent ?? configured;
  const previous = existing.metadata?.cloudcliPreviousAgent;
  if (typeof previous === 'string' && previous !== 'plan') return previous;
  return configured === 'plan' ? 'build' : configured;
}

/** Runtime session setup keeps ordinary resume separate from an explicit permission-mode change. */
export async function prepareOpenCodeSession(client: OpenCodeClient, input: {
  sessionID: string | null;
  appSessionId: string | null;
  directory: string;
  permissionMode: unknown;
  permissionModeExplicit: boolean;
  model?: ModelRef;
}, signal: AbortSignal): Promise<SessionInfo> {
  const configured = await defaultAgent(client, input.directory, signal);
  if (!input.sessionID) {
    return client.session.create({
      location: { directory: input.directory },
      agent: input.permissionMode === 'plan' ? 'plan' : configured,
      model: input.model,
      metadata: {
        ...(input.appSessionId ? { cloudcliSessionId: input.appSessionId } : {}),
        ...(input.permissionMode === 'plan' ? { cloudcliPreviousAgent: configured === 'plan' ? 'build' : configured } : {}),
      },
    }, { signal });
  }
  const existing = await client.session.get({ sessionID: input.sessionID }, { signal });
  const agent = resumedAgent(existing, input.permissionMode, input.permissionModeExplicit, configured);
  if (agent !== existing.agent) {
    await client.session.update({ sessionID: existing.id, metadata: {
      ...existing.metadata, cloudcliPreviousAgent: agent === 'plan' ? existing.agent ?? configured : null,
    } }, { signal });
    await client.session.switchAgent({ sessionID: existing.id, agent }, { signal });
  }
  if (input.model) await client.session.switchModel({ sessionID: existing.id, model: input.model }, { signal });
  return existing;
}
