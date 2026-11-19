import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row, details, NO_ORIGIN } from '../../src/mcp/render.mjs';

const r = { id: 7, app: 'web', page: { method: 'GET', url: '/seq' }, method: 'GET', url: 'http://svc/a', status: 200, tsStart: 1, tsEnd: 1.15, origin: [], port: 9231, pid: 1, wallStart: 0, body: 'abcdef' };

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
});
