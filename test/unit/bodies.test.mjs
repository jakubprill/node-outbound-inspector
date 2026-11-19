import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBody, enforceBodyBudget } from '../../src/bodies.mjs';

const json = { type: 'Fetch', mimeType: 'application/json', responseHeaders: { 'content-type': 'application/json', 'content-length': '19' } };
const opts = (o = {}) => ({ nodeMajor: 24, maxStoredBytes: 1000, missingState: 'unavailable', ...o });

test('pełna treść', () => {
  assert.deepEqual(classifyBody({ body: '{"service":"/user"}', base64Encoded: false }, json, opts()), { state: 'available', data: '{"service":"/user"}', bytes: 19 });
});

test('Node 22: pusty łańcuch dla fetch → unavailable (wada 4)', () => {
  const b = classifyBody({ body: '', base64Encoded: false }, json, opts({ nodeMajor: 22 }));
  assert.equal(b.state, 'unavailable');
  assert.match(b.reason, /Node 22/);
  assert.equal(classifyBody({ body: '', base64Encoded: false }, { ...json, responseHeaders: { 'content-length': '0' } }, opts({ nodeMajor: 22 })).state, 'available', 'naprawdę pusta odpowiedź');
  assert.equal(classifyBody({ body: '', base64Encoded: false }, { type: 'Other', responseHeaders: {} }, opts({ nodeMajor: 22 })).state, 'available', 'node:http: pusta treść bez content-length to pusta odpowiedź');
});

test('brak treści w inspektorze: evicted (lazy) albo unavailable', () => {
  assert.equal(classifyBody(null, json, opts({ missingState: 'evicted' })).state, 'evicted');
  assert.equal(classifyBody(null, json, opts()).state, 'unavailable');
});

test('treść binarna nie jest dekodowana', () => {
  const b = classifyBody({ body: Buffer.from([0, 1, 2, 255]).toString('base64'), base64Encoded: true }, { responseHeaders: { 'content-type': 'image/png' } }, opts());
  assert.deepEqual(b, { state: 'skipped', bytes: 4, reason: 'treść binarna (image/png)' });
  assert.equal(classifyBody({ body: Buffer.from('{"a":1}').toString('base64'), base64Encoded: true }, json, opts()).data, '{"a":1}', 'tekst w base64 jest dekodowany');
});

test('obcięcie: limit kolektora i bufor inspektora', () => {
  const big = classifyBody({ body: 'x'.repeat(1500), base64Encoded: false }, { responseHeaders: {} }, opts());
  assert.equal(big.state, 'truncated'); assert.equal(big.data.length, 1000); assert.equal(big.bytes, 1500);
  const cut = classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '100' } }, opts());
  assert.equal(cut.state, 'truncated'); assert.match(cut.reason, /10 z 100/);
  assert.equal(classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '5', 'content-encoding': 'gzip' } }, opts()).state, 'available');
});

test('budżet treści: najpierw najstarsze bez błędu', () => {
  const rec = (status, n) => ({ status, body: { state: 'available', data: 'x'.repeat(n), bytes: n } });
  const rs = [rec(500, 40), rec(200, 40), rec(200, 40)];
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 1);
  assert.deepEqual(rs.map(r => r.body.state), ['available', 'evicted', 'available']);
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 0);
});
