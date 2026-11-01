import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initialize, paths, readConfig, renderPlist, resolveRelease, runtimeManifest, selectRelease, withLock } from '../layout.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli home & '));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return paths(home);
}
const runtime = { node: process.execPath, nodeVersion: process.version, path: '/usr/bin:/bin' };

test('initialization generates absolute paths, private config and preserves edited settings', async (t) => {
  const p = await fixture(t);
  await initialize(p, runtime);
  const config = await readConfig(p);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3001);
  assert.equal(config.database, path.join(p.home, '.cloudcli/auth.db'));
  assert.equal((await fs.stat(p.env)).mode & 0o777, 0o600);
  await fs.writeFile(p.env, 'HOST=127.0.0.1\nSERVER_PORT=4321\n');
  await initialize(p, runtime);
  assert.equal((await readConfig(p)).port, 4321);
});

test('foreign installation and foreign plist are rejected without changing them', async (t) => {
  const p = await fixture(t);
  await fs.mkdir(p.root, { recursive: true });
  await fs.writeFile(path.join(p.root, 'precious'), 'untouched');
  await assert.rejects(initialize(p, runtime), /not managed/);
  assert.equal(await fs.readFile(path.join(p.root, 'precious'), 'utf8'), 'untouched');
  await fs.rm(p.root, { recursive: true });
  await fs.mkdir(path.dirname(p.plist), { recursive: true });
  await fs.writeFile(p.plist, 'foreign');
  await assert.rejects(initialize(p, runtime), /LaunchAgent/);
  assert.equal(await fs.readFile(p.plist, 'utf8'), 'foreign');
});

test('configuration rejects shell-style database paths and invalid ports', async (t) => {
  const p = await fixture(t);
  await initialize(p, runtime);
  for (const content of ['DATABASE_PATH=~/.cloudcli/db\n', 'DATABASE_PATH=$HOME/db\n', 'SERVER_PORT=0\n', 'SERVER_PORT=3001junk\n']) {
    await fs.writeFile(p.env, content);
    await assert.rejects(readConfig(p));
  }
});

test('release selection is atomic and refuses links outside owned releases', async (t) => {
  const p = await fixture(t);
  await initialize(p, runtime);
  const release = path.join(p.releases, 'v1');
  await fs.mkdir(release);
  await selectRelease(p, 'current', release);
  assert.equal(await resolveRelease(p, 'current'), await fs.realpath(release));
  await fs.unlink(path.join(p.root, 'current'));
  await fs.symlink(p.home, path.join(p.root, 'current'));
  await assert.rejects(resolveRelease(p, 'current'), /outside/);
  await assert.rejects(selectRelease(p, 'current', p.home), /outside/);
});

test('deployment lock prevents overlap and is released on failure', async (t) => {
  const p = await fixture(t);
  await initialize(p, runtime);
  await assert.rejects(withLock(p, async () => {
    await assert.rejects(withLock(p, async () => {}), /locked/);
    throw new Error('abort');
  }), /abort/);
  await withLock(p, async () => assert.equal(true, true));
});

test('plist round-trips paths containing spaces and XML characters through plutil', async (t) => {
  const p = await fixture(t);
  if (process.platform !== 'darwin') return t.skip('macOS plist validation');
  await fs.mkdir(path.dirname(p.plist), { recursive: true });
  await fs.writeFile(p.plist, renderPlist(p));
  const { execFileSync } = await import('node:child_process');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p.plist], { encoding: 'utf8' }));
  assert.equal(plist.Label, 'local.cloudcli');
  assert.deepEqual(plist.ProgramArguments, ['/bin/sh', path.join(p.bin, 'launch.sh')]);
  assert.equal(plist.StandardOutPath, path.join(p.logs, 'stdout.log'));
  assert.equal(plist.KeepAlive, true);
  assert.equal(plist.RunAtLoad, true);
});

test('staged manifest removes developer lifecycle hooks without mutating source manifest', () => {
  const source = { name: 'example', scripts: { prepare: 'husky', prepublishOnly: 'build', postinstall: 'node scripts/fix-node-pty.js' }, dependencies: { native: '1.0' } };
  const staged = runtimeManifest(source);
  assert.equal(staged.scripts.prepare, undefined);
  assert.equal(staged.scripts.prepublishOnly, undefined);
  assert.equal(staged.scripts.postinstall, 'node scripts/fix-node-pty.js');
  assert.equal(source.scripts.prepare, 'husky');
  assert.deepEqual(staged.dependencies, { native: '1.0' });
});
