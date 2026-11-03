import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
const REQUEST_TIMEOUT_MS = 30000;
type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: AnyRecord;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};
/** Fork service result; the native server owns the persisted transcript path. */
type CodexThreadFork = {
  threadId: string;
  path: string;
};
/**
 * One owned app-server process. Handles bidirectional requests and notifications;
 * closing it rejects pending calls and notifies the run instead of hanging it.
 */
export class CodexRpcConnection {
  private readonly child;
  private readonly reader;
  private nextId = 1;
  private closed = false;
  private diagnostic = '';
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private constructor() {
    const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    this.child = spawn(process.execPath, [launcher, 'app-server'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', line => this.receive(line));
    this.child.on('error', error => this.close(error));
    this.child.on('exit', (code, signal) => this.close(new Error(`Codex app-server exited (${code ?? signal}): ${this.diagnostic.trim().split('\n').at(-1) ?? ''}`)));
    this.child.stdin.on('error', error => this.close(error));
    this.child.stdout.on('error', error => this.close(error));
    // Consume diagnostics without exposing credentials or unrelated CLI warnings.
    this.child.stderr.on('data', chunk => {
      this.diagnostic = (this.diagnostic + String(chunk)).slice(-2000);
    });
    this.child.stderr.on('error', error => this.close(error));
  }
  static async open(): Promise<CodexRpcConnection> {
    const connection = new CodexRpcConnection();
    try {
      await connection.call('initialize', {
        clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
        capabilities: { experimentalApi: true },
      });
      connection.write({ method: 'initialized', params: {} });
      return connection;
    } catch (error) {
      await connection.dispose();
      throw error;
    }
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  call(method: string, params: unknown): Promise<any> {
    if (this.closed) {
      return Promise.reject(new Error('Codex app-server is closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Codex app-server timed out: ${method}`)), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params: params as AnyRecord });
    });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  rejectRequest(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  close(error = new Error('Codex app-server connection closed')): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.reader.close();
    this.child.kill();
    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.listeners.clear();
    this.closeListeners.clear();
  }

  async dispose(): Promise<void> {
    this.close();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private write(message: RpcMessage): void {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid RPC envelope');
      }
      message = parsed;
    } catch {
      this.close(new Error('Invalid JSON from Codex app-server'));
      return;
    }
    // Request ids are independent in each direction. A server request must
    // never resolve one of our calls merely because its number happens to match.
    if (message.method) {
      try {
        for (const listener of this.listeners) {
          listener(message);
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!entry) {
      return;
    }
    this.pending.delete(message.id as number);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(message.error.message || 'Codex request failed'));
    } else {
      entry.resolve(message.result);
    }
  }
}
async function withAppServer<T>(run: (connection: CodexRpcConnection) => Promise<T>): Promise<T> {
  const connection = await codexAppServer.connect();
  try {
    return await run(connection);
  } finally {
    await connection.dispose();
  }
}
/** Native Codex transport used by runs, forks and skill discovery. */
export const codexAppServer = {
  connect: () => CodexRpcConnection.open(),
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (connection) => {
      const call = connection.call.bind(connection);
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as {
        thread?: {
          id?: unknown;
          path?: unknown;
        };
      } | undefined;
      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }
      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }
      return { threadId, path };
    });
  },
};
