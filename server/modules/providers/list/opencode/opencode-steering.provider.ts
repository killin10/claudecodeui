import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { OpenCodeClient } from '@opencode/client';

import type { AnyRecord } from '@/shared/types.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';

const STEERING_REQUEST_TIMEOUT_MS = 30_000;
const INBOX_WAKE_TIMEOUT_MS = 5000;
const INBOX_DELIVERY_TIMEOUT_MS = 30_000;

/** Owns pending steering input for one OpenCode runtime; never creates another host or session. */
export class OpenCodeSteering {
  private readonly inputs = new Map<string, { messageId: string; delivered: boolean; waking: boolean }>();
  private readonly submissions = new Map<string, Promise<boolean>>();
  private requests = 0;
  private wakeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: {
    client(): OpenCodeClient;
    sessionId(): string;
    directory: string;
    signal: AbortSignal;
    settled(): void;
    fail(error: unknown): void;
    notice(messageId: string, state: 'uncertain' | 'cancelled'): void;
  }) {}

  get pending(): boolean {
    return this.requests > 0 || [...this.inputs.values()].some(input => !input.delivered);
  }

  send(command: string, options: AnyRecord): Promise<boolean> {
    const existing = this.submissions.get(options.messageId);
    if (existing) return existing;
    const submitted = this.submit(command, options);
    this.submissions.set(options.messageId, submitted);
    return submitted;
  }

  private async submit(command: string, options: AnyRecord): Promise<boolean> {
    const id = `msg_${options.messageId.replaceAll('-', '')}`;
    // Install correlation before sending: native delivery can precede the HTTP response.
    this.inputs.set(id, { messageId: options.messageId, delivered: false, waking: false });
    this.requests++;
    const files = [...normalizeAttachmentDescriptors(options.images), ...normalizeAttachmentDescriptors(options.files)]
      .map(file => ({ uri: pathToFileURL(path.resolve(this.context.directory, file.path)).href, name: file.name }));
    try {
      const result = await this.context.client().session.prompt({
        sessionID: this.context.sessionId(), id, text: command, files, delivery: 'steer',
      }, { signal: AbortSignal.any([this.context.signal, AbortSignal.timeout(STEERING_REQUEST_TIMEOUT_MS)]) });
      if (result.id !== id || result.sessionID !== this.context.sessionId()) {
        throw new Error('OpenCode returned an unexpected steering input ID');
      }
      return true;
    } finally {
      this.requests--;
      this.context.settled();
    }
  }

  delivered(id: string): void {
    const input = this.inputs.get(id);
    if (input) input.delivered = true;
    if ([...this.inputs.values()].every(candidate => candidate.delivered)) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  messageId(nativeRowId: string): string | undefined {
    for (const [id, input] of this.inputs) {
      if (input.delivered && (nativeRowId === id || nativeRowId.startsWith(`${id}_`))) return input.messageId;
    }
    return undefined;
  }

  /** A turn may finish just before accepting input. Wake the existing inbox item, never submit it twice. */
  wakePending(): void {
    if (this.requests > 0) return;
    for (const [id, input] of this.inputs) {
      if (input.delivered || input.waking) continue;
      input.waking = true;
      this.wakeTimer ??= setTimeout(() => this.context.fail(new Error('OpenCode steering delivery was not confirmed; check the native inbox before resending.')), INBOX_DELIVERY_TIMEOUT_MS);
      void this.context.client().session.inbox.update({
        sessionID: this.context.sessionId(), inboxID: id, delivery: 'steer',
      }, { signal: AbortSignal.any([this.context.signal, AbortSignal.timeout(INBOX_WAKE_TIMEOUT_MS)]) })
        .catch(error => {
          if (!this.context.signal.aborted) this.context.fail(error);
        });
    }
  }

  cancelled(id: string): void {
    const input = this.inputs.get(id);
    if (!input || input.delivered) return;
    this.inputs.delete(id);
    this.context.notice(input.messageId, 'cancelled');
    if (!this.pending) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    this.context.settled();
  }

  close(): void {
    clearTimeout(this.wakeTimer);
    for (const input of this.inputs.values()) {
      if (!input.delivered) this.context.notice(input.messageId, 'uncertain');
    }
  }
}
