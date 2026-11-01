import fs from 'node:fs/promises';
import path from 'node:path';
import { assertOwned, exists, paths, readConfig, resolveRelease, withLock } from './layout.mjs';
import { createLaunchdAdapter, disableService, jobStatus, localUrl } from './launchd.mjs';
import { activate } from './activation.mjs';
import { run } from './release.mjs';

const commands = ['status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'releases', 'rollback', 'uninstall'];

async function main() {
  const p = paths(process.argv[2]);
  const [command = 'status', argument] = process.argv.slice(3);
  if (!commands.includes(command)) throw new Error(`Commands: ${commands.join(', ')}`);
  if (process.platform !== 'darwin') throw new Error('This deployment manager requires macOS');
  await assertOwned(p);
  const config = await readConfig(p);
  if (command === 'logs') {
    const logs = ['stdout.log', 'stderr.log'].map(name => path.join(p.logs, name));
    for (const file of logs) {
      if (await exists(file) && !(await fs.lstat(file)).isFile()) throw new Error(`Not a regular log file: ${file}`);
      await fs.appendFile(file, '', { mode: 0o600 });
    }
    return run('/usr/bin/tail', ['-n', '100', '-F', ...logs]);
  }
  if (command === 'releases') {
    for (const entry of await fs.readdir(p.releases, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(p.releases, entry.name, 'release.json');
      if (await exists(file)) console.log(await fs.readFile(file, 'utf8'));
    }
    return;
  }
  if (command === 'status') {
    const state = await jobStatus(p);
    const release = await resolveRelease(p);
    let health;
    try { health = await (await fetch(`${localUrl(config)}/health`, { signal: AbortSignal.timeout(2000) })).json(); }
    catch { health = { status: 'unavailable' }; }
    console.log(JSON.stringify({ ...state, listen: `${config.host}:${config.port}`, current: release, previous: await resolveRelease(p, 'previous'), runtime: config.runtime, health, config: p.config, logs: p.logs }, null, 2));
    return;
  }
  await withLock(p, async () => {
    const current = await resolveRelease(p);
    if (command === 'uninstall') {
      if (argument !== '--yes') throw new Error('Use uninstall --yes. Configuration, logs, backups and ~/.cloudcli data are retained.');
      const adapter = await createLaunchdAdapter(p, current || p.root);
      await adapter.stop();
      await disableService();
      await fs.rm(p.plist, { force: true });
      await resolveRelease(p, 'previous');
      for (const name of ['current', 'previous']) await fs.rm(path.join(p.root, name), { force: true });
      for (const dir of [p.bin, p.releases]) await fs.rm(dir, { recursive: true, force: true });
      console.log('Service and releases removed. Configuration, logs, backups and application data retained.');
      return;
    }
    if (command === 'stop' || command === 'disable') {
      const adapter = await createLaunchdAdapter(p, current || p.root);
      await adapter.stop();
      if (command === 'disable') await disableService();
      console.log(command === 'disable' ? 'Stopped; login startup disabled.' : 'Stopped for this login session. Use disable to turn off login startup.');
      return;
    }
    if (command === 'rollback') {
      if (argument && !/^[A-Za-z0-9._-]+$/.test(argument)) throw new Error('Expected a release ID, not a path');
      const target = argument ? path.join(p.releases, argument) : await resolveRelease(p, 'previous');
      if (!target) throw new Error('No previous release');
      if (path.dirname(await fs.realpath(target)) !== await fs.realpath(p.releases)) throw new Error('Rollback target is outside managed releases');
      await activate(p, await fs.realpath(target), await createLaunchdAdapter(p, target), { rollback: true });
      console.log(`Rolled back to ${target}`);
      return;
    }
    if (!current) throw new Error('No installed release. Run npm run deploy:local first.');
    const adapter = await createLaunchdAdapter(p, current);
    await adapter.preflight();
    if (command === 'restart') await adapter.stop();
    if (!(await jobStatus(p)).loaded) await adapter.start();
    await adapter.check(current);
    console.log(`Running ${current} at ${config.host}:${config.port}`);
  });
}

try { await main(); } catch (error) {
  console.error(`[cloudcli] ${error.message}`);
  process.exitCode = 1;
}
