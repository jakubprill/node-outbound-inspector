import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppName, processWarnings } from '../../src/session.mjs';

test('nazwa aplikacji: APP_NAMES → npm_package_name → package.json → katalog → port', () => {
  const base = { port: 9231, appNames: {}, pkg: null, pkgName: null, cwd: null };
  assert.equal(resolveAppName({ ...base, appNames: { 9231: 'web' }, pkg: '@a/b', pkgName: '@c/d', cwd: '/x/y' }), 'web');
  assert.equal(resolveAppName({ ...base, pkg: '@a/b', pkgName: '@c/d', cwd: '/x/y' }), '@a/b');
  assert.equal(resolveAppName({ ...base, pkgName: '@c/d', cwd: '/x/y' }), '@c/d');
  assert.equal(resolveAppName({ ...base, cwd: '/x/y' }), 'y');
  assert.equal(resolveAppName(base), 'port-9231');
});

test('flaga sieciowa z execArgv: Network.enable bez flagi nie wystarcza (wada 2)', () => {
  const noFlag = processWarnings({ execArgv: ['--inspect=127.0.0.1:9231'], node: 'v24.1.0', networkEnabled: true });
  assert.equal(noFlag.networkInspection, false);
  assert.match(noFlag.warnings[0], /without --experimental-network-inspection/);
  const ok = processWarnings({ execArgv: ['--experimental-network-inspection'], node: 'v24.1.0', networkEnabled: true });
  assert.deepEqual(ok, { networkInspection: true, warnings: [] });
  const node22 = processWarnings({ execArgv: ['--experimental-network-inspection'], node: 'v22.23.5', networkEnabled: true });
  assert.equal(node22.networkInspection, false, 'Node < 24 nie jest podsłuchiwany');
  assert.match(node22.warnings[0], /Node 22\.23\.5, but Node ≥ 24 is required/);
});

test('consent: zgoda przez OUTBOUND_INSPECT albo flagę sieciową, ten sam użytkownik (audyt B-01)', async () => {
  const { consent } = await import('../../src/session.mjs');
  assert.deepEqual(consent({ optIn: true, execArgv: [] }, 501), { allowed: true });
  assert.deepEqual(consent({ optIn: false, execArgv: ['--experimental-network-inspection'] }, 501), { allowed: true });
  assert.equal(consent({ optIn: false, execArgv: ['--inspect=9229'] }, 501).reason, 'no_consent');
  assert.equal(consent({ uid: 0, optIn: true, execArgv: [] }, 501).reason, 'other_user', 'inny użytkownik mimo zgody');
  assert.deepEqual(consent({ uid: null, optIn: true }, 501), { allowed: true }, 'system bez uid (Windows)');
  assert.deepEqual(consent({ uid: 501, optIn: true }, null), { allowed: true });
});
