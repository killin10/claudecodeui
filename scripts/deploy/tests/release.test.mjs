import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { initialize, paths, selectRelease } from '../layout.mjs';
import {
  devInstallReusable, isTreeVerified, reusableProductionModules, treeFingerprint,
  writeDevInstallMarker, writeVerifiedStamp,
} from '../release.mjs';

const runtime = { node: process.execPath, nodeVersion: process.version, path: '/usr/bin:/bin' };

async function repository(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-release-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(dir, 'index.js'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  await fs.mkdir(path.join(dir, 'node_modules'));
  return dir;
}

test('tree fingerprint follows tracked and untracked content, never ignored outputs', async (t) => {
  const dir = await repository(t);
  const base = await treeFingerprint(dir);

  await fs.mkdir(path.join(dir, 'dist'));
  await fs.writeFile(path.join(dir, 'dist/app.js'), 'built');
  await fs.writeFile(path.join(dir, 'node_modules/x.js'), 'dep');
  assert.equal(await treeFingerprint(dir), base, 'ignored files do not count');

  await fs.writeFile(path.join(dir, 'index.js'), 'export const changed = 1;\n');
  const edited = await treeFingerprint(dir);
  assert.notEqual(edited, base, 'an uncommitted edit counts');

  await fs.writeFile(path.join(dir, 'new.js'), 'new\n');
  const added = await treeFingerprint(dir);
  assert.notEqual(added, edited, 'a new untracked file counts');

  await fs.rm(path.join(dir, 'new.js'));
  await fs.rm(path.join(dir, 'index.js'));
  assert.notEqual(await treeFingerprint(dir), base, 'a deleted tracked file counts');
});

test('a verify stamp matches only the exact tree it was written for', async (t) => {
  const dir = await repository(t);
  const fingerprint = await treeFingerprint(dir);
  assert.equal(await isTreeVerified(dir, fingerprint), false);
  await writeVerifiedStamp(dir, fingerprint);
  assert.equal(await isTreeVerified(dir, fingerprint), true);

  await fs.writeFile(path.join(dir, 'index.js'), 'export const later = 2;\n');
  assert.equal(await isTreeVerified(dir, await treeFingerprint(dir)), false);
});

test('workspace install is reused only for the same lockfile, package.json and Node', async (t) => {
  const dir = await repository(t);
  assert.equal(await devInstallReusable(dir, runtime), false, 'no marker: a developer install is not trusted');
  await writeDevInstallMarker(dir, runtime);
  assert.equal(await devInstallReusable(dir, runtime), true);
  assert.equal(await devInstallReusable(dir, { ...runtime, nodeVersion: 'v0.0.0' }), false);

  await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  assert.equal(await devInstallReusable(dir, runtime), false);

  await writeDevInstallMarker(dir, runtime);
  await fs.rm(path.join(dir, 'node_modules'), { recursive: true });
  assert.equal(await devInstallReusable(dir, runtime), false, 'npm ci by hand removes node_modules and the marker');
});

test('production modules are reused from the active release only when lockfile and Node match', async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-prod-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const p = paths(home);
  await initialize(p, runtime);
  assert.equal(await reusableProductionModules(p, 'lock-a', runtime), null, 'no active release');

  const release = path.join(p.releases, 'active');
  await fs.mkdir(path.join(release, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(release, 'release.json'), JSON.stringify({
    lockSha256: 'lock-a', nodeVersion: process.version, platform: process.platform, arch: process.arch,
  }));
  await selectRelease(p, 'current', release);

  assert.equal(await reusableProductionModules(p, 'lock-a', runtime), path.join(release, 'node_modules'));
  assert.equal(await reusableProductionModules(p, 'lock-b', runtime), null);
  assert.equal(await reusableProductionModules(p, 'lock-a', { ...runtime, nodeVersion: 'v0.0.0' }), null);
});
