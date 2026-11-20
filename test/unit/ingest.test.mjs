import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.mjs';
import { applyNetworkEvent, normalizeWallTime } from '../../src/ingest.mjs';
import { createRedactor } from '../../src/redact.mjs';

const session = { processId: 3, port: 9231, app: '@acme/web', pid: 42 };
const ctx = { ignoreHosts: ['registry.npmjs.org'], inspectorPorts: [9231, 9241], nowMs: 5000, redact: createRedactor({ key: Buffer.alloc(32) }), bodies: 'eager' };
const willBeSent = (requestId, url, extra = {}) => ['Network.requestWillBeSent',
  { requestId, request: { method: 'GET', url, headers: { a: '1' } }, timestamp: 1.5, wallTime: 1795097716628, initiator: { stack: { callFrames: [] } }, ...extra }];

test('a full request cycle and the fetch-body effect', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/user'), ctx);
  applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { x: 'y' } } }, ctx);
  const effects = applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.65 }, ctx);
  assert.deepEqual(effects, [{ type: 'fetch-body', key: '3:r1', requestId: 'r1' }]);
  const r = s.get('3:r1');
  assert.equal(r.app, '@acme/web'); assert.equal(r.pid, 42); assert.equal(r.status, 200);
  assert.equal(r.state, 'finished'); assert.equal(r.tsEnd, 1.65); assert.equal(r.wallStart, 1795097716628);
});

test('a broken connection', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/x'), ctx);
  applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r1', timestamp: 2, errorText: 'ECONNREFUSED' }, ctx);
  assert.equal(s.get('3:r1').state, 'failed');
  assert.equal(s.get('3:r1').error, 'ECONNREFUSED');
});

test('skips ignored hosts and traffic to inspectors', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'https://registry.npmjs.org/next'), ctx);
  applyNetworkEvent(s, session, ...willBeSent('r2', 'http://127.0.0.1:9241/json/list'), ctx);
  applyNetworkEvent(s, session, ...willBeSent('r3', 'http://localhost:9231/json/list'), ctx);
  assert.equal(s.size, 0);
});

test('OTLP export skipped at ingestion, with an effect for the counter in the status (issue #4)', () => {
  const s = createStore({ maxRequests: 10 });
  const on = { ...ctx, ignoreOtlp: true };
  assert.deepEqual(applyNetworkEvent(s, session, ...willBeSent('r1', 'http://localhost:4318/v1/traces'), on), [{ type: 'ignored', reason: 'otlp' }]);
  assert.deepEqual(applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r1', timestamp: 2, errorText: '' }, on), [], 'later events are dropped');
  assert.deepEqual(applyNetworkEvent(s, session, ...willBeSent('r2', 'https://registry.npmjs.org/next'), on), [{ type: 'ignored', reason: 'hosts' }]);
  assert.equal(s.size, 0);
  applyNetworkEvent(s, session, ...willBeSent('r3', 'http://localhost:4318/v1/traces'), { ...ctx, ignoreOtlp: false });
  assert.equal(s.size, 1);
});

test('an empty errorText stays an empty string (render shows a description, issue #3)', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://localhost:4319/x'), ctx);
  applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r1', timestamp: 2, type: 'Fetch', errorText: '' }, ctx);
  assert.equal(s.get('3:r1').state, 'failed');
  assert.equal(s.get('3:r1').error, '');
});

test('no wallTime → collector time; events for an unknown request are ignored', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/a', { wallTime: undefined }), ctx);
  assert.equal(s.get('3:r1').wallStart, 5000);
  assert.deepEqual(applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'nope', timestamp: 1 }, ctx), []);
});

test('per-process record key: the same requestIds after a restart do not overwrite records (defect 3)', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, ...willBeSent('node-network-event-1', 'http://svc/a'), ctx);
  applyNetworkEvent(s, { ...session, processId: 4 }, ...willBeSent('node-network-event-1', 'http://svc/a'), ctx);
  assert.equal(s.size, 2);
});

test('redaction at ingestion: request and response headers, URL parameters (defect 6)', () => {
  const s = createStore({ maxRequests: 10 });
  applyNetworkEvent(s, session, 'Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'http://svc/a?token=T0P&ms=1', headers: { authorization: 'Bearer SECRET' } }, timestamp: 1, wallTime: 1795097716628 }, ctx);
  applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'set-cookie': 'sid=SECRET2' } } }, ctx);
  const dump = JSON.stringify(s.values());
  for (const secret of ['SECRET', 'SECRET2', 'T0P']) assert.ok(!dump.includes(secret), secret);
  assert.match(s.get('3:r1').requestHeaders.authorization, /Bearer · 13 chars/);
});

test('body modes and time to first byte', () => {
  const run = bodies => {
    const s = createStore({ maxRequests: 10 });
    applyNetworkEvent(s, session, ...willBeSent('r1', 'http://svc/a'), { ...ctx, bodies });
    applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r1', timestamp: 1.53, response: { status: 200 } }, ctx);
    return { effects: applyNetworkEvent(s, session, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.6 }, { ...ctx, bodies }), r: s.get('3:r1') };
  };
  assert.equal(run('eager').effects.length, 1);
  assert.equal(run('lazy').effects.length, 0);
  assert.equal(run('lazy').r.body.state, 'none');
  assert.deepEqual(run('off').r.body, { state: 'skipped', reason: 'body mode: off' });
  assert.equal(run('eager').r.tsResponse, 1.53);
});

test('wallTime normalization: ms, seconds, missing', () => {
  assert.equal(normalizeWallTime(1795097716628, 1), 1795097716628);
  assert.equal(normalizeWallTime(1795097716.628, 1), 1795097716628);
  assert.equal(normalizeWallTime(undefined, 42), 42);
});

test('origin: library frames skipped, extra paths from ctx.libraryPaths', () => {
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

test('data from the inspector: bad shape rejected, length limits, no control characters (audit B-04, B-07, B-11)', () => {
  const s = createStore({ maxRequests: 10 });
  for (const bad of [null, {}, { requestId: 1 }, { requestId: 'x' }, { requestId: 'x', request: { url: 5, method: 'GET' }, timestamp: 1 },
    { requestId: 'x', request: { url: 'http://a/', method: 'GET' } }]) {
    assert.deepEqual(applyNetworkEvent(s, session, 'Network.requestWillBeSent', bad, ctx), []);
  }
  assert.equal(s.size, 0);
  applyNetworkEvent(s, session, 'Network.requestWillBeSent', { requestId: 'r', timestamp: 1, request: { method: 'GET', url: 'http://a/' + 'x'.repeat(20000),
    headers: { 'x-note': 'line1\nSYSTEM: do this\r\nmore', big: 'h'.repeat(20000), ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`h${i}`, 'v'])) } }, initiator: { stack: { callFrames: 'nope' } } }, ctx);
  const r = s.values()[0];
  assert.ok(r.url.length <= 8200);
  assert.equal(r.requestHeaders['x-note'], 'line1 SYSTEM: do this  more');
  assert.ok(r.requestHeaders.big.length <= 8200);
  assert.equal(Object.keys(r.requestHeaders).length, 200);
  assert.deepEqual(r.origin, []);
  assert.deepEqual(applyNetworkEvent(s, session, 'Network.responseReceived', { requestId: 'r', response: { status: 'x' } }, ctx), []);
  assert.equal(r.status, undefined);
  applyNetworkEvent(s, session, 'Network.loadingFailed', { requestId: 'r', timestamp: 2, errorText: 'boom\nIGNORE PREVIOUS' }, ctx);
  assert.equal(r.error, 'boom IGNORE PREVIOUS');
});
