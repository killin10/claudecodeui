import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { exists, resolveRelease, runtimeManifest } from './layout.mjs';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args.join(' ')} failed (${signal || code})`)));
  });
}

export async function copyReleaseFiles(source, release, envFile) {
  await fs.mkdir(release, { recursive: false, mode: 0o700 });
  // Explicit allowlist: never copy the developer's .env, .git or node_modules.
  for (const name of ['dist', 'dist-server', 'public', 'shared', 'scripts/fix-node-pty.js', 'package-lock.json']) {
    const input = path.join(source, name);
    if ((await fs.lstat(input)).isSymbolicLink()) throw new Error(`Refusing linked release input: ${input}`);
    await fs.mkdir(path.dirname(path.join(release, name)), { recursive: true });
    await fs.cp(input, path.join(release, name), { recursive: true, dereference: true });
  }
  const manifest = runtimeManifest(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')));
  await fs.writeFile(path.join(release, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.symlink(envFile, path.join(release, '.env'));
}

export async function runNativeChecks(release, runtime) {
  await run(runtime.node, ['--input-type=commonjs', '-e', `
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw Error('SQLite probe failed');
    db.close();
    const bcrypt = require('bcrypt');
    if (!bcrypt.compareSync('probe', bcrypt.hashSync('probe', 4))) throw Error('bcrypt probe failed');
    const pty = require('node-pty');
    const child = pty.spawn('/bin/sh', ['-c', 'printf cloudcli-pty-ready'], { cwd: process.cwd(), env: process.env });
    let output = '';
    const timer = setTimeout(() => { child.kill(); console.error('PTY timed out'); process.exitCode = 1; }, 5000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes('cloudcli-pty-ready')) {
        console.error('PTY probe failed', exitCode, output); process.exitCode = 1;
      }
    });
  `], { cwd: release, env: { ...process.env, PATH: runtime.path }, timeout: 15000 });
}

export async function stageRelease(source, p, runtime, { skipTypecheck = false } = {}) {
  if (process.version !== runtime.nodeVersion || await fs.realpath(process.execPath) !== await fs.realpath(runtime.node)) {
    throw new Error(`Run deploy with ${runtime.node} (${runtime.nodeVersion}), not ${process.execPath}`);
  }
  const env = { ...process.env, PATH: `${path.dirname(runtime.node)}:${runtime.path}`, HUSKY: '0', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: source, env });
  for (const script of [...(!skipTypecheck ? ['typecheck'] : []), 'lint', 'build']) {
    await run('npm', ['run', script], { cwd: source, env });
  }
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const commit = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  const id = `${manifest.version}-${commit.slice(0, 8)}${status ? '-dirty' : ''}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  const release = path.join(p.releases, id);
  await copyReleaseFiles(source, release, p.env);
  try {
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: release, env });
    await runNativeChecks(release, runtime);
    const metadata = {
      id, version: manifest.version, commit, dirty: Boolean(status), workingTree: status,
      builtAt: new Date().toISOString(), node: runtime.node, nodeVersion: runtime.nodeVersion,
      typecheckSkipped: skipTypecheck,
      platform: process.platform, arch: process.arch,
      lockSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(release, 'package-lock.json'))).digest('hex'),
    };
    await fs.writeFile(path.join(release, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return release;
  } catch (error) {
    // Only this invocation's incomplete release is removed; active versions are untouched.
    await fs.rm(release, { recursive: true, force: true });
    throw error;
  }
}

export async function pruneReleases(p, keep = 3) {
  const protectedPaths = new Set([await resolveRelease(p), await resolveRelease(p, 'previous')]);
  const entries = [];
  for (const entry of await fs.readdir(p.releases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(p.releases, entry.name);
    if (!await exists(path.join(dir, 'release.json'))) continue;
    const metadata = JSON.parse(await fs.readFile(path.join(dir, 'release.json'), 'utf8'));
    if (metadata.id !== entry.name || !metadata.activatedAt) continue;
    entries.push({ dir, at: metadata.activatedAt });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  for (const { dir } of entries.slice(keep)) {
    if (!protectedPaths.has(dir)) await fs.rm(dir, { recursive: true });
  }
}
