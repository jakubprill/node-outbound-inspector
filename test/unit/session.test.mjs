import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppName } from '../../src/session.mjs';

test('nazwa aplikacji: APP_NAMES → npm_package_name → package.json → katalog → port', () => {
  const base = { port: 9231, appNames: {}, pkg: null, pkgName: null, cwd: null };
  assert.equal(resolveAppName({ ...base, appNames: { 9231: 'web' }, pkg: '@a/b', pkgName: '@c/d', cwd: '/x/y' }), 'web');
  assert.equal(resolveAppName({ ...base, pkg: '@a/b', pkgName: '@c/d', cwd: '/x/y' }), '@a/b');
  assert.equal(resolveAppName({ ...base, pkgName: '@c/d', cwd: '/x/y' }), '@c/d');
  assert.equal(resolveAppName({ ...base, cwd: '/x/y' }), 'y');
  assert.equal(resolveAppName(base), 'port-9231');
});
