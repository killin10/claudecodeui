import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { LABEL, assertOwned, exists, readConfig, renderPlist, verifyPlist } from './layout.mjs';

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

export async function ensurePortFree(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => reject(new Error(`Port ${host}:${port} is occupied or unavailable: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()));
  });
}

/** Uses the release's native dependency, without importing any application bootstrap. */
export async function databaseState(release, node, file, backup = null) {
  if (!await exists(file)) return { schema: null, hasUsers: false };
  const { stdout } = await exec(node, ['--input-type=commonjs', '-e', `
    const crypto = require('node:crypto');
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    (async () => {
      try {
        const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
        const version = db.pragma('user_version', { simple: true });
        const hasUsers = schema.some(row => row.name === 'users' && row.type === 'table') && !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
        if (process.argv[2]) await db.backup(process.argv[2]);
        console.log(JSON.stringify({ schema: crypto.createHash('sha256').update(JSON.stringify({schema, version})).digest('hex'), hasUsers }));
      } finally { db.close(); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `, file, ...(backup ? [backup] : [])], { cwd: release, timeout: 30000, encoding: 'utf8' });
  return JSON.parse(stdout);
}

export async function checkHttp(base, version) {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`Health returned HTTP ${health.status}`);
  const body = await health.json();
  if (body.status !== 'ok' || body.version !== version) throw new Error('Health/version does not match installed release');
  const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
  const html = await page.text();
  const asset = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"?]+\.js)"/)?.[1];
  if (!page.ok || !asset) throw new Error('Frontend entrypoint is unavailable');
  const response = await fetch(`${base}${asset}`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('javascript')) throw new Error('Frontend asset is unavailable');
  await response.arrayBuffer();
}

export function localUrl(config) {
  return `http://${config.host.includes(':') ? '[::1]' : '127.0.0.1'}:${config.port}`;
}

export async function rotateLogs(p) {
  for (const name of ['stdout.log', 'stderr.log']) {
    const file = path.join(p.logs, name);
    if (!await exists(file)) continue;
    if (!(await fs.lstat(file)).isFile()) throw new Error(`Not a regular log file: ${file}`);
    if ((await fs.stat(file)).size < 10 * 1024 * 1024) continue;
    await fs.rm(`${file}.3`, { force: true });
    for (let index = 2; index >= 1; index--) {
      if (await exists(`${file}.${index}`)) await fs.rename(`${file}.${index}`, `${file}.${index + 1}`);
    }
    await fs.rename(file, `${file}.1`);
  }
}

export async function createLaunchdAdapter(p, release) {
  await assertOwned(p);
  const config = await readConfig(p);
  const { runtime } = config;
  const metadata = () => fs.readFile(path.join(release, 'release.json'), 'utf8').then(JSON.parse);
  const state = () => databaseState(release, runtime.node, config.database);
  return {
    async preflight() {
      const currentJob = await jobStatus(p);
      const version = (await exec(runtime.node, ['--version'], { encoding: 'utf8' })).stdout.trim();
      if (version !== runtime.nodeVersion || version !== (await metadata()).nodeVersion) throw new Error('Node version mismatch: re-deploy with configured runtime');
      const db = await state();
      if (!db.hasUsers && !['127.0.0.1', '::1'].includes(config.host)) {
        throw new Error('Account setup is required. Set HOST=127.0.0.1 in server.env, initialize your account locally, then set HOST=0.0.0.0 and restart.');
      }
      if (!currentJob.loaded) await ensurePortFree(config.host, config.port);
    },
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
    async check(expectedRelease) {
      const expected = JSON.parse(await fs.readFile(path.join(expectedRelease, 'release.json'), 'utf8'));
      const deadline = Date.now() + 60000;
      let lastError;
      do {
        try {
          const current = await jobStatus(p);
          const marker = JSON.parse(await fs.readFile(path.join(p.home, '.cloudcli/local-server.json'), 'utf8'));
          if (!current.pid || marker.pid !== current.pid || marker.appRoot !== expectedRelease) throw new Error('Server marker does not match launchd PID/release');
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

export async function disableService() { await launchctl(['disable', job()]); }
