import path from 'node:path';

export const UNIT = 'local.cloudcli.service';

export function unitPath(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths must not contain control characters');
  return value.replaceAll('%', '%%');
}

// systemd parses its own quoting and specifiers; this is not shell quoting.
export function unitQuote(value, { command = false } = {}) {
  const escaped = unitPath(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${command ? escaped.replaceAll('$', () => '$$') : escaped}"`;
}

export function renderUnit(p) {
  return `[Unit]
Description=CloudCLI local deployment
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=/bin/sh ${unitQuote(path.join(p.bin, 'launch.sh'), { command: true })}
Restart=always
RestartSec=15
# Let the main process save interrupted sessions before killing remaining children.
KillMode=mixed
TimeoutStopSec=45
UMask=0077
StandardOutput=append:${unitPath(path.join(p.logs, 'stdout.log'))}
StandardError=append:${unitPath(path.join(p.logs, 'stderr.log'))}

[Install]
WantedBy=default.target
`;
}
