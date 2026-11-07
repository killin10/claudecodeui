import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists } from './layout.mjs';

const exec = promisify(execFile);

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
