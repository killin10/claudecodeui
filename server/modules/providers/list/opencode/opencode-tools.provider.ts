import type { AnyRecord } from '@/shared/types.js';

function fileDiffs(files: unknown): AnyRecord | undefined {
  if (!Array.isArray(files)) return undefined;
  const changes = files.filter((file) => typeof file?.file === 'string' && typeof file?.patch === 'string');
  if (changes.length === 0) return undefined;
  return { bashEditDiff: {
    files: changes.map((file) => ({
      filePath: file.file,
      created: file.status === 'added',
      deleted: file.status === 'deleted',
      hunks: readHunks(file.patch),
    })),
    moreFiles: 0,
  } };
}

function readHunks(patch: string): AnyRecord[] {
  const hunks: AnyRecord[] = [];
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunks.push({ oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]), newLines: Number(header[4] ?? 1), lines: [] });
      continue;
    }
    if (hunks.length && /^[ +\-\\]/.test(line)) hunks[hunks.length - 1].lines.push(line);
  }
  return hunks;
}

/** Sessions normalization uses this for both live snapshots and persisted/child tool rows. */
export function normalizeOpenCodeTool(name: string, state: AnyRecord): AnyRecord {
  const input = state.input ?? {};
  const display = (() => {
    switch (name) {
      case 'shell': return { tool: 'Bash', input };
      case 'todowrite': return { tool: 'TodoWrite', input };
      case 'edit': return { tool: 'Edit', input: { ...input, file_path: input.path, old_string: input.oldString, new_string: input.newString } };
      case 'write': return { tool: 'Write', input: { ...input, file_path: input.path } };
      case 'patch': return { tool: 'ApplyPatch', input: { ...input, patch: input.patchText } };
      default: return { tool: name, input };
    }
  })();
  return {
    tool: display.tool,
    state: { ...state, input: display.input, toolUseResult: fileDiffs(state.metadata?.files) },
  };
}
