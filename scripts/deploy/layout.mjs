import fs from 'node:fs/promises';
import path from 'node:path';
import { renderUnit } from './systemd-unit.mjs';

const OWNER = 'cloudcli-local-deployment-v1';
export const LABEL = 'local.cloudcli';

export function paths(home, platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Local deployment requires macOS or Linux with systemd');
  if (!path.isAbsolute(home)) throw new Error('Home must be an absolute path');
  const root = path.join(home, '.local/share/cloudcli');
  const config = path.join(home, '.config/cloudcli');
  return {
    home, root, config, platform, bin: path.join(root, 'bin'), releases: path.join(root, 'releases'),
    backups: path.join(root, 'backups'), run: path.join(root, 'run'),
    logs: path.join(home, platform === 'linux' ? '.local/state/cloudcli/logs' : 'Library/Logs/cloudcli'),
    unit: path.join(home, '.config/systemd/user/local.cloudcli.service'),
    serviceFile: path.join(home, platform === 'linux' ? '.config/systemd/user/local.cloudcli.service' : 'Library/LaunchAgents/local.cloudcli.plist'),
    plist: path.join(home, 'Library/LaunchAgents/local.cloudcli.plist'),
    env: path.join(config, 'server.env'), service: path.join(config, 'service.json'),
  };
}

export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function noSymlink(file) {
  if (await exists(file) && (await fs.lstat(file)).isSymbolicLink()) {
    throw new Error(`Refusing symbolic link: ${file}`);
  }
}

export async function assertOwned(p) {
  await noSymlink(p.root);
  let marker;
  try { marker = JSON.parse(await fs.readFile(path.join(p.root, '.managed.json'), 'utf8')); } catch { /* report ownership below */ }
  if (marker?.owner !== OWNER || marker.home !== p.home) throw new Error(`${p.root} is not managed by this installer`);
  for (const dir of [p.bin, p.releases, p.backups, p.run, p.config, p.logs]) await noSymlink(dir);
}

export function runtimeManifest(source) {
  const result = structuredClone(source);
  result.scripts = { postinstall: 'node scripts/fix-node-pty.js' };
  return result;
}

export function renderPlist(p) {
  const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(path.join(p.bin, 'launch.sh'))}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(path.join(p.logs, 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(p.logs, 'stderr.log'))}</string>
</dict></plist>
`;
}

export async function verifyPlist(p) {
  await noSymlink(p.plist);
  if (await exists(p.plist) && await fs.readFile(p.plist, 'utf8') !== renderPlist(p)) {
    throw new Error(`LaunchAgent is not managed or was edited: ${p.plist}`);
  }
}

export async function verifyServiceFile(p) {
  if (p.platform === 'darwin') return verifyPlist(p);
  await noSymlink(p.unit);
  if (await exists(p.unit) && await fs.readFile(p.unit, 'utf8') !== renderUnit(p)) {
    throw new Error(`Systemd unit is not managed or was edited: ${p.unit}`);
  }
}

export async function initialize(p, runtime, { setupLocal = false } = {}) {
  await verifyServiceFile(p);
  if (await exists(p.root)) await assertOwned(p);
  for (const target of [p.config, p.env, p.service, p.logs]) await noSymlink(target);
  await fs.mkdir(p.root, { recursive: true, mode: 0o700 });
  if (!await exists(path.join(p.root, '.managed.json'))) {
    await fs.writeFile(path.join(p.root, '.managed.json'), JSON.stringify({ owner: OWNER, home: p.home }), { flag: 'wx', mode: 0o600 });
  }
  for (const dir of [p.bin, p.releases, p.backups, p.run, p.config, p.logs, path.dirname(p.serviceFile)]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  if (!await exists(p.env)) {
    await fs.writeFile(p.env, `# Loaded by CloudCLI; values are literal, not shell expressions.\nHOST=${setupLocal ? '127.0.0.1' : '0.0.0.0'}\nSERVER_PORT=3001\n`, { flag: 'wx', mode: 0o600 });
  }
  if (!await exists(p.service)) {
    await fs.writeFile(p.service, `${JSON.stringify(runtime, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  await readConfig(p);
}

export async function readConfig(p) {
  await noSymlink(p.env);
  await noSymlink(p.service);
  const environment = {};
  for (const line of (await fs.readFile(p.env, 'utf8')).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) throw new Error(`Invalid server.env line: expected KEY=value`);
    const key = trimmed.slice(0, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment key');
    // Match server/load-env.ts: no shell expansion and no quote removal.
    environment[key] = trimmed.slice(index + 1).trim();
  }
  const portText = environment.SERVER_PORT || '3001';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('SERVER_PORT must be 1..65535');
  const database = environment.DATABASE_PATH || path.join(p.home, '.cloudcli/auth.db');
  if (!path.isAbsolute(database)) throw new Error('DATABASE_PATH must be absolute; ~ and $HOME are not expanded');
  const host = environment.HOST || '0.0.0.0';
  if (!['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) {
    throw new Error('HOST must be 0.0.0.0, 127.0.0.1, :: or ::1');
  }
  const runtime = JSON.parse(await fs.readFile(p.service, 'utf8'));
  if (!path.isAbsolute(runtime.node || '') || !/^v\d+\.\d+\.\d+/.test(runtime.nodeVersion || '') || typeof runtime.path !== 'string') {
    throw new Error('Invalid service.json: absolute node, nodeVersion and path are required');
  }
  return { environment, runtime, database, host, port: Number(portText) };
}

export async function resolveRelease(p, name = 'current') {
  if (!['current', 'previous'].includes(name)) throw new Error('Invalid release link');
  const link = path.join(p.root, name);
  if (!await exists(link)) return null;
  if (!(await fs.lstat(link)).isSymbolicLink()) throw new Error(`Not a release symlink: ${link}`);
  const release = await fs.realpath(link);
  if (path.dirname(release) !== await fs.realpath(p.releases)) throw new Error('Release is outside managed releases');
  return release;
}

export async function selectRelease(p, name, release) {
  if (!['current', 'previous'].includes(name)) throw new Error('Invalid release link');
  const target = await fs.realpath(release);
  if (path.dirname(target) !== await fs.realpath(p.releases)) throw new Error('Release is outside managed releases');
  await resolveRelease(p, name);
  const temp = path.join(p.root, `.${name}-${process.pid}-${Date.now()}`);
  try {
    await fs.symlink(path.relative(await fs.realpath(p.root), target), temp);
    await fs.rename(temp, path.join(p.root, name));
  } finally { await fs.rm(temp, { force: true }); }
}

export async function withLock(p, action) {
  await assertOwned(p);
  const lock = path.join(p.run, 'operation.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Deployment is locked: ${lock}. Check the owner.json PID before removing a stale lock.`);
    throw error;
  }
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
