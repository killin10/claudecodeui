import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, readConfig, verifyServiceFile } from './layout.mjs';
import { ensurePortFree, rotateLogs } from './service-health.mjs';
import { createManagedAdapter } from './managed-service.mjs';
import { renderUnit, UNIT } from './systemd-unit.mjs';

const exec = promisify(execFile);

export function userBusEnvironment(env = process.env, uid = process.getuid()) {
  const directory = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return { ...env, XDG_RUNTIME_DIR: directory, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${directory}/bus` };
}

export const systemctl = (args) => exec('/usr/bin/systemctl', ['--user', ...args], {
  encoding: 'utf8', env: userBusEnvironment(), timeout: 60000,
});

export async function checkSystemdEnvironment(control = systemctl, execute = exec, uid = process.getuid()) {
  if (uid === 0) throw new Error('Run local deployment as a regular user, not root');
  await control(['show-environment']).catch(error => {
    throw new Error('Cannot contact the systemd user manager. Log in via SSH as the deployment user and enable linger with: sudo loginctl enable-linger "$USER"', { cause: error });
  });
  const result = await execute('/usr/bin/loginctl', ['show-user', String(uid), '--property=Linger', '--value'], { encoding: 'utf8', timeout: 10000 });
  if (result.stdout.trim() !== 'yes') {
    throw new Error('Enable boot startup before deploying: sudo loginctl enable-linger "$USER"');
  }
}

function properties(output) {
  return Object.fromEntries(output.trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

export async function jobStatus(p, control = systemctl) {
  await verifyServiceFile(p);
  let result;
  try {
    result = await control(['show', UNIT, '--property=LoadState,ActiveState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload']);
  } catch (error) {
    if (properties(error.stdout || '').LoadState === 'not-found') return { loaded: false, pid: null };
    throw error;
  }
  const state = properties(result.stdout);
  if (state.LoadState === 'not-found') return { loaded: false, pid: null };
  if (state.LoadState !== 'loaded' || state.FragmentPath !== p.unit || state.DropInPaths) {
    throw new Error('Loaded local.cloudcli.service belongs to another installation or has overrides');
  }
  if (state.NeedDaemonReload === 'yes') throw new Error('Service definition changed: inspect it and run systemctl --user daemon-reload before retrying');
  const loaded = ['active', 'activating', 'deactivating', 'reloading'].includes(state.ActiveState);
  return { loaded, pid: Number(state.MainPID) || null };
}

export async function insideService(read) {
  if (!read && process.platform !== 'linux') return false;
  const cgroup = await (read ? read() : fs.readFile('/proc/self/cgroup', 'utf8'));
  return cgroup.split('\n').some(line => line.split('/').includes(UNIT));
}

export async function assertOutsideService() {
  if (await insideService()) {
    throw new Error('This command would stop its own service cgroup. Run it from SSH, or use npm run deploy:local -- --background to deploy from a CloudCLI session.');
  }
}

export async function createSystemdAdapter(p, release, control = systemctl) {
  const config = await readConfig(p);
  return createManagedAdapter(p, release, {
    status: () => jobStatus(p, control),
    async stop() {
      await assertOutsideService();
      const current = await jobStatus(p, control);
      if (!current.loaded && !current.pid) return;
      // systemctl waits for the entire stop job, including remaining children.
      await control(['stop', UNIT]);
      const after = await jobStatus(p, control);
      if (after.loaded || after.pid) throw new Error('Service has not stopped; refusing to modify its database');
    },
    async start() {
      await jobStatus(p, control);
      await ensurePortFree(config.host, config.port);
      await verifyServiceFile(p);
      await rotateLogs(p);
      await fs.writeFile(p.unit, renderUnit(p), { mode: 0o600 });
      await control(['daemon-reload']);
      // A previously absent unit can acquire global drop-ins when first loaded.
      await jobStatus(p, control);
      await control(['enable', '--now', UNIT]);
    },
  });
}

export async function disableService(p, control = systemctl) {
  const state = await jobStatus(p, control);
  if (!state.loaded && !await exists(p.unit)) return;
  await control(['disable', UNIT]);
}

export async function removeService(p, control = systemctl) {
  await verifyServiceFile(p);
  await fs.rm(p.unit, { force: true });
  await control(['daemon-reload']);
}
