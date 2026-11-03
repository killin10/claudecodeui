import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { AnyRecord, ProviderSkill, ProviderSkillListOptions, ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

export class CodexSkillsProvider extends SkillsProvider {
  constructor() {
    super('codex');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const connection = await codexAppServer.connect();
    try {
      const result = await connection.call('skills/list', { cwds: [path.resolve(options?.workspacePath ?? process.cwd())], forceReload: true });
      if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid skill list');
      const managed = await super.listSkills(options);
      const byPath = new Map(managed.map(skill => [skill.sourcePath, skill]));
      return result.data.flatMap((entry: AnyRecord) => {
        if (entry.errors?.length) console.warn('[Codex] Skill discovery errors:', entry.errors);
        if (!Array.isArray(entry.skills)) throw new Error('Codex returned an invalid skill entry');
        return entry.skills.filter((skill: AnyRecord) => skill.enabled).map((skill: AnyRecord): ProviderSkill => {
          if (typeof skill.name !== 'string' || typeof skill.path !== 'string') throw new Error('Codex returned an invalid skill');
          return {
            ...byPath.get(skill.path), provider: 'codex', name: skill.name,
            description: skill.description ?? '', command: `$${skill.name}`,
            scope: skill.pluginId ? 'plugin' : skill.scope,
            sourcePath: skill.path,
            ...(skill.pluginId ? { pluginId: skill.pluginId, pluginName: skill.pluginId } : {}),
          };
        });
      });
    } finally {
      await connection.dispose();
    }
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '$',
    });

    if (repoRoot) {
      // Codex checks repository skills at the launch folder, one folder above it,
      // and the topmost git root; these can collapse to the same directory.
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(path.dirname(workspacePath), '.agents', 'skills'),
        commandPrefix: '$',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '$',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.codex', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'admin',
      rootDir: path.join('/etc', 'codex', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'system',
      rootDir: path.join(os.homedir(), '.codex', 'skills', '.system'),
      commandPrefix: '$',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    };
  }
}
