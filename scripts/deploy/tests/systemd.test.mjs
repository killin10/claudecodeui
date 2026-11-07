import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, paths, verifyServiceFile } from '../layout.mjs';
import { renderUnit, unitQuote } from '../systemd-unit.mjs';
import { checkSystemdEnvironment, createSystemdAdapter, insideService, jobStatus, userBusEnvironment } from '../systemd.mjs';
import { backgroundArguments, startBackgroundDeployment } from '../background.mjs';
import { testArguments } from '../release.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-linux-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const p = paths(home, 'linux');
  await initialize(p, { node: process.execPath, nodeVersion: process.version, path: '/usr/bin:/bin' }, { setupLocal: true });
  return p;
}

function state(p, overrides = {}) {
  return { stdout: Object.entries({
    LoadState: 'loaded', ActiveState: 'active', MainPID: '1234', FragmentPath: p.unit,
    DropInPaths: '', NeedDaemonReload: 'no', ...overrides,
  }).map(([key, value]) => `${key}=${value}`).join('\n') };
}

test('Linux layout uses private XDG directories without creating macOS directories', async t => {
  const p = await fixture(t);
  assert.equal(p.logs, path.join(p.home, '.local/state/cloudcli/logs'));
  assert.equal(p.serviceFile, path.join(p.home, '.config/systemd/user/local.cloudcli.service'));
  assert.equal((await fs.stat(p.env)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(p.home, 'Library')), { code: 'ENOENT' });
  assert.throws(() => paths(p.home, 'win32'), /requires macOS or Linux/);
});

test('systemd unit escapes ExecStart and uses literal append paths, with graceful stop and boot startup', () => {
  const p = paths('/home/pi $USER %h "test"', 'linux');
  const unit = renderUnit(p);
  assert.ok(unit.includes('ExecStart=/bin/sh "/home/pi $$USER %%h \\"test\\"/'));
  assert.ok(unit.includes('StandardOutput=append:/home/pi $USER %%h "test"/'));
  assert.match(unit, /KillMode=mixed\nTimeoutStopSec=45/);
  assert.match(unit, /WantedBy=default.target/);
  assert.throws(() => unitQuote('/home/pi\nExecStart=bad'), /control characters/);
});

