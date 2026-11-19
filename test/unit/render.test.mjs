import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row, details, errorKind, NO_ORIGIN, FAILED_NO_TEXT, EMPTY_ERROR_HINT } from '../../src/mcp/render.mjs';

const r = { id: 7, app: 'web', page: { method: 'GET', url: '/seq' }, method: 'GET', url: 'http://svc/a', status: 200, tsStart: 1, tsResponse: 1.04, tsEnd: 1.15, origin: [], port: 9231, pid: 1, wallStart: 0, body: { state: 'available', data: 'abcdef', bytes: 6 } };

test('row: czas, strona, brak ramki', () => {
  assert.deepEqual(row(r, 0.9), { id: 7, app: 'web', page: 'GET /seq', method: 'GET', url: 'http://svc/a', status: 200, start_ms: 100, duration_ms: 150, origin: NO_ORIGIN });
});

test('row: w toku i zerwane', () => {
  assert.equal(row({ ...r, status: undefined, tsEnd: undefined }).status, 'pending');
  assert.equal(row({ ...r, status: undefined, tsEnd: undefined }).duration_ms, null);
  assert.equal(row({ ...r, state: 'failed', error: 'ECONNRESET' }).status, 'FAILED: ECONNRESET');
  assert.equal(row({ ...r, page: undefined }).page, null);
});

test('details: przycięcie treści', () => {
  const d = details(r, 3);
  assert.equal(d.body, 'abc');
  assert.equal(d.body_truncated, true);
  assert.equal(d.wallStart, '1970-01-01T00:00:00.000Z');
  assert.equal(d.body_state, 'available');
  assert.equal(d.ttfb_ms, 40);
});

test('details: treść niedostępna → body null i powód', () => {
  const d = details({ ...r, body: { state: 'unavailable', bytes: 0, reason: 'Node 22 …' } }, 100);
  assert.equal(d.body, null);
  assert.equal(d.body_state, 'unavailable');
  assert.equal(d.body_reason, 'Node 22 …');
});

test('row: pusty errorText → czytelny status zamiast "FAILED: " (issue #3)', () => {
  for (const error of ['', '  ', undefined]) assert.equal(row({ ...r, state: 'failed', error }).status, FAILED_NO_TEXT);
  assert.equal(FAILED_NO_TEXT, 'FAILED (brak opisu błędu od inspektora)');
});

test('details: rodzaj błędu tylko dla nieudanych, wyjaśnienie tylko dla pustego opisu (issue #3)', () => {
  const empty = details({ ...r, state: 'failed', error: '' }, 10);
  assert.equal(empty.error_kind, 'unknown');
  assert.equal(empty.error_hint, EMPTY_ERROR_HINT);
  const refused = details({ ...r, state: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:4318' }, 10);
  assert.equal(refused.error_kind, 'connection_refused');
  assert.equal('error_hint' in refused, false);
  const ok = details(r, 10);
  assert.equal('error_kind' in ok, false, 'pola addytywne nie pojawiają się w udanych zapytaniach (golden bez zmian)');
});

test('errorKind: teksty z Network.loadingFailed zmierzone na Node 22 (fetch i node:http)', () => {
  const cases = {
    'connect ECONNREFUSED 127.0.0.1:4318': 'connection_refused',
    'The operation was aborted due to timeout': 'timeout',   // fetch + AbortSignal.timeout
    'timeout': 'timeout',                                   // node:http, req.destroy(new Error('timeout'))
    'This operation was aborted': 'aborted',                // fetch + AbortController
    'read ECONNRESET': 'connection_reset',
    'socket hang up': 'connection_reset',                   // node:http, req.destroy() przed odpowiedzią
    'other side closed': 'connection_reset',                // fetch, zerwana treść odpowiedzi
    'getaddrinfo EAI_AGAIN no-such-host.invalid': 'dns',
    'getaddrinfo ENOTFOUND svc.internal': 'dns',
    'self-signed certificate': 'tls',
    'coś zupełnie innego': 'other',
    '': 'unknown',
  };
  for (const [text, kind] of Object.entries(cases)) assert.equal(errorKind(text), kind, text);
  assert.equal(errorKind(undefined), 'unknown');
});
