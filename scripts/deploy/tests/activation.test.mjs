import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initialize, paths, resolveRelease, selectRelease } from '../layout.mjs';
import { activate } from '../activation.mjs';

async function fixture(t, { first = false, fail = false, changedSchema = false, backupFail = false } = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-activation-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const p = paths(home);
  await initialize(p, { node: process.execPath, nodeVersion: process.version, path: '/usr/bin:/bin' });
  const old = path.join(p.releases, 'old');
  const next = path.join(p.releases, 'next');
  for (const dir of [old, next]) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify({ id: path.basename(dir), databaseSchema: 'schema-v1' }));
  }
  if (!first) await selectRelease(p, 'current', old);
  let running = first ? null : old;
  let schema = 'schema-v1';
  const operations = [];
  const adapter = {
    async preflight() { operations.push('preflight'); },
    async stop() { operations.push('stop'); running = null; },
    async backup() {
      assert.equal(running, null, 'backup must run after stop');
      operations.push('backup');
      if (backupFail) throw new Error('backup failed');
      return '/backup/auth.db';
    },
    async schema() { return schema; },
    async start() {
      running = await resolveRelease(p);
      operations.push(`start:${path.basename(running)}`);
      if (running === next && changedSchema) schema = 'schema-v2';
    },
    async check(release) {
      assert.equal(running, release);
      if (release === next && fail) throw new Error('unhealthy');
    },
  };
  return { p, old, next, adapter, operations, running: () => running };
}

test('activation backs up stopped database and promotes current/previous only on success', async (t) => {
  const f = await fixture(t);
  await activate(f.p, f.next, f.adapter);
  assert.equal(await resolveRelease(f.p), f.next);
  assert.equal(await resolveRelease(f.p, 'previous'), f.old);
  assert.deepEqual(f.operations, ['preflight', 'stop', 'backup', 'start:next']);
  assert.equal(f.running(), f.next);
});

test('failed new release restores old code without restoring or deleting database data', async (t) => {
  const f = await fixture(t, { fail: true });
  await assert.rejects(activate(f.p, f.next, f.adapter), /unhealthy.*restored/s);
  assert.equal(await resolveRelease(f.p), f.old);
  assert.equal(f.running(), f.old);
  assert.equal(await resolveRelease(f.p, 'previous'), null);
});

test('schema change blocks automatic recovery and leaves service stopped with backup details', async (t) => {
  const f = await fixture(t, { fail: true, changedSchema: true });
  await assert.rejects(activate(f.p, f.next, f.adapter), /schema changed.*backup/s);
  assert.equal(f.running(), null);
  assert.equal(await resolveRelease(f.p), f.next);
});

test('failed first install stops the service and removes the active link, keeping release files', async (t) => {
  const f = await fixture(t, { first: true, fail: true });
  await assert.rejects(activate(f.p, f.next, f.adapter), /unhealthy/);
  assert.equal(f.running(), null);
  assert.equal(await resolveRelease(f.p), null);
  assert.equal((await fs.stat(f.next)).isDirectory(), true);
});

test('backup failure restarts old service before changing current', async (t) => {
  const f = await fixture(t, { backupFail: true });
  await assert.rejects(activate(f.p, f.next, f.adapter), /backup failed/);
  assert.equal(f.running(), f.old);
  assert.equal(await resolveRelease(f.p), f.old);
});

test('explicit rollback refuses target whose recorded database schema is incompatible', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.next, 'release.json'), JSON.stringify({ databaseSchema: 'older-schema' }));
  await assert.rejects(activate(f.p, f.next, f.adapter, { rollback: true }), /incompatible/);
  assert.equal(f.running(), f.old);
  assert.equal(await resolveRelease(f.p), f.old);
});
