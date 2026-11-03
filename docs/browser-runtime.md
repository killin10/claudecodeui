# Browser runtime across deployments

Browser Use installs Playwright independently of the application release. The pinned version is defined in `server/modules/browser-use/browser-runtime-manager.ts`; the current pin is `1.64.1`.

The package and its lockfile live under `~/.cloudcli/browser-use/runtimes/playwright-<version>/`. Browser profiles remain under `~/.cloudcli/browser-use/profiles/`. Chromium uses Playwright's standard OS cache, including `~/Library/Caches/ms-playwright` on macOS. An existing `PLAYWRIGHT_BROWSERS_PATH` override is respected by both the installer and the server; use the same environment for both.

The Browser panel's install action installs the pinned package in a temporary directory, validates its version, then publishes it in the persistent runtime directory. It invokes that package's own CLI to install matching Chromium. A `ready.json` marker is written only after the executable exists. A failed browser download can be retried without reinstalling the package. Status checks require the marker, package and executable; they never load a package from the active release as a fallback.

An in-process promise joins simultaneous install requests. A per-version `.lock` directory prevents separate processes from modifying the same installation. Normal success and failure remove the lock. After a process or machine crash, inspect the lock's `owner.json` and confirm that its installer is no longer running before removing that lock. The installer refuses to replace a directory without its ownership marker.

Rebuilding, switching or pruning releases does not remove these runtime directories. Changing the Playwright pin creates a different directory so that older releases can keep their dependency version. Old runtime directories are not automatically pruned. Linux still needs Playwright's Chromium system dependencies and may require administrator installation of those OS packages.

## Managed MCP registration

The local deployment launcher sets `CLOUDCLI_BROWSER_USE_MCP_COMMAND` to `~/.local/bin/cloudcli`. Browser Use registers that absolute command with the `browser-use-mcp` argument. The installed launcher resolves the active `current` release on every invocation. The existing API URL and token remain part of the MCP environment.

On startup, an enabled Browser setting refreshes the managed MCP registration for each provider. Registration failures are logged and are also returned by the settings action. Disabled Browser settings do not register a server at startup. Other installation modes retain their existing executable resolution and refresh their registration on startup too.

Existing provider processes may have already loaded their MCP configuration. A newly started provider process reads the refreshed registration. Browser runtime availability and MCP tool discovery are separate checks: tools can be listed even if Chromium is not yet installed.
