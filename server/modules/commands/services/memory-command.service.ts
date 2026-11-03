import path from 'node:path';
import type { access } from 'node:fs/promises';

/** Commands routes use this to locate the provider's project instructions without creating files. */
export async function readMemoryCommand(projectPath: string | undefined, provider: string, checkAccess: typeof access) {
  const filename = provider === 'opencode' ? 'AGENTS.md' : 'CLAUDE.md';
  if (!projectPath) {
    return { error: 'No project selected', message: `Please select a project to access its ${filename} file` };
  }
  const filenamePath = path.join(projectPath, filename);
  let exists = true;
  try {
    await checkAccess(filenamePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  return {
    path: filenamePath,
    exists,
    message: exists ? `Opening ${filename} at ${filenamePath}`
      : `${filename} not found at ${filenamePath}. Create it to store project-specific instructions.`,
  };
}
