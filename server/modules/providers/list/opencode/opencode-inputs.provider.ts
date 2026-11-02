import type { OpenCodeClient, SessionPromptInput, SkillInfo, CommandInfo } from '@opencode/client';

import type { ProviderInvocation } from '@/shared/types.js';

import { startOpenCodeServer } from './opencode-server.provider.js';

// Concurrent settings/composer reads of one directory share one owned host.
const catalogs = new Map<string, Promise<{ skills: SkillInfo[]; commands: CommandInfo[] }>>();

/** Skills management and composer invocations use the same activated native catalog. */
export function loadOpenCodeCatalog(directory: string) {
  const existing = catalogs.get(directory);
  if (existing) return existing;
  const pending = readCatalog(directory).finally(() => catalogs.delete(directory));
  catalogs.set(directory, pending);
  return pending;
}

async function readCatalog(directory: string) {
  const signal = AbortSignal.timeout(60_000);
  const { client, server } = await startOpenCodeServer(signal);
  try {
    const options = { signal };
    const location = { directory };
    // Plugin activation owns Skills and commands; these lists alone do not await it.
    await client.model.list({ location }, options);
    const [skills, commands] = await Promise.all([
      client.skill.list({ location }, options),
      client.command.list({ location }, options),
    ]);
    return { skills: skills.data, commands: commands.data };
  } finally {
    server.close();
  }
}

/** Used by the skills facet to expose exact native invocation IDs to the composer. */
export async function listOpenCodeInvocations(directory: string): Promise<ProviderInvocation[]> {
  const { skills, commands } = await loadOpenCodeCatalog(directory);
  return [
    { name: '/compact', description: 'Compact the OpenCode context', kind: 'command' },
    ...commands.filter((command) => command.name !== 'compact').map((command) => ({
      name: `/${command.name}`, description: command.description ?? '', kind: 'command' as const,
    })),
    ...skills.map((skill) => ({
      name: `/skill:${skill.id}`, description: skill.description ?? '', kind: 'skill' as const, path: skill.path,
    })),
  ];
}

function explicitSkillMentions(text: string): NonNullable<SessionPromptInput['skills']> {
  return Array.from(text.matchAll(/(?<!\S)\/skill:([^\s]+)/g), (match) => ({
    id: match[1],
    mention: { start: match.index, end: match.index + match[0].length, text: match[0] },
  }));
}

async function resolveSkills(
  client: OpenCodeClient,
  directory: string,
  text: string,
  signal: AbortSignal,
  shorthandName?: string,
): Promise<NonNullable<SessionPromptInput['skills']>> {
  const mentions = explicitSkillMentions(text);
  if (mentions.length === 0 && !shorthandName) return [];
  const catalog = await client.skill.list({ location: { directory } }, { signal });
  for (const mention of mentions) {
    if (!catalog.data.some((skill) => skill.id === mention.id)) {
      throw new Error(`OpenCode skill not found: ${mention.id}`);
    }
  }
  if (mentions.length > 0) return mentions;
  const shorthand = catalog.data.find((skill) => skill.id === shorthandName);
  return shorthand ? [{
    id: shorthand.id,
    mention: { start: 0, end: shorthandName!.length + 1, text: `/${shorthandName}` },
  }] : [];
}

/** Used by the runtime: explicit slash invocations become native V2 operations with their arguments intact. */
export async function sendOpenCodeInput(
  client: OpenCodeClient,
  directory: string,
  input: SessionPromptInput,
  signal: AbortSignal,
): Promise<void> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text);
  const mentions = explicitSkillMentions(input.text);
  const options = { signal };
  if (!match && mentions.length === 0) {
    await client.session.prompt(input, options);
    return;
  }
  const name = match?.[1];
  const args = match?.[2] ?? '';
  if (name === 'compact') {
    if (args.trim() || input.files?.length) throw new Error('OpenCode /compact does not accept arguments or attachments.');
    await client.session.compact({ sessionID: input.sessionID }, options);
    return;
  }
  const location = { directory };
  await client.model.list({ location }, options);
  if (name && !name.startsWith('skill:')) {
    const commands = await client.command.list({ location }, options);
    if (commands.data.some((command) => command.name === name)) {
      const skills = await resolveSkills(client, directory, args, signal);
      await client.session.command({
        sessionID: input.sessionID, name, text: args, files: input.files,
        ...(skills.length ? { skills } : {}),
      }, options);
      return;
    }
  }
  const skills = await resolveSkills(client, directory, input.text, signal, name);
  await client.session.prompt({ ...input, ...(skills.length ? { skills } : {}) }, options);
}
