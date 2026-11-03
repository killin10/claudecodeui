import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';

test('OpenCode availability uses native project models independently of credential heuristics', async (t) => {
  const provider = providerRegistry.resolveProvider('opencode');
  t.mock.method(provider.auth, 'getStatus', async () => ({ provider: 'opencode', installed: true, authenticated: false }));
  const paths: string[] = [];
  t.mock.method(provider.models, 'getSupportedModels', async (directory: string) => {
    paths.push(directory);
    if (directory === '/failed') throw new Error('native unavailable');
    return { OPTIONS: directory === '/empty' ? [] : [{ value: 'custom/model', label: 'Custom' }], DEFAULT: '' };
  });
  assert.equal((await providerAuthService.getProviderAuthStatus('opencode')).projectAvailability, undefined);
  assert.deepEqual(paths, [], 'ordinary installation checks must not spawn native discovery');
  const usable = await providerAuthService.getProviderAuthStatus('opencode', '/project');
  assert.equal(usable.authenticated, false);
  assert.deepEqual(usable.projectAvailability, { directory: '/project', modelCount: 1 });
  assert.equal((await providerAuthService.getProviderAuthStatus('opencode', '/empty')).projectAvailability?.modelCount, 0);
  const failed = await providerAuthService.getProviderAuthStatus('opencode', '/failed');
  assert.equal(failed.projectAvailability?.modelCount, null);
  assert.ok(failed.projectAvailability?.error);
  assert.deepEqual(paths, ['/project', '/empty', '/failed']);
});

test('a missing CLI reports unknown availability without spawning a host', async (t) => {
  const provider = providerRegistry.resolveProvider('opencode');
  t.mock.method(provider.auth, 'getStatus', async () => ({ installed: false, authenticated: false }));
  const read = t.mock.method(provider.models, 'getSupportedModels', async () => { throw new Error('must not run'); });
  assert.equal((await providerAuthService.getProviderAuthStatus('opencode', '/project')).projectAvailability?.modelCount, null);
  assert.equal(read.mock.callCount(), 0);
});
