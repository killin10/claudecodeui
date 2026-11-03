import path from 'node:path';
import { assertOwned, paths, readConfig, resolveRelease } from './layout.mjs';

try {
  const p = paths(process.argv[2]);
  await assertOwned(p);
  const { runtime } = await readConfig(p);
  const release = await resolveRelease(p);
  if (!release) throw new Error('No active CloudCLI release.');
  // Preserve the caller's cwd, environment and argument boundaries. CLI session
  // commands must not bootstrap a second server or inherit a release-specific cwd.
  process.execve(runtime.node, [runtime.node, path.join(release, 'dist-server/server/modules/cli/cli.js'), ...process.argv.slice(3)], {
    ...process.env, PATH: `${path.dirname(runtime.node)}:${process.env.PATH ?? runtime.path}`,
  });
} catch (error) {
  console.error(`[cloudcli] ${error.message}`);
  process.exitCode = 1;
}
