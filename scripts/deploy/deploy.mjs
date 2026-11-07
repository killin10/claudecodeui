import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertOwned, exists, initialize, paths, readConfig, withLock } from './layout.mjs';
import { installCommands } from './runtime.mjs';
import { pruneReleases, run, stageRelease } from './release.mjs';
import { activate } from './activation.mjs';
import { createServiceAdapter } from './service-manager.mjs';
import { checkSystemdEnvironment, insideService } from './systemd.mjs';
import { startBackgroundDeployment } from './background.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(scriptDir, '../..');

async function main() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Local deployment requires macOS or Linux with systemd');
  if (process.platform === 'linux' && !['arm64', 'x64'].includes(process.arch)) throw new Error('Linux deployment requires a 64-bit OS and Node (arm64 or x64)');
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run deploy:local -- [--node /absolute/path/to/node] [--setup-local] [--skip-typecheck] [--background]\nExisting server.env and service.json are preserved. Node 22/24 LTS is required.');
    return;
  }
  let selected;
  let setupLocal = false;
  let skipTypecheck = false;
  let background = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node') {
      selected = args[++i];
      if (!selected || !path.isAbsolute(selected)) throw new Error('--node requires an absolute executable path');
    } else if (args[i] === '--setup-local') setupLocal = true;
    else if (args[i] === '--skip-typecheck') skipTypecheck = true;
    else if (args[i] === '--background') background = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (background && process.platform !== 'linux') throw new Error('--background currently requires Linux/systemd; on macOS use an independent SSH/tmux deployment session');
  const p = paths(os.homedir());
  if (p.platform === 'linux') await checkSystemdEnvironment();
  if (await exists(p.root)) await assertOwned(p);
  if (await exists(p.service)) {
    const saved = (await readConfig(p)).runtime.node;
    if (selected && await fs.realpath(selected) !== await fs.realpath(saved)) {
      throw new Error('Existing service.json pins another Node. Stop the service and explicitly edit service.json before changing runtime.');
    }
    selected = saved;
  }
  if (!selected && process.release.lts && [22, 24].includes(Number(process.versions.node.split('.')[0]))) selected = process.execPath;
  if (!selected) {
    const nvm = path.join(p.home, '.nvm/versions/node');
    const versions = await exists(nvm) ? (await fs.readdir(nvm)).filter(name => /^v24\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
    const candidates = ['/opt/homebrew/opt/node@24/bin/node', ...versions.map(version => path.join(nvm, version, 'bin/node'))];
    for (const candidate of candidates) if (await exists(candidate)) { selected = candidate; break; }
  }
  if (!selected) throw new Error('No supported Node LTS found. Supply --node /absolute/path/to/node (Node 22 or 24). No global runtime was changed.');
  selected = await fs.realpath(selected);
  const info = JSON.parse(execFileSync(selected, ['-p', 'JSON.stringify({version:process.version,lts:process.release.lts})'], { encoding: 'utf8' }));
  if (!info.lts || !/^v(22|24)\./.test(info.version)) throw new Error('Use Node 22 or 24 LTS for the locked native dependencies');
  if (await fs.realpath(process.execPath) !== selected) {
    return run(selected, [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, PATH: `${path.dirname(selected)}:${process.env.PATH || '/usr/bin:/bin'}` } });
  }
  const runtime = {
    node: selected, nodeVersion: info.version,
    path: [...new Set([path.dirname(selected), ...(p.platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', path.join(p.home, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
  };
  // With no existing database, first-run setup stays private until the operator creates an account.
  const firstSetup = !await exists(path.join(p.home, '.cloudcli/auth.db'));
  await initialize(p, runtime, { setupLocal: setupLocal || firstSetup });
  if (p.platform === 'linux' && (background || await insideService())) {
    return startBackgroundDeployment(p, source, selected, args.filter(arg => arg !== '--background'));
  }
  await withLock(p, async () => {
    const config = await readConfig(p);
    if (setupLocal && !['127.0.0.1', '::1'].includes(config.host)) throw new Error('--setup-local does not overwrite existing config. Set HOST=127.0.0.1 in server.env first.');
    if (skipTypecheck) console.warn('WARNING: typecheck explicitly skipped; this exception is recorded in release.json.');
    const release = await stageRelease(source, p, config.runtime, { skipTypecheck });
    // Helpers are installed only after the new release has passed build/native checks.
    await installCommands(p, scriptDir);
    await activate(p, release, await createServiceAdapter(p, release));
    await pruneReleases(p);
    console.log(`Installed: ${release}\nService: ${path.join(p.bin, 'cloudcli-service')}\nListening: ${config.host}:${config.port}`);
    if (['127.0.0.1', '::1'].includes(config.host)) {
      console.log(`Local setup: open http://localhost:${config.port}, create your account, then set HOST=0.0.0.0 in ${p.env} and run cloudcli-service restart.`);
    }
  });
}

try { await main(); } catch (error) {
  console.error(`[deploy] ${error.message}`);
  process.exitCode = 1;
}
