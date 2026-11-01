import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRelease, selectRelease } from './layout.mjs';

/** Caller holds the operation lock. The adapter owns all OS/database effects. */
export async function activate(p, release, adapter, { rollback = false } = {}) {
  const old = await resolveRelease(p);
  const metadataPath = path.join(release, 'release.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await adapter.preflight(release);
  if (rollback && metadata.databaseSchema !== await adapter.schema()) {
    throw new Error('Rollback target has an incompatible database schema; restore a reviewed backup manually first.');
  }
  await adapter.stop();
  let backup;
  let before;
  let attemptedStart = false;
  const record = async (state, extra = {}) => fs.writeFile(path.join(p.run, 'activation.json'), `${JSON.stringify({ state, old, release, backup, at: new Date().toISOString(), ...extra }, null, 2)}\n`, { mode: 0o600 });
  try {
    before = await adapter.schema();
    backup = await adapter.backup();
    await record('prepared');
    await selectRelease(p, 'current', release);
    attemptedStart = true;
    await adapter.start();
    await adapter.check(release);
    metadata.databaseSchema = await adapter.schema();
    metadata.activatedAt = new Date().toISOString();
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    if (old && old !== release) await selectRelease(p, 'previous', old);
    await record('healthy');
  } catch (error) {
    // Never overwrite application data to make a failed installation look healthy.
    if (attemptedStart) await adapter.stop();
    if (old) {
      if (attemptedStart && before !== await adapter.schema()) {
        await record('manual-recovery-required', { error: error.message });
        throw new Error(`${error.message}; database schema changed: service stopped. Review backup ${backup || '(none)'} before recovery.`, { cause: error });
      }
      await selectRelease(p, 'current', old);
      await adapter.start();
      await adapter.check(old);
      await record('restored', { error: error.message });
      throw new Error(`${error.message}; previous release restored (database was not restored).`, { cause: error });
    }
    await fs.rm(path.join(p.root, 'current'), { force: true });
    await record('failed', { error: error.message });
    throw error;
  }
}
