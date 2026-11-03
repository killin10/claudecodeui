import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrowserRuntimeManager } from '@/modules/browser-use/browser-runtime-manager.js';

async function fixture(t: test.TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-runtime-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const browser = path.join(home, 'chromium');
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let fail = '';
  const run = async (command: string, args: string[], cwd: string) => {
    calls.push({ command, args, cwd });
    const isPackage = args[0] === 'install';
    if (fail === (isPackage ? 'package' : 'browser')) throw new Error('fixture install failure');
    if (!isPackage) {
      await fs.writeFile(browser, 'fake executable');
      return;
    }
    const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    const packagePath = path.join(cwd, 'node_modules/playwright');
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(path.join(packagePath, 'package.json'), JSON.stringify({ version: manifest.dependencies.playwright, main: 'index.cjs' }));
    await fs.writeFile(path.join(packagePath, 'index.cjs'), `module.exports={chromium:{executablePath:()=>${JSON.stringify(browser)}}};`);
    await fs.writeFile(path.join(packagePath, 'cli.js'), '');
  };
  return { home, browser, calls, run, setFailure: (value: string) => { fail = value; } };
}

test('runtime survives service recreation and package versions coexist outside releases', async (t) => {
  const f = await fixture(t);
  const one = createBrowserRuntimeManager({ home: f.home, version: '1.64.1', run: f.run });
  assert.equal(one.get(), null);
  await one.install();
  assert.ok(one.get());
  assert.ok(f.calls.every((call) => call.cwd.startsWith(path.join(f.home, '.cloudcli/browser-use/runtimes'))));
  const restored = createBrowserRuntimeManager({ home: f.home, version: '1.64.1', run: f.run });
  const count = f.calls.length;
  await restored.install();
  assert.equal(f.calls.length, count, 'healthy shared runtime must not reinstall on redeploy');
  const two = createBrowserRuntimeManager({ home: f.home, version: '1.65.0', run: f.run });
  await two.install();
  assert.ok(restored.get());
  assert.ok(two.get());
  assert.notEqual(one.directory, two.directory);
});

test('failed package/browser installs release the lock and remain unavailable until retry succeeds', async (t) => {
  const f = await fixture(t);
  const manager = createBrowserRuntimeManager({ home: f.home, run: f.run });
  f.setFailure('package');
  await assert.rejects(manager.install(), /fixture install failure/);
  assert.equal(manager.get(), null);
  await assert.rejects(fs.stat(manager.directory + '.lock'), { code: 'ENOENT' });
  f.setFailure('browser');
  await assert.rejects(manager.install(), /fixture install failure/);
  assert.equal(manager.get(), null);
  const count = f.calls.filter((call) => call.args[0] === 'install').length;
  f.setFailure('');
  await manager.install();
  assert.ok(manager.get());
  assert.equal(f.calls.filter((call) => call.args[0] === 'install').length, count);
  await fs.rm(f.browser);
  await manager.install();
  assert.ok(await fs.stat(f.browser));
});

test('concurrent callers share installation; other processes cannot replace its files', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = createBrowserRuntimeManager({ home: f.home, run: async (...args) => { started(); await gate; await f.run(...args); } });
  const first = manager.install();
  assert.equal(manager.install(), first);
  await ready;
  const other = createBrowserRuntimeManager({ home: f.home, run: f.run });
  await assert.rejects(other.install(), /installation is locked/);
  assert.equal(other.get(), null);
  release();
  await first;
  assert.ok(other.get());
});

test('installation refuses an existing directory without its ownership marker', async (t) => {
  const f = await fixture(t);
  const manager = createBrowserRuntimeManager({ home: f.home, run: f.run });
  await fs.mkdir(manager.directory, { recursive: true });
  const existing = path.join(manager.directory, 'user-file');
  await fs.writeFile(existing, 'preserve');
  await assert.rejects(manager.install(), /unowned runtime/);
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserve');
});
