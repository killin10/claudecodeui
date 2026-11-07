import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOwned, exists, readConfig } from './layout.mjs';
import { checkHttp, databaseState, ensurePortFree, localUrl } from './service-health.mjs';

const exec = promisify(execFile);

export async function createManagedAdapter(p, release, controller) {
  await assertOwned(p);
  const config = await readConfig(p);
  const { runtime } = config;
  const metadata = () => fs.readFile(path.join(release, 'release.json'), 'utf8').then(JSON.parse);
  const state = () => databaseState(release, runtime.node, config.database);
  return {
    ...controller,
    async preflight() {
      const currentJob = await controller.status();
      const version = (await exec(runtime.node, ['--version'], { encoding: 'utf8' })).stdout.trim();
      if (version !== runtime.nodeVersion || version !== (await metadata()).nodeVersion) throw new Error('Node version mismatch: re-deploy with configured runtime');
      const db = await state();
      if (!db.hasUsers && !['127.0.0.1', '::1'].includes(config.host)) {
        throw new Error('Account setup is required. Set HOST=127.0.0.1 in server.env, initialize your account locally, then set HOST=0.0.0.0 and restart.');
      }
      if (!currentJob.loaded) await ensurePortFree(config.host, config.port);
    },
    async check(expectedRelease) {
      const expected = JSON.parse(await fs.readFile(path.join(expectedRelease, 'release.json'), 'utf8'));
      const deadline = Date.now() + 60000;
      let lastError;
      do {
        try {
          const current = await controller.status();
          const marker = JSON.parse(await fs.readFile(path.join(p.home, '.cloudcli/local-server.json'), 'utf8'));
          if (!current.pid || marker.pid !== current.pid || marker.appRoot !== expectedRelease) throw new Error('Server marker does not match service PID/release');
          await checkHttp(localUrl(config), expected.version);
          return;
        } catch (error) { lastError = error; }
        await delay(300);
      } while (Date.now() < deadline);
      throw new Error(`Readiness timed out: ${lastError?.message}. See ${p.logs}`);
    },
    async schema() { return (await state()).schema; },
    async backup() {
      if (!await exists(config.database)) return null;
      const destination = path.join(p.backups, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-auth.db`);
      await databaseState(release, runtime.node, config.database, destination);
      await fs.chmod(destination, 0o600);
      return destination;
    },
  };
}
