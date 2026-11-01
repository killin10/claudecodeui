import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, paths, selectRelease } from '../layout.mjs';
import { installCommands, shellLauncher } from '../runtime.mjs';
import { copyReleaseFiles, runNativeChecks } from '../release.mjs';

const scriptDir = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cloudcli's runtime & ")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const p = paths(home);
  await initialize(p, { node: process.execPath, nodeVersion: process.version, path: '/usr/bin:/bin' });
  await installCommands(p, scriptDir);
  return p;
}

test('installed launcher works with quoted home paths and no dependency on source cwd or shell environment', async (t) => {
  const p = await fixture(t);
  const release = path.join(p.releases, 'fixture');
  await fs.mkdir(path.join(release, 'dist-server/server'), { recursive: true });
  await fs.writeFile(path.join(release, 'release.json'), JSON.stringify({ nodeVersion: process.version }));
  await fs.writeFile(path.join(release, 'dist-server/server/index.js'), 'console.log(JSON.stringify({cwd:process.cwd(), home:process.env.HOME, host:process.env.HOST, secret:process.env.UNRELATED_SECRET, ssh:process.env.SSH_AUTH_SOCK, nodeEnv:process.env.NODE_ENV}));');
  await selectRelease(p, 'current', release);
  const result = JSON.parse(execFileSync('/bin/sh', [path.join(p.bin, 'launch.sh')], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', UNRELATED_SECRET: 'do not inherit', SSH_AUTH_SOCK: '/tmp/test-agent.sock' }, encoding: 'utf8',
  }));
  assert.equal(result.cwd, release);
  assert.equal(result.home, p.home);
  assert.equal(result.host, '0.0.0.0');
  assert.equal(result.secret, undefined);
  assert.equal(result.ssh, '/tmp/test-agent.sock');
  assert.equal(result.nodeEnv, undefined);

  await fs.appendFile(p.env, 'NODE_ENV=test\n');
  const configured = JSON.parse(execFileSync('/bin/sh', [path.join(p.bin, 'launch.sh')], {
    cwd: '/', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  }));
  assert.equal(configured.nodeEnv, 'test');
});

test('launcher refuses a release built with a different Node version before executing it', async (t) => {
  const p = await fixture(t);
  const release = path.join(p.releases, 'incompatible');
  await fs.mkdir(release);
  await fs.writeFile(path.join(release, 'release.json'), JSON.stringify({ nodeVersion: 'v1.0.0' }));
  await selectRelease(p, 'current', release);
  assert.throws(() => execFileSync('/bin/sh', [path.join(p.bin, 'launch.sh')], { encoding: 'utf8', stdio: 'pipe' }), /Node version/);
});

test('manual database recovery state prevents launchd from restarting a failed release on next login', async (t) => {
  const p = await fixture(t);
  const release = path.join(p.releases, 'needs-recovery');
  await fs.mkdir(path.join(release, 'dist-server/server'), { recursive: true });
  await fs.writeFile(path.join(release, 'release.json'), JSON.stringify({ nodeVersion: process.version }));
  await fs.writeFile(path.join(release, 'dist-server/server/index.js'), 'process.exit(0)');
  await selectRelease(p, 'current', release);
  await fs.writeFile(path.join(p.run, 'activation.json'), JSON.stringify({ state: 'manual-recovery-required' }));
  assert.throws(() => execFileSync('/bin/sh', [path.join(p.bin, 'launch.sh')], { encoding: 'utf8', stdio: 'pipe' }), /manual database recovery/);
});

test('generated management shell command preserves arguments without evaluating them', async (t) => {
  const p = await fixture(t);
  const echo = path.join(p.bin, 'echo.mjs');
  await fs.writeFile(echo, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const wrapper = path.join(p.bin, 'echo.sh');
  await fs.writeFile(wrapper, shellLauncher(process.execPath, echo, p.home));
  const result = JSON.parse(execFileSync('/bin/sh', [wrapper, 'a b', '$(touch not-allowed)'], { encoding: 'utf8' }));
  assert.deepEqual(result, [p.home, 'a b', '$(touch not-allowed)']);
});

test('release copy excludes source credentials and dev dependencies, linking only external config', async (t) => {
  const p = await fixture(t);
  const source = path.join(p.home, 'source');
  const release = path.join(p.releases, 'copy');
  for (const name of ['dist', 'dist-server', 'public', 'shared', 'scripts', 'node_modules']) {
    await fs.mkdir(path.join(source, name), { recursive: true });
  }
  await fs.writeFile(path.join(source, 'dist/index.html'), '<html>hello</html>');
  await fs.writeFile(path.join(source, 'scripts/fix-node-pty.js'), '');
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'test', scripts: { prepare: 'husky' } }));
  await fs.writeFile(path.join(source, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(source, '.env'), 'SECRET=never copy');
  await fs.writeFile(path.join(source, 'node_modules/dev-only'), '');
  await copyReleaseFiles(source, release, p.env);
  assert.equal(await fs.realpath(path.join(release, '.env')), p.env);
  await assert.rejects(fs.stat(path.join(release, 'node_modules/dev-only')), { code: 'ENOENT' });
  const manifest = JSON.parse(await fs.readFile(path.join(release, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.prepare, undefined);
  await fs.rm(source, { recursive: true });
  assert.equal(await fs.readFile(path.join(release, 'dist/index.html'), 'utf8'), '<html>hello</html>');
});

test('native smoke probe performs SQLite, bcrypt and a real PTY operation', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  await runNativeChecks(root, { node: process.execPath, path: process.env.PATH });
});
