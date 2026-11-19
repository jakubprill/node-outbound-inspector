import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorts, parseAppNames, loadConfig } from '../../src/config.mjs';

test('parsePorts: zakresy i pojedyncze porty', () => {
  assert.deepEqual(parsePorts('9229-9231,9300'), [9229, 9230, 9231, 9300]);
  assert.deepEqual(parsePorts(' 9231 , 9241 '), [9231, 9241]);
  assert.deepEqual(parsePorts(''), []);
});

test('parseAppNames', () => {
  assert.deepEqual(parseAppNames('9231=web, 9241 = admin'), { 9231: 'web', 9241: 'admin' });
  assert.deepEqual(parseAppNames(undefined), {});
});

test('loadConfig: wartości domyślne', () => {
  const c = loadConfig({ env: {} });
  assert.equal(c.ports.length, 21);
  assert.equal(c.ports[0], 9229);
  assert.deepEqual([...c.ignoreHosts], ['registry.npmjs.org']);
  assert.equal(c.maxRequests, 5000);
  assert.equal(c.pageCorrelation, true);
  assert.ok(Object.isFrozen(c));
});

test('loadConfig: zmienne środowiskowe', () => {
  const c = loadConfig({ env: { INSPECTOR_PORTS: '9231', IGNORE_HOSTS: '', PAGE_CORRELATION: '0', MAX_REQUESTS: '10', APP_NAMES: '9231=web' } });
  assert.deepEqual([...c.ports], [9231]);
  assert.deepEqual([...c.ignoreHosts], []);
  assert.equal(c.pageCorrelation, false);
  assert.equal(c.maxRequests, 10);
  assert.equal(c.appNames[9231], 'web');
});

test('loadConfig: eksport OTLP domyślnie pomijany, OUTBOUND_IGNORE_OTLP=0 wyłącza (issue #4)', () => {
  assert.equal(loadConfig({ env: {} }).ignoreOtlp, true);
  assert.equal(loadConfig({ env: { OUTBOUND_IGNORE_OTLP: '1' } }).ignoreOtlp, true);
  assert.equal(loadConfig({ env: { OUTBOUND_IGNORE_OTLP: '0' } }).ignoreOtlp, false);
});
