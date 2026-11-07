import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePortFree, rotateLogs } from './service-health.mjs';
export { checkHttp, databaseState, ensurePortFree, localUrl } from './service-health.mjs';
import { LABEL, readConfig, renderPlist, verifyPlist } from './layout.mjs';

import { createManagedAdapter } from './managed-service.mjs';

const exec = promisify(execFile);
const domain = () => `gui/${process.getuid()}`;
const job = () => `${domain()}/${LABEL}`;
const launchctl = (args) => exec('/bin/launchctl', args, { encoding: 'utf8' });

export async function jobStatus(p) {
  await verifyPlist(p);
  let output;
  try { output = (await launchctl(['print', job()])).stdout; } catch (error) {
    if (`${error.stderr}`.includes('Could not find service')) return { loaded: false, pid: null };
    throw error;
  }
  if (!output.includes(path.join(p.bin, 'launch.sh'))) throw new Error('Loaded local.cloudcli belongs to another installation');
  const pid = Number(output.match(/\bpid = (\d+)/)?.[1]) || null;
  return { loaded: true, pid };
}

export async function createLaunchdAdapter(p, release) {
  const config = await readConfig(p);
  return createManagedAdapter(p, release, {
    status: () => jobStatus(p),
    async stop() {
      const current = await jobStatus(p);
      if (!current.loaded) return;
      await launchctl(['bootout', job()]);
      if (current.pid) {
        const deadline = Date.now() + 35000;
        while (true) {
          try { process.kill(current.pid, 0); } catch (error) {
            if (error.code === 'ESRCH') break;
            throw error;
          }
          if (Date.now() >= deadline) throw new Error(`Owned service PID ${current.pid} did not exit; refusing to modify its database`);
          await delay(100);
        }
      }
    },
    async start() {
      await ensurePortFree(config.host, config.port);
      await verifyPlist(p);
      await rotateLogs(p);
      await fs.writeFile(p.plist, renderPlist(p), { mode: 0o600 });
      await exec('/usr/bin/plutil', ['-lint', p.plist]);
      await launchctl(['enable', job()]);
      await launchctl(['bootstrap', domain(), p.plist]);
    },
  });
}

export async function disableService() { await launchctl(['disable', job()]); }
