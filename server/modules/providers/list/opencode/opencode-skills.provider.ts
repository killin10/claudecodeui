import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { listOpenCodeInvocations, loadOpenCodeCatalog } from '@/modules/providers/list/opencode/opencode-inputs.provider.js';
import type { ProviderSkill, ProviderSkillListOptions, ProviderSkillSource } from '@/shared/types.js';
import { AppError, findTopmostGitRoot, getOpenCodeConfigDirectory } from '@/shared/utils.js';

function under(filename: string, directory: string): boolean {
  const relative = path.relative(directory, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function writableRoot(): Promise<string> {
  const root = path.join(getOpenCodeConfigDirectory(), 'skills');
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new AppError('Managed OpenCode skills require a real skills directory.', { code: 'OPENCODE_SKILLS_READ_ONLY', statusCode: 400 });
  }
  return root;
}

/** OpenCode settings uses the native catalog; writes are confined to its own user skills folder. */
export class OpenCodeSkillsProvider extends SkillsProvider {
  constructor(private readonly catalog = loadOpenCodeCatalog) {
    super('opencode');
  }

  async listInvocations(options?: ProviderSkillListOptions) {
    return listOpenCodeInvocations(path.resolve(options?.workspacePath ?? os.homedir()));
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const directory = path.resolve(options?.workspacePath ?? os.homedir());
    const { skills } = await this.catalog(directory);
    const projectRoot = await findTopmostGitRoot(directory) ?? directory;
    const root = path.resolve(getOpenCodeConfigDirectory(), 'skills');
    return Promise.all(skills.map(async (skill): Promise<ProviderSkill> => {
      const parent = path.dirname(skill.path);
      const managed = path.dirname(parent) === root && path.basename(skill.path) === 'SKILL.md';
      const info = managed ? await lstat(parent) : null;
      const rootInfo = managed ? await lstat(root) : null;
      const managedDirectory = info?.isDirectory() && rootInfo?.isDirectory() ? path.basename(parent) : undefined;
      const userRoots = [getOpenCodeConfigDirectory(), path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.agents')];
      const scope = userRoots.some((userRoot) => under(skill.path, userRoot)) ? 'user'
        : projectRoot !== os.homedir() && under(skill.path, projectRoot) ? 'project' : 'plugin';
      return {
        provider: 'opencode', name: skill.name, description: skill.description ?? '',
        command: `/skill:${skill.id}`, sourcePath: skill.path, scope, managedDirectory,
      };
    }));
  }

  // Native discovery above owns all read sources, including plugin/custom directories.
  protected async getSkillSources(): Promise<ProviderSkillSource[]> { return []; }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: await writableRoot(), commandForSkill: (name) => `/skill:${name}` };
  }
}
