import type { AnyRecord } from '@/shared/types.js';

/** The rollout reader uses this to fold compaction lifecycle records into one row. */
export class CodexCompactionHistory {
  private readonly rows = new Map<string, AnyRecord>();
  private readonly legacy = new Map<string, AnyRecord>();

  constructor(private readonly messages: AnyRecord[]) {}

  observe(payload: AnyRecord, timestamp: string, turnId: string | null | undefined): boolean {
    const turn = payload.turn_id ?? turnId ?? 'unknown';
    if (payload.type === 'context_compacted') {
      const pending = [...this.rows.values()].reverse().find(row => row.turnId === turn && row.phase === 'running');
      if (pending) {
        pending.phase = 'done';
        return true;
      }
      if (this.legacy.has(turn) || [...this.rows.values()].some((row) => row.turnId === turn && row.phase === 'done')) return true;
      const row = { type: 'compaction', uuid: `compact_${turn}_${timestamp}`, phase: 'done', timestamp, turnId: turn };
      this.messages.push(row);
      this.legacy.set(turn, row);
      return true;
    }
    if ((payload.type === 'item_started' || payload.type === 'item_completed') && payload.item?.type === 'ContextCompaction') {
      const id = payload.item.id;
      const previous = this.rows.get(id) ?? this.legacy.get(turn);
      const row = previous ?? {};
      Object.assign(row, { type: 'compaction', uuid: id, turnId: turn,
        phase: payload.type === 'item_started' ? 'running' : 'done',
        timestamp: previous?.timestamp ?? timestamp,
        startedAtMs: payload.started_at_ms ?? previous?.startedAtMs,
        completedAtMs: payload.completed_at_ms,
      });
      if (!previous) this.messages.push(row);
      this.legacy.delete(turn);
      this.rows.set(id, row);
      return true;
    }
    if (payload.type === 'turn_aborted' || payload.type === 'turn_failed' || payload.type === 'task_complete') {
      for (const row of this.rows.values()) {
        if (row.turnId !== turn || row.phase !== 'running') continue;
        row.phase = 'failed';
        row.error = payload.type === 'turn_aborted' ? 'Compaction interrupted' : 'Compaction ended without a completion event';
      }
    }
    return false;
  }
}
