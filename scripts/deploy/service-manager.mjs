import fs from 'node:fs/promises';
import * as launchd from './launchd.mjs';
import * as systemd from './systemd.mjs';

const manager = p => p.platform === 'linux' ? systemd : launchd;
export const jobStatus = p => manager(p).jobStatus(p);
export const disableService = p => manager(p).disableService(p);
export const createServiceAdapter = (p, release) => p.platform === 'linux'
  ? systemd.createSystemdAdapter(p, release)
  : launchd.createLaunchdAdapter(p, release);

export async function removeService(p) {
  if (p.platform === 'linux') return systemd.removeService(p);
  await fs.rm(p.plist, { force: true });
}
