import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.mjs';
import { applyNetworkEvent, normalizeWallTime } from '../../src/ingest.mjs';
import { createRedactor } from '../../src/redact.mjs';

const session = { processId: 3, port: 9231, app: '@acme/web', pid: 42 };
const ctx = { ignoreHosts: ['registry.npmjs.org'], inspectorPorts: [9231, 9241], nowMs: 5000, redact: createRedactor({ key: Buffer.alloc(32) }), bodies: 'eager' };
const willBeSent = (requestId, url, extra = {}) => ['Network.requestWillBeSent',
  { requestId, request: { method: 'GET', url, headers: { a: '1' } }, timestamp: 1.5, wallTime: 1795097716628, initiator: { stack: { callFrames: [] } }, ...extra }];

test('pełny cykl zapytania i efekt pobrania treści', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/user'), ctx);
  applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { x: 'y' } } }, ctx);
  const effects = applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.65 }, ctx);
  assert.deepEqual(effects, [{ type: 'fetch-body', key: '3:r1', requestId: 'r1' }]);
  const r = s.get('3:r1');
  assert.equal(r.app, '@acme/web'); assert.equal(r.pid, 42); assert.equal(r.status, 200);
  assert.equal(r.state, 'finished'); assert.equal(r.tsEnd, 1.65); assert.equal(r.wallStart, 1795097716628);
});

test('zerwane połączenie', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/x'), ctx);
  applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r1', timestamp: 2, errorText: 'ECONNREFUSED' }, ctx);
  assert.equal(s.get('3:r1').state, 'failed');
  assert.equal(s.get('3:r1').error, 'ECONNREFUSED');
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
  assert.equal(s.get('3:r1').wallStart, 5000);
  assert.deepEqual(applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'nope', timestamp: 1 }, ctx), []);
});

test('klucz rekordu per proces: te same requestId po restarcie nie nadpisują rekordów (wada 3)', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('node-network-event-1', 'http://svc/a'), ctx);
  applyNetworkEvent(s, { ...session, processId: 4 }, ...willBeSent('node-network-event-1', 'http://svc/a'), ctx);
  assert.equal(s.size, 2);
});

test('redakcja przy przyjęciu: nagłówki żądania i odpowiedzi, parametry URL (wada 6)', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, 'Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'http://svc/a?token=T0P&ms=1', headers: { authorization: 'Bearer SECRET' } }, timestamp: 1, wallTime: 1795097716628 }, ctx);
  applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'set-cookie': 'sid=SECRET2' } } }, ctx);
  const dump = JSON.stringify(s.values());
  for (const secret of ['SECRET', 'SECRET2', 'T0P']) assert.ok(!dump.includes(secret), secret);
  assert.match(s.get('3:r1').requestHeaders.authorization, /Bearer · 13 zn\./);
});

test('tryby treści i czas do pierwszego bajtu', () => {
  const run = bodies => {
    const s = createStore({ maxRequests: 10 });
    applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/a'), { ...ctx, bodies });
    applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', timestamp: 1.53, response: { status: 200 } }, ctx);
    return { effects: applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.6 }, { ...ctx, bodies }), r: s.get('3:r1') };
  };
  assert.equal(run('eager').effects.length, 1);
  assert.equal(run('lazy').effects.length, 0);
  assert.equal(run('lazy').r.body.state, 'none');
  assert.deepEqual(run('off').r.body, { state: 'skipped', reason: 'tryb treści: off' });
  assert.equal(run('eager').r.tsResponse, 1.53);
});

test('normalizacja wallTime: ms, sekundy, brak', () => {
  assert.equal(normalizeWallTime(1795097716628, 1), 1795097716628);
  assert.equal(normalizeWallTime(1795097716.628, 1), 1795097716628);
  assert.equal(normalizeWallTime(undefined, 42), 42);
});

test('origin: ramki bibliotek pomijane, dodatkowe ścieżki z ctx.libraryPaths', () => {
  const s = createStore({ maxRequests: 10 });
  const initiator = { stack: { callFrames: [
    { url: 'file:///repo/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js', functionName: 'fetch', lineNumber: 11460, columnNumber: 30 },
    { url: 'file:///repo/packages/http-client/index.js', functionName: 'apiFetch', lineNumber: 0, columnNumber: 0 },
    { url: 'file:///repo/app/page.js', functionName: 'Page', lineNumber: 4, columnNumber: 19 },
  ] } };
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/a', { initiator }), ctx);
  applyNetworkEvent(s, session, ...willBeSent('r2', 'http://svc/b', { initiator }), { ...ctx, libraryPaths: ['packages/http-client/'] });
  assert.deepEqual(s.get('3:r1').origin, ['apiFetch @ /repo/packages/http-client/index.js:1:1', 'Page @ /repo/app/page.js:5:20']);
  assert.deepEqual(s.get('3:r2').origin, ['Page @ /repo/app/page.js:5:20']);
});
