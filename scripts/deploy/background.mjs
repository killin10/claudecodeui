import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userBusEnvironment } from './systemd.mjs';

const exec = promisify(execFile);

export function backgroundArguments({ unit, directory, node, worker, source, args, env }) {
  // D-Bus values are literal (unlike unit files' % specifiers). ExecStart argv
  // still expands environment variables on systemd 252, so escape dollars.
  const literal = value => value.replaceAll('$', () => '$$');
  return [
    '--user', '--collect', `--unit=${unit}`, '--property=Type=exec', '--property=UMask=0077',
    `--property=StandardOutput=append:${directory}/deploy.log`,
    `--property=StandardError=append:${directory}/deploy.log`,
    '--setenv=PATH',
    // Forward selected variables by name so proxy credentials never enter argv/errors.
    ...['SSH_AUTH_SOCK', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS'].filter(key => env[key]).map(key => `--setenv=${key}`),
    '--', node, ...[worker, directory, source, ...args].map(literal),
  ];
}

export async function startBackgroundDeployment(p, source, node, args, execute = exec) {
  const directory = await fs.mkdtemp(path.join(p.logs, 'deploy-'));
  const unit = `cloudcli-deploy-${path.basename(directory).slice(7)}`;
  const status = path.join(directory, 'status.json');
  await fs.writeFile(status, JSON.stringify({ state: 'queued', unit, source, at: new Date().toISOString() }), { mode: 0o600 });
  const worker = path.join(source, 'scripts/deploy/background-worker.mjs');
  try {
    await execute('/usr/bin/systemd-run', backgroundArguments({ unit, directory, node, worker, source, args, env: process.env }), {
      encoding: 'utf8', env: { ...userBusEnvironment(), PATH: process.env.PATH || '/usr/bin:/bin' }, timeout: 30000,
    });
  } catch (error) {
    await fs.writeFile(status, JSON.stringify({ state: 'failed', error: error.message, unit }));
    throw error;
  }
  console.log(`Deployment submitted (not yet complete).\nStatus: ${status}\nLog: ${path.join(directory, 'deploy.log')}\nUnit: ${unit}.service`);
  return directory;
}
