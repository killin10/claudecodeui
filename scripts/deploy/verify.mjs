// Runs the checks deploy would run (full typecheck and lint) and, when they
// pass, records the tree's content hash so `npm run deploy:local` can skip
// them for exactly this tree. Any later edit changes the hash.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, treeFingerprint, writeVerifiedStamp } from './release.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

try {
  const before = await treeFingerprint(source);
  for (const script of ['typecheck', 'lint']) await run('npm', ['run', script], { cwd: source });
  // An edit made while the checks ran was not necessarily checked.
  if (await treeFingerprint(source) !== before) throw new Error('Files changed while checks ran; run npm run verify again.');
  await writeVerifiedStamp(source, before);
  console.log('[verify] typecheck and lint passed; the next deploy of this exact tree will skip them.');
} catch (error) {
  console.error(`[verify] ${error.message}`);
  process.exitCode = 1;
}
