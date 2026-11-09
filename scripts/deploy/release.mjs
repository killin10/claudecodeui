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

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };

/** Written by `npm run verify` once typecheck and lint pass; deploy skips both for the same tree. */
export const verifiedStampPath = source => path.join(source, 'node_modules/.cache/cloudcli/verified.json');
/** Written after deploy's own `npm ci`; lets the next deploy keep node_modules for an unchanged lockfile. */
export const devInstallMarkerPath = source => path.join(source, 'node_modules/.cloudcli-deploy-install.json');

/**
 * Content hash of every file that participates in the build: tracked files as
 * they are on disk (uncommitted edits and deletions included) plus untracked,
 * non-ignored files. Ignored outputs such as dist/ and node_modules/ never count.
 */
export async function treeFingerprint(source) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.join(source, file);
    let entry;
    try {
      const stat = await fs.lstat(absolute);
      entry = stat.isSymbolicLink() ? `link:${await fs.readlink(absolute)}` : stat.isFile() ? `file:${sha256(await fs.readFile(absolute))}` : 'other';
    } catch {
      entry = 'deleted';
    }
    hash.update(`${file}\0${entry}\n`);
  }
  return hash.digest('hex');
}

/** True when `npm run verify` passed on exactly this tree. */
export async function isTreeVerified(source, fingerprint) {
  return (await readJson(verifiedStampPath(source)))?.fingerprint === fingerprint;
}

export async function writeVerifiedStamp(source, fingerprint) {
  await fs.mkdir(path.dirname(verifiedStampPath(source)), { recursive: true });
  await fs.writeFile(verifiedStampPath(source), `${JSON.stringify({ fingerprint, checks: ['typecheck', 'lint'], verifiedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** What node_modules must have been installed from for an install to be reused. */
async function installIdentity(source, runtime) {
  return {
    lockSha256: sha256(await fs.readFile(path.join(source, 'package-lock.json'))),
    packageSha256: sha256(await fs.readFile(path.join(source, 'package.json'))),
    nodeVersion: runtime.nodeVersion, platform: process.platform, arch: process.arch,
  };
}

export async function devInstallReusable(source, runtime) {
  const marker = await readJson(devInstallMarkerPath(source));
  if (!marker || !await exists(path.join(source, 'node_modules'))) return false;
  const identity = await installIdentity(source, runtime);
  return Object.entries(identity).every(([key, value]) => marker[key] === value);
}

export async function writeDevInstallMarker(source, runtime) {
  await fs.writeFile(devInstallMarkerPath(source), `${JSON.stringify(await installIdentity(source, runtime), null, 2)}\n`);
}

/**
 * The active release's production node_modules when it was installed from the
 * same lockfile with the same Node, platform and architecture, else null.
 */
export async function reusableProductionModules(p, lockSha256, runtime) {
  const current = await resolveRelease(p);
  if (!current) return null;
  const metadata = await readJson(path.join(current, 'release.json'));
  const modules = path.join(current, 'node_modules');
  const matches = metadata && metadata.lockSha256 === lockSha256 && metadata.nodeVersion === runtime.nodeVersion
    && metadata.platform === process.platform && metadata.arch === process.arch;
  return matches && await exists(modules) ? modules : null;
}

/**
 * Builds a new release from the working tree. Work already done for identical
 * inputs is reused: checks that `npm run verify` passed on this exact tree, the
 * workspace install of an unchanged lockfile, and the active release's
 * production install. Server types are always checked by build:server's tsc
 * (noEmitOnError), so deploy's own typecheck covers the client only.
 */
export async function stageRelease(source, p, runtime, { skipTypecheck = false, cleanInstall = false, fullChecks = false } = {}) {
  if (process.version !== runtime.nodeVersion || await fs.realpath(process.execPath) !== await fs.realpath(runtime.node)) {
    throw new Error(`Run deploy with ${runtime.node} (${runtime.nodeVersion}), not ${process.execPath}`);
  }
  const env = { ...process.env, PATH: `${path.dirname(runtime.node)}:${runtime.path}`, HUSKY: '0', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  // Read before install: a clean `npm ci` wipes node_modules and the stamp with it.
  const fingerprint = await treeFingerprint(source);
  const verified = !fullChecks && await isTreeVerified(source, fingerprint);

  let devInstall = 'reused';
  if (cleanInstall || !await devInstallReusable(source, runtime)) {
    devInstall = 'clean';
    await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: source, env });
    await writeDevInstallMarker(source, runtime);
  } else {
    console.log('[deploy] package-lock.json unchanged since the last deploy install; keeping node_modules (use --clean-install to reinstall).');
  }

  let checks;
  if (verified) {
    checks = 'verified';
    console.log('[deploy] typecheck and lint already passed for this exact tree (npm run verify); skipping them.');
  } else {
    checks = skipTypecheck ? 'lint-only' : 'ran';
    if (!skipTypecheck) await run('npm', ['run', 'typecheck:client'], { cwd: source, env });
    await run('npm', ['run', 'lint'], { cwd: source, env });
  }
  await run('npm', ['run', 'build'], { cwd: source, env });

  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const commit = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  const id = `${manifest.version}-${commit.slice(0, 8)}${status ? '-dirty' : ''}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  const release = path.join(p.releases, id);
  const lockSha256 = sha256(await fs.readFile(path.join(source, 'package-lock.json')));
  const previousModules = cleanInstall ? null : await reusableProductionModules(p, lockSha256, runtime);
  await copyReleaseFiles(source, release, p.env);
  try {
    const cleanProductionInstall = async () => {
      await fs.rm(path.join(release, 'node_modules'), { recursive: true, force: true });
      await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: release, env });
      await runNativeChecks(release, runtime);
    };
    let prodInstall = 'clean';
    if (previousModules) {
      console.log(`[deploy] Copying production node_modules from ${path.basename(path.dirname(previousModules))} (same lockfile and Node).`);
      try {
        // A full copy, not hardlinks: releases must stay independent for rollback.
        await run('/bin/cp', ['-a', previousModules, path.join(release, 'node_modules')]);
        await runNativeChecks(release, runtime);
        prodInstall = 'reused';
      } catch (error) {
        console.warn(`[deploy] Reused production install failed (${error.message}); reinstalling.`);
        await cleanProductionInstall();
      }
    } else {
      await cleanProductionInstall();
    }
    const metadata = {
      id, version: manifest.version, commit, dirty: Boolean(status), workingTree: status,
      builtAt: new Date().toISOString(), node: runtime.node, nodeVersion: runtime.nodeVersion,
      typecheckSkipped: skipTypecheck && !verified,
      checks, devInstall, prodInstall, treeFingerprint: fingerprint,
      platform: process.platform, arch: process.arch,
      lockSha256,
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
