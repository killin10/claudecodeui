import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

const PLAYWRIGHT_VERSION = '1.64.1';
const OWNER = 'cloudcli-browser-runtime-v1';

type BrowserPackage = { chromium: { executablePath(): string; [key: string]: any }; [key: string]: any };
type CommandRunner = (command: string, args: string[], cwd: string) => Promise<void>;

/** Runs only the runtime installer, with bounded output and an explicit working directory. */
async function runInstaller(command: string, args: string[], cwd: string): Promise<void> {
  const timeout = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS || '600000', 10);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS must be a positive number.');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16384); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      timedOut = true;
      // This is the process group created for this installer, never an existing browser.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error);
        }
      } else {
        child.kill('SIGKILL');
      }
    }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Browser runtime installer timed out after ${timeout}ms.`));
      else if (code === 0) resolve();
      else reject(new Error(output.trim() || `Browser runtime installer exited with code ${code}.`));
    });
  });
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Browser Use owns versioned packages outside releases; tests inject the home, version and installer. */
export function createBrowserRuntimeManager(options: {
  home?: string;
  version?: string;
  run?: CommandRunner;
} = {}) {
  const version = options.version ?? PLAYWRIGHT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Browser runtime requires an exact Playwright version.');
  const root = path.join(options.home ?? os.homedir(), '.cloudcli/browser-use/runtimes');
  const directory = path.join(root, `playwright-${version}`);
  const ownerFile = path.join(directory, '.cloudcli-runtime.json');
  const readyFile = path.join(directory, 'ready.json');
  const lock = `${directory}.lock`;
  const run = options.run ?? runInstaller;
  let pending: Promise<void> | undefined;

  function loadPackage(): BrowserPackage | null {
    if (readJson(ownerFile)?.owner !== OWNER) return null;
    const packageDirectory = path.join(directory, 'node_modules/playwright');
    if (readJson(path.join(packageDirectory, 'package.json'))?.version !== version) return null;
    try {
      // An absolute package path prevents accidentally falling back to release/node_modules.
      const require = createRequire(path.join(directory, 'package.json'));
      const playwright = require(packageDirectory) as BrowserPackage;
      return typeof playwright?.chromium?.executablePath === 'function' ? playwright : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null;
      throw error;
    }
  }

  function get(): BrowserPackage | null {
    const ready = readJson(readyFile);
    if (ready?.version !== version || ready.platform !== process.platform || ready.arch !== process.arch) return null;
    return loadPackage();
  }

  async function preparePackage(): Promise<void> {
    if (fs.existsSync(directory)) {
      if (readJson(ownerFile)?.owner !== OWNER) throw new Error(`Refusing to replace an unowned runtime: ${directory}`);
      await fsp.rm(directory, { recursive: true });
    }
    const staging = await fsp.mkdtemp(path.join(root, `.playwright-${version}-`));
    try {
      await fsp.writeFile(path.join(staging, '.cloudcli-runtime.json'), JSON.stringify({ owner: OWNER, version }));
      await fsp.writeFile(path.join(staging, 'package.json'), JSON.stringify({ private: true, dependencies: { playwright: version } }));
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], staging);
      const installed = readJson(path.join(staging, 'node_modules/playwright/package.json'));
      if (installed?.version !== version || !fs.existsSync(path.join(staging, 'node_modules/playwright/cli.js'))) {
        throw new Error(`Installer did not produce Playwright ${version}.`);
      }
      await fsp.rename(staging, directory);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  async function installLocked(): Promise<void> {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    try { await fsp.mkdir(lock, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Browser runtime installation is locked. Check ${path.join(lock, 'owner.json')} before removing a stale lock.`);
      }
      throw error;
    }
    try {
      await fsp.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      if (!loadPackage()) await preparePackage();
      const playwright = loadPackage();
      if (!playwright) throw new Error('Installed Playwright could not be loaded.');
      const cli = path.join(directory, 'node_modules/playwright/cli.js');
      if (!get() || !fs.existsSync(playwright.chromium.executablePath())) {
        if (process.platform === 'linux') await run(process.execPath, [cli, 'install-deps', 'chromium'], directory);
        await run(process.execPath, [cli, 'install', 'chromium'], directory);
      }
      if (!fs.existsSync(playwright.chromium.executablePath())) throw new Error('Chromium executable is missing after installation.');
      const marker = `${readyFile}.next`;
      await fsp.writeFile(marker, JSON.stringify({ version, platform: process.platform, arch: process.arch }), { mode: 0o600 });
      await fsp.rename(marker, readyFile);
    } finally {
      await fsp.rm(lock, { recursive: true, force: true });
    }
  }

  return {
    directory,
    version,
    get,
    install(): Promise<void> {
      pending ??= installLocked().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
