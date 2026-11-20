// App names (issue #8): without the npm scope, the name from portless, collisions, aliases for the filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIdentity, assignNames, portlessName, stripScope } from '../../src/names.mjs';
import { createStore } from '../../src/store.mjs';

const base = { port: 9231, appNames: {}, pkg: null, pkgName: null, cwd: null };

test('source order: APP_NAMES → portless → npm_package_name → package.json → directory → port', () => {
  assert.equal(appIdentity({ ...base, appNames: { 9231: 'web' }, pkg: '@a/b', portlessUrl: 'http://x.localhost:1355', cwd: '/x/y' }).short, 'web');
  assert.equal(appIdentity({ ...base, pkg: '@a/b', portlessUrl: 'http://x.localhost:1355' }).short, 'x');
  assert.equal(appIdentity({ ...base, pkg: '@a/b', pkgName: '@c/d', cwd: '/x/y' }).short, 'b');
  assert.equal(appIdentity({ ...base, pkgName: '@c/d', cwd: '/x/y' }).short, 'd');
  assert.equal(appIdentity({ ...base, cwd: '/x/y' }).short, 'y');
  assert.equal(appIdentity(base).short, 'port-9231');
});

test('npm scope: dropped by default, APP_NAME_STRIP_SCOPE=0 → full name; aliases contain both forms', () => {
  assert.deepEqual(appIdentity({ ...base, pkg: '@acme/web' }), { short: 'web', full: '@acme/web', aliases: ['web', '@acme/web'] });
  assert.equal(appIdentity({ ...base, pkg: '@acme/web' }, { stripScope: false }).short, '@acme/web');
  assert.deepEqual(appIdentity({ ...base, pkg: 'shop' }), { short: 'shop', full: 'shop', aliases: ['shop'] });
  assert.equal(stripScope('@acme/web'), 'web');
  assert.equal(stripScope('@acme/'), '@acme/');
  assert.equal(stripScope('web'), 'web');
  // portless: the name as in the browser, and the filter still finds the app by package name
  assert.deepEqual(appIdentity({ ...base, pkg: '@acme/web', portlessUrl: 'https://web.localhost' }).aliases.sort(), ['@acme/web', 'web']);
});

test('name from PORTLESS_URL', () => {
  assert.equal(portlessName('http://web.localhost:1355'), 'web');
  assert.equal(portlessName('https://fix-ui.myapp.localhost'), 'fix-ui.myapp');
  assert.equal(portlessName('https://myapp.dev.example.com'), 'myapp.dev.example.com');
  assert.equal(portlessName('not-a-url'), '');
  assert.equal(portlessName(null), '');
  assert.equal(portlessName('http://a\u0007b.localhost'), '');
});

test('short-name collision: the whole group gets full names, regardless of order', () => {
  const a = appIdentity({ ...base, pkg: '@a/web' }), b = appIdentity({ ...base, pkg: '@b/web' }), c = appIdentity({ ...base, pkg: '@a/admin' });
  assert.deepEqual(assignNames([a, b, c]), ['@a/web', '@b/web', 'admin']);
  assert.deepEqual(assignNames([c, b, a]), ['admin', '@b/web', '@a/web']);
  // two processes of the same app (e.g. a restart, two ports) are not a collision
  assert.deepEqual(assignNames([a, a]), ['web', 'web']);
  // `web` without a scope and `@a/web` are different packages
  assert.deepEqual(assignNames([appIdentity({ ...base, pkg: 'web' }), a]), ['web', '@a/web']);
});

test('app filter: display name, full package name, name without scope and port', () => {
  const store = createStore({ maxRequests: 10 });
  store.add({ key: '1:a', processId: 1, app: 'web', appAliases: ['web', '@acme/web'], port: 9231, url: 'http://x/1', wallStart: 1, tsStart: 1 });
  store.add({ key: '2:a', processId: 2, app: 'admin', appAliases: ['admin', '@acme/admin'], port: 9241, url: 'http://x/2', wallStart: 2, tsStart: 2 });
  for (const app of ['web', '@acme/web', '9231']) assert.deepEqual(store.select({ app }).map(r => r.url), ['http://x/1'], app);
  assert.equal(store.select({ app: '@acme' }).length, 0);
  assert.equal(store.clear({ app: '@acme/admin' }), 1);
});
