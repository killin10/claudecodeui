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

const nonPlanDefault = (configured: string): string => configured === 'plan' ? 'build' : configured;

function initialAgent(mode: unknown, explicit: boolean, configured: string): string {
  if (mode === 'plan') return 'plan';
  return explicit ? nonPlanDefault(configured) : configured;
}

function resumedAgent(existing: SessionInfo, mode: unknown, explicit: boolean, configured: string): string {
  if (!explicit) return existing.agent ?? configured;
  if (mode === 'plan') return 'plan';
  if (existing.agent !== 'plan') return existing.agent ?? configured;
  const previous = existing.metadata?.cloudcliPreviousAgent;
  if (typeof previous === 'string' && previous !== 'plan') return previous;
  return nonPlanDefault(configured);
}

async function switchAgent(client: OpenCodeClient, existing: SessionInfo, agent: string,
  previousAgent: string, explicit: boolean, signal: AbortSignal): Promise<void> {
  if (agent !== existing.agent) {
    if (agent === 'plan') {
      await client.session.update({ sessionID: existing.id, metadata: {
        ...existing.metadata, cloudcliPreviousAgent: previousAgent,
      } }, { signal });
    }
    await client.session.switchAgent({ sessionID: existing.id, agent }, { signal });
  }
  // Keep recovery metadata until the native switch succeeds. If only this
  // cleanup fails, an explicit retry can clear it without switching again.
  if (explicit && agent !== 'plan' && existing.metadata?.cloudcliPreviousAgent != null) {
    await client.session.update({ sessionID: existing.id, metadata: {
      ...existing.metadata, cloudcliPreviousAgent: null,
    } }, { signal });
  }
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
      agent: initialAgent(input.permissionMode, input.permissionModeExplicit, configured),
      model: input.model,
      metadata: {
        ...(input.appSessionId ? { cloudcliSessionId: input.appSessionId } : {}),
        ...(input.permissionMode === 'plan' ? { cloudcliPreviousAgent: nonPlanDefault(configured) } : {}),
      },
    }, { signal });
  }
  const existing = await client.session.get({ sessionID: input.sessionID }, { signal });
  const agent = resumedAgent(existing, input.permissionMode, input.permissionModeExplicit, configured);
  await switchAgent(client, existing, agent, existing.agent ?? configured, input.permissionModeExplicit, signal);
  if (input.model) {
    const sameModel = input.model.providerID === existing.model?.providerID && input.model.id === existing.model.id;
    const model = sameModel && input.model.variant === undefined && existing.model?.variant
      ? { ...input.model, variant: existing.model.variant } : input.model;
    await client.session.switchModel({ sessionID: existing.id, model }, { signal });
  }
  return existing;
}