test('Linux systemd parser validates the generated user service', { skip: process.platform !== 'linux' }, async t => {
  const p = await fixture(t);
  await fs.writeFile(p.unit, renderUnit(p));
  const result = spawnSync('/usr/bin/systemd-analyze', ['--user', '--man=no', 'verify', p.unit], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.doesNotMatch(result.stderr, /Failed to parse|Unknown key|Unknown lvalue/i);
});

test('foreign or symlinked service files cannot be overwritten by initialization', async t => {
  const p = await fixture(t);
  await fs.writeFile(p.unit, 'user service');
  await assert.rejects(verifyServiceFile(p), /not managed/);
  await assert.rejects(initialize(p, {}), /not managed/);
  assert.equal(await fs.readFile(p.unit, 'utf8'), 'user service');
  await fs.rm(p.unit);
  await fs.symlink(p.env, p.unit);
  await assert.rejects(verifyServiceFile(p), /symbolic link/);
});

test('status distinguishes active, restarting, stopped and absent units', async t => {
  const p = await fixture(t);
  assert.deepEqual(await jobStatus(p, async () => state(p)), { loaded: true, pid: 1234 });
  assert.deepEqual(await jobStatus(p, async () => state(p, { ActiveState: 'activating', MainPID: '0' })), { loaded: true, pid: null });
  assert.deepEqual(await jobStatus(p, async () => state(p, { ActiveState: 'inactive', MainPID: '0' })), { loaded: false, pid: null });
  const absent = async () => { throw Object.assign(new Error('not found'), { stdout: 'LoadState=not-found\n' }); };
  assert.deepEqual(await jobStatus(p, absent), { loaded: false, pid: null });
});

test('status refuses a different loaded unit, overrides and stale definitions, and propagates bus errors', async t => {
  const p = await fixture(t);
  for (const override of [{ FragmentPath: '/etc/systemd/user/foreign.service' }, { DropInPaths: '/tmp/override.conf' }]) {
    await assert.rejects(jobStatus(p, async () => state(p, override)), /another installation/);
  }
  await assert.rejects(jobStatus(p, async () => state(p, { NeedDaemonReload: 'yes' })), /daemon-reload/);
  await assert.rejects(jobStatus(p, async () => { throw new Error('Failed to connect to bus'); }), /connect to bus/);
});

test('systemd start installs and enables the owned service, stop waits for the completed stop job', async t => {
  const p = await fixture(t);
  const calls = [];
  let active = false;
  const control = async args => {
    calls.push(args);
    if (args[0] === 'show') return state(p, { ActiveState: active ? 'active' : 'inactive', MainPID: active ? '1234' : '0' });
    if (args[0] === 'enable') active = true;
    if (args[0] === 'stop') active = false;
    return { stdout: '' };
  };
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await fs.writeFile(p.env, `HOST=127.0.0.1\nSERVER_PORT=${port}\n`);
  const adapter = await createSystemdAdapter(p, p.releases, control);
  await adapter.start();
  assert.equal(await fs.readFile(p.unit, 'utf8'), renderUnit(p));
  assert.ok(calls.some(args => args.join(' ') === 'enable --now local.cloudcli.service'));
  await adapter.stop();
  assert.equal(active, false);
  assert.equal(calls.at(-1)[0], 'show');
});

test('stop refuses database operations while the service is still active', async t => {
  const p = await fixture(t);
  const adapter = await createSystemdAdapter(p, p.releases, async () => state(p));
  await assert.rejects(adapter.stop(), /has not stopped/);
});

test('first installation rejects newly discovered drop-ins before enabling the service', async t => {
  const p = await fixture(t);
  const calls = [];
  let reloaded = false;
  const control = async args => {
    calls.push(args[0]);
    if (args[0] === 'daemon-reload') reloaded = true;
    if (args[0] === 'show') return reloaded
      ? state(p, { DropInPaths: '/etc/systemd/user/service.d/custom.conf' })
      : { stdout: 'LoadState=not-found' };
    return { stdout: '' };
  };
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await fs.writeFile(p.env, `HOST=127.0.0.1\nSERVER_PORT=${port}\n`);
  const adapter = await createSystemdAdapter(p, p.releases, control);
  await assert.rejects(adapter.start(), /another installation/);
  assert.ok(!calls.includes('enable'));
});

test('Linux installation fails early for missing user bus, disabled linger or root', async () => {
  const control = async () => ({ stdout: '' });
  await checkSystemdEnvironment(control, async () => ({ stdout: 'yes\n' }), 1000);
  await assert.rejects(checkSystemdEnvironment(control, async () => ({ stdout: 'no\n' }), 1000), /enable-linger/);
  await assert.rejects(checkSystemdEnvironment(async () => { throw new Error('no bus'); }, control, 1000), /Cannot contact/);
  await assert.rejects(checkSystemdEnvironment(control, control, 0), /not root/);
});

test('service cgroup detection supports unified and legacy hierarchy, excluding detached jobs', async () => {
  for (const cgroup of ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/local.cloudcli.service', '1:name=systemd:/user.slice/local.cloudcli.service/children']) {
    assert.equal(await insideService(async () => cgroup), true);
  }
  assert.equal(await insideService(async () => '0::/user.slice/cloudcli-deploy-abc.service'), false);
  assert.equal(await insideService(async () => '0::/app.slice/not-local.cloudcli.service'), false);
});

test('user bus environment preserves explicit session settings and supplies standard login defaults', () => {
  const defaults = userBusEnvironment({ PATH: '/usr/bin' }, 1000);
  assert.equal(defaults.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(defaults.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  const supplied = userBusEnvironment({ XDG_RUNTIME_DIR: '/custom', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/other' }, 1000);
  assert.equal(supplied.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/other');
});

test('background deployment uses a collectible independent unit and literal arguments', () => {
  const args = backgroundArguments({ unit: 'cloudcli-deploy-test', directory: '/tmp/deploy %h', node: '/usr/bin/node', worker: '/repo $USER/worker.mjs', source: '/repo $USER', args: ['--node', '/node %h'], env: { PATH: '/bin', HTTPS_PROXY: 'https://private:password@proxy', UNRELATED_SECRET: 'private' } });
  assert.ok(args.includes('--collect'));
  assert.ok(args.includes('--property=Type=exec'));
  assert.ok(args.includes('/repo $$USER/worker.mjs'));
  assert.ok(args.includes('/node %h'));
  assert.ok(args.includes('--property=StandardOutput=append:/tmp/deploy %h/deploy.log'));
  assert.ok(!args.some(arg => arg.includes('private')));
  assert.ok(args.includes('--setenv=HTTPS_PROXY'));
  assert.ok(!args.includes('--scope'));
});

test('failed background submission persists failure and does not claim completion', async t => {
  const p = await fixture(t);
  await assert.rejects(startBackgroundDeployment(p, '/source', process.execPath, [], async () => { throw new Error('unit refused'); }), /unit refused/);
  const [directory] = await fs.readdir(p.logs);
  const status = JSON.parse(await fs.readFile(path.join(p.logs, directory, 'status.json')));
  assert.equal(status.state, 'failed');
});

test('background worker persists success and failure after its child exits', async t => {
  const p = await fixture(t);
  const worker = fileURLToPath(new URL('../background-worker.mjs', import.meta.url));
  await fs.mkdir(path.join(p.home, 'scripts/deploy'), { recursive: true });
  for (const code of [0, 17]) {
    await fs.writeFile(path.join(p.home, 'scripts/deploy/deploy.mjs'), `process.exit(${code})`);
    const result = spawnSync(process.execPath, [worker, p.run, p.home], { encoding: 'utf8' });
    const status = JSON.parse(await fs.readFile(path.join(p.run, 'status.json')));
    assert.equal(status.state, code === 0 ? 'succeeded' : 'failed');
    assert.equal(status.code, code);
    assert.equal(result.status, code === 0 ? 0 : 1);
  }
});

test('ARM64 deployment limits test parallelism without skipping suites or changing Mac defaults', () => {
  assert.deepEqual(testArguments('test', 'linux', 'arm64'), ['run', 'test', '--', '--test-concurrency=1']);
  assert.deepEqual(testArguments('test:client', 'linux', 'arm64'), ['run', 'test:client', '--', '--maxWorkers=1', '--minWorkers=1']);
  assert.deepEqual(testArguments('test', 'darwin', 'arm64'), ['run', 'test']);
});
