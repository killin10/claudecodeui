import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [directory, source, ...args] = process.argv.slice(2);
const status = path.join(directory, 'status.json');
const startedAt = new Date().toISOString();
async function record(data) {
  const temp = `${status}.next`;
  await fs.writeFile(temp, JSON.stringify({ source, startedAt, ...data }, null, 2), { mode: 0o600 });
  await fs.rename(temp, status);
}

await record({ state: 'running', pid: process.pid });
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(source, 'scripts/deploy/deploy.mjs'), ...args], {
      cwd: source, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await record({ state: result.code === 0 ? 'succeeded' : 'failed', ...result, finishedAt: new Date().toISOString() });
  process.exitCode = result.code === 0 ? 0 : 1;
} catch (error) {
  await record({ state: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  process.exitCode = 1;
}
