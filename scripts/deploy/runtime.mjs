import fs from 'node:fs/promises';
import path from 'node:path';
import { assertOwned, exists, readConfig, resolveRelease } from './layout.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function shellLauncher(node, script, home) {
  return `#!/bin/sh\nset -eu\nexec ${quote(node)} ${quote(script)} ${quote(home)} "$@"\n`;
}

export async function installCommands(p, source) {
  const { runtime } = await readConfig(p);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== 'deploy.mjs') {
      const destination = path.join(p.bin, entry.name);
      const temp = `${destination}.next`;
      await fs.copyFile(path.join(source, entry.name), temp);
      await fs.rename(temp, destination);
    }
  }
  for (const [name, script] of [['cloudcli-service', 'cli.mjs'], ['launch.sh', 'launch.mjs']]) {
    const temp = path.join(p.bin, `${name}.next`);
    await fs.writeFile(temp, shellLauncher(runtime.node, path.join(p.bin, script), p.home), { mode: 0o700 });
    await fs.rename(temp, path.join(p.bin, name));
  }
}

export async function launch(p) {
  await assertOwned(p);
  const activationFile = path.join(p.run, 'activation.json');
  if (await exists(activationFile) && JSON.parse(await fs.readFile(activationFile, 'utf8')).state === 'manual-recovery-required') {
    throw new Error(`Service requires manual database recovery; inspect ${activationFile} before restarting.`);
  }
  const { environment, runtime, host, port, database } = await readConfig(p);
  const release = await resolveRelease(p);
  if (!release) throw new Error('No active release. Run the deployment command first.');
  const metadata = JSON.parse(await fs.readFile(path.join(release, 'release.json'), 'utf8'));
  if (process.version !== runtime.nodeVersion || process.version !== metadata.nodeVersion) {
    throw new Error(`Node version mismatch: running ${process.version}, configured ${runtime.nodeVersion}, release ${metadata.nodeVersion}. Re-deploy with the selected runtime.`);
  }
  if (await fs.realpath(process.execPath) !== await fs.realpath(runtime.node)) throw new Error('Node executable does not match service.json');
  const env = {
    HOME: p.home, PATH: runtime.path,
    USER: path.basename(p.home), LOGNAME: path.basename(p.home),
    LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp',
    // Keep access to the login session's SSH agent, not arbitrary terminal secrets.
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    ...environment, HOST: host, SERVER_PORT: String(port), DATABASE_PATH: database,
  };
  // Do not permit server.env to move the process away from its configured user/runtime.
  env.HOME = p.home;
  env.PATH = runtime.path;
  process.chdir(release);
  process.execve(runtime.node, [runtime.node, path.join(release, 'dist-server/server/index.js')], env);
}
