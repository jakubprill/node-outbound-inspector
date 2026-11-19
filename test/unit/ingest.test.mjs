import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.mjs';
import { applyNetworkEvent, decodeBody } from '../../src/ingest.mjs';

const session = { port: 9231, app: '@acme/web', pid: 42 };
const ctx = { ignoreHosts: ['registry.npmjs.org'], inspectorPorts: [9231, 9241], nowMs: 5000 };
const willBeSent = (requestId, url, extra = {}) => ['Network.requestWillBeSent',
  { requestId, request: { method: 'GET', url, headers: { a: '1' } }, timestamp: 1.5, wallTime: 1000, initiator: { stack: { callFrames: [] } }, ...extra }];

test('pełny cykl zapytania i efekt pobrania treści', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/user'), ctx);
  applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { x: 'y' } } }, ctx);
  const effects = applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.65 }, ctx);
  assert.deepEqual(effects, [{ type: 'fetch-body', key: '9231:r1', requestId: 'r1' }]);
  const r = s.get('9231:r1');
  assert.equal(r.app, '@acme/web'); assert.equal(r.pid, 42); assert.equal(r.status, 200);
  assert.equal(r.state, 'finished'); assert.equal(r.tsEnd, 1.65); assert.equal(r.wallStart, 1000);
});

test('zerwane połączenie', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/x'), ctx);
  applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r1', timestamp: 2, errorText: 'ECONNREFUSED' }, ctx);
  assert.equal(s.get('9231:r1').state, 'failed');
  assert.equal(s.get('9231:r1').error, 'ECONNREFUSED');
});

test('pomija ignorowane hosty i ruch do inspektorów', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'https://registry.npmjs.org/next'), ctx);
  applyNetworkEvent(s, session, ...willBeSent('r2', 'http://127.0.0.1:9241/json/list'), ctx);
  applyNetworkEvent(s, session, ...willBeSent('r3', 'http://localhost:9231/json/list'), ctx);
  assert.equal(s.size, 0);
});

test('brak wallTime → czas kolektora; zdarzenia dla nieznanego zapytania są ignorowane', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/a', { wallTime: undefined }), ctx);
  assert.equal(s.get('9231:r1').wallStart, 5000);
  assert.deepEqual(applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'nope', timestamp: 1 }, ctx), []);
});

test('decodeBody', () => {
  assert.equal(decodeBody({ body: 'eyJhIjoxfQ==', base64Encoded: true }), '{"a":1}');
  assert.equal(decodeBody({ body: 'txt', base64Encoded: false }), 'txt');
  assert.equal(decodeBody(null), undefined);
});
