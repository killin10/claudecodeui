#!/usr/bin/env node

async function runCli(): Promise<number> {
  if (process.argv[2] === 'session') {
    const { runSessionCli } = await import('./session-cli.js');
    return runSessionCli(process.argv.slice(3));
  }
  // Bootstrap the server environment only for the original server commands.
  // eslint-disable-next-line boundaries/no-unknown
  await import('../../load-env.js');
  const { createCliApplication } = await import('./index.js');
  return createCliApplication().run(process.argv.slice(2));
}

runCli().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n❌ Error:', message);
  process.exitCode = 1;
});
