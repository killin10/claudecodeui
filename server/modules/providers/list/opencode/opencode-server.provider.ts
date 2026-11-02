import crypto from 'node:crypto';
import net from 'node:net';

import spawn from 'cross-spawn';
import { OpenCode } from '@opencode/client';

const START_TIMEOUT_MS = 60_000;

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('No free port for OpenCode.'));
      });
    });
  });
}

function spawnTurnServer(port: number, signal: AbortSignal) {
  const password = crypto.randomBytes(24).toString('base64url');
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      CLOUDCLI_OPENCODE_OWNER_PID: String(process.pid),
    },
  });
  let failure: Error | undefined;
  let output = '';
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (error) => { failure = error; });
  child.on('exit', (code) => {
    failure = new Error(`OpenCode server exited (${code}): ${output.replaceAll(password, '[redacted]')}`);
  });
  let stopping = false;
  const close = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    child.kill();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
  signal.addEventListener('abort', close, { once: true });
  child.once('exit', () => signal.removeEventListener('abort', close));
  const client = OpenCode.make({
    baseUrl: url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });
  return { server: { url, close }, client, failure: () => failure, output: () => output };
}

async function awaitReady(running: ReturnType<typeof spawnTurnServer>, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const failure = running.failure();
    if (failure) throw failure;
    // Probe the API, not the CLI's human-facing startup banner.
    const info = await running.client.server.info({ signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })
      .catch(() => null);
    if (info) {
      const version = /^(\d+)\.(\d+)\.(\d+)/.exec(info.version);
      const [major, minor, patch] = version?.slice(1).map(Number) ?? [];
      if (major !== 2 || minor < 1 || (minor === 1 && patch < 4)) {
        throw new Error(`CloudCLI requires OpenCode V2 (2.1.4 or newer); installed version is ${info.version}. Run opencode upgrade.`);
      }
      return;
    }
    if (/opencode server listening/i.test(running.output())) {
      throw new Error('CloudCLI requires OpenCode V2. This CLI uses the V1 protocol; run opencode upgrade.');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('OpenCode V2 server did not become ready within 60000ms. Check opencode serve and its logs.');
}

/** Used by the OpenCode runtime to own an authenticated V2 server for a single turn. */
export async function startOpenCodeServer(signal: AbortSignal) {
  signal.throwIfAborted();
  const port = await reservePort();
  signal.throwIfAborted();
  const running = spawnTurnServer(port, signal);
  try {
    await awaitReady(running, signal);
    return { server: running.server, client: running.client };
  } catch (error) {
    running.server.close();
    throw error;
  }
}
