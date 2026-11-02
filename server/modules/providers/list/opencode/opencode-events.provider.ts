import type { OpenCodeEvent } from '@opencode/client';

import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/** Used by the OpenCode runtime to project transient V2 events without fetching a message per token. */
export class OpenCodeEventProjector {
  private readonly parts = new Map<string, { content: string; timestamp: string }>();
  private readonly finishedParts = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private compactId: string | undefined;

  constructor(
    private readonly sessionId: () => string,
    private readonly send: (message: NormalizedMessage) => void,
  ) {}

  publish(message: NormalizedMessage): void {
    const fingerprint = JSON.stringify(message);
    if (this.fingerprints.get(message.id) === fingerprint) return;
    this.fingerprints.set(message.id, fingerprint);
    this.send(message);
  }

  handle(event: OpenCodeEvent): boolean {
    switch (event.type) {
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const { assistantMessageID, ordinal, delta } = event.data;
        const id = `${assistantMessageID}_${event.type === 'session.text.delta' ? 'text' : 'reasoning'}_${ordinal}`;
        if (this.finishedParts.has(id)) return true;
        const part = this.parts.get(id) ?? { content: '', timestamp: new Date(event.created).toISOString() };
        part.content += delta;
        this.parts.set(id, part);
        this.publish(createNormalizedMessage({
          id, sessionId: this.sessionId(), provider: 'opencode', timestamp: part.timestamp,
          kind: event.type === 'session.text.delta' ? 'text' : 'thinking',
          role: 'assistant', content: part.content,
        }));
        return true;
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const id = `${event.data.assistantMessageID}_${event.type === 'session.text.ended' ? 'text' : 'reasoning'}_${event.data.ordinal}`;
        this.finishedParts.add(id);
        this.parts.delete(id);
        return false; // The persisted message supplies the authoritative final text.
      }
      case 'session.compaction.started':
      case 'session.compaction.ended':
      case 'session.compaction.failed': {
        this.compactId ??= `${('inputID' in event.data ? event.data.inputID : undefined) ?? event.id.replace(/^evt_/, 'msg_')}_0`;
        const phase = event.type === 'session.compaction.started' ? 'running'
          : event.type === 'session.compaction.ended' ? 'done' : 'failed';
        const error = event.type === 'session.compaction.failed' ? event.data.error.message : undefined;
        this.publish(createNormalizedMessage({
          id: this.compactId, sessionId: this.sessionId(), provider: 'opencode',
          kind: 'text', role: 'assistant',
          content: phase === 'running' ? 'Compacting conversation…'
            : phase === 'done' && event.type === 'session.compaction.ended' ? event.data.text || 'Conversation compacted' : `Compaction failed: ${error}`,
          compact: { phase, trigger: event.data.reason, ...(error ? { error } : {}) },
        }));
        if (phase !== 'running') this.compactId = undefined;
        return true;
      }
      case 'session.retry.scheduled':
        this.publish(createNormalizedMessage({
          id: `retry_${event.data.assistantMessageID}`, sessionId: this.sessionId(), provider: 'opencode',
          kind: 'status', text: `Retry ${event.data.attempt}: ${event.data.error.message}`,
        }));
        return true;
      default:
        return false;
    }
  }
}
