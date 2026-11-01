import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkHttp, databaseState, ensurePortFree } from '../launchd.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(import.meta.url);

test('database backup preserves WAL data and schema fingerprint detects incompatible changes', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-db-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'auth.db');
  const backup = path.join(temp, 'backup.db');
  const Database = require('better-sqlite3');
  const db = new Database(file);
  t.after(() => db.close());
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (1, \'test\')');
  const state = await databaseState(root, process.execPath, file, backup);
  assert.equal(state.hasUsers, true);
  const saved = new Database(backup, { readonly: true });
  assert.equal(saved.prepare('select username from users').get().username, 'test');
  saved.close();
  db.exec('ALTER TABLE users ADD COLUMN extra TEXT');
  assert.notEqual((await databaseState(root, process.execPath, file)).schema, state.schema);
});

test('missing database is not created by inspection', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-no-db-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'missing.db');
  assert.deepEqual(await databaseState(root, process.execPath, file), { schema: null, hasUsers: false });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('readiness checks health version and actual frontend asset instead of accepting any HTTP 200', async (t) => {
  let version = '1.0';
  let assetStatus = 200;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', version })); }
    else if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><script type="module" src="/assets/app.js"></script></html>'); }
    else { res.statusCode = assetStatus; res.setHeader('content-type', 'application/javascript'); res.end('console.log(1)'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await checkHttp(base, '1.0');
  version = 'foreign';
  await assert.rejects(checkHttp(base, '1.0'), /version/);
  version = '1.0'; assetStatus = 404;
  await assert.rejects(checkHttp(base, '1.0'), /asset/);
  await assert.rejects(ensurePortFree('127.0.0.1', server.address().port), /occupied/);
});
