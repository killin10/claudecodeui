import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
async function nativeOpenTranscripts(): Promise<string[] | null> {
  // Restrict the process selection to Codex. Merely finding a rollout on disk
  // proves no liveness; lsof supplies positive evidence of a live writer.
  try {
    const { stdout } = await execFileAsync('lsof', ['-n', '-P', '-Fn', '-c', 'codex'], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    return [...new Set(stdout.split('\n').filter(line => line.startsWith('n') && line.includes('/sessions/') && line.endsWith('.jsonl')).map(line => line.slice(1)))].slice(0, 256);
  } catch (error) {
    // lsof returns 1 when no matching process exists. Other probe failures are
    // explicitly unavailable and must not leave old busy markers behind.
    if ((error as {
      code?: number;
    }).code === 1) {
      return [];
    }
    console.warn('[Codex] External CLI observation unavailable:', error);
    return null;
  }
}
async function readBusyTurn(filePath: string): Promise<number | null> {
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    let end = size;
    let suffix = '';
    while (end > 0 && size - end < MAX_TAIL_BYTES) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const bytes = Buffer.alloc(end - start);
      await file.read(bytes, 0, bytes.length, start);
      const lines = (bytes.toString('utf8') + suffix).split('\n');
      suffix = start > 0 ? lines.shift() ?? '' : '';
      for (let index = lines.length - 1; index >= 0; index--) {
        let row;
        try {
          row = JSON.parse(lines[index]);
        } catch {
          continue;
        }
        if (row.type !== 'event_msg') {
          continue;
        }
        if (['task_complete', 'turn_aborted', 'turn_failed'].includes(row.payload?.type)) {
          return null;
        }
        if (row.payload?.type === 'task_started') {
          const time = Date.parse(row.timestamp);
          return Number.isFinite(time) ? time : null;
        }
      }
      end = start;
    }
    return null;
  } finally {
    await file.close();
  }
}
/** Read-only observer. Tests inject open-file evidence; disk timestamps alone never imply activity. */
export function createCodexCliLivenessReader(listOpenFiles = nativeOpenTranscripts) {
  let pending: Promise<Array<{
    providerSessionId: string;
    startedAt: number;
  }>> | undefined;
  return () => {
    pending ??= (async () => {
      const result: Array<{
        providerSessionId: string;
        startedAt: number;
      }> = [];
      for (const filePath of await listOpenFiles() ?? []) {
        const id = /([a-f0-9-]{36})\.jsonl$/i.exec(path.basename(filePath))?.[1];
        if (!id) {
          continue;
        }
        try {
          const startedAt = await readBusyTurn(filePath);
          if (startedAt !== null) {
            result.push({ providerSessionId: id, startedAt });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[Codex] Cannot inspect live transcript:', error);
          }
        }
      }
      return result;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
/** Running Sessions combines this evidence with app-owned Codex runs. */
export const listBusyCodexCliSessions = createCodexCliLivenessReader();
let ownerSnapshot: Promise<Set<string> | null> | undefined;
let ownerSnapshotAt = 0;
/** History uses positive process ownership to retire orphaned agents after a crash. Null means probe unavailable. */
export function readCodexOwnedThreadIds(): Promise<Set<string> | null> {
  if (!ownerSnapshot || Date.now() - ownerSnapshotAt > 2000) {
    ownerSnapshotAt = Date.now();
    ownerSnapshot = nativeOpenTranscripts().then(files => files === null ? null : new Set(files.flatMap(file => {
      const id = /([a-f0-9-]{36})\.jsonl$/i.exec(path.basename(file))?.[1];
      return id ? [id] : [];
    })));
  }
  return ownerSnapshot;
}
