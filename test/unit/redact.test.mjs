import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../../src/redact.mjs';

const key = Buffer.alloc(32, 7);

test('nagłówki: lista i wzorzec nazw; schemat, długość, skrót', () => {
  const r = createRedactor({ key });
  const out = r.headers({ Authorization: 'Bearer SECRET', cookie: 'a=b', 'Set-Cookie': 'sid=1', 'x-api-key': 'k', 'X-Session-Id': 's', 'x-auth-token': 't', 'content-type': 'application/json', 'keep-alive': 'timeout=5', 'x-request-id': 'req-1' });
  assert.match(out.Authorization, /^\[zredagowano: Bearer · 13 zn\. · #[0-9a-f]{6}\]$/);
  for (const h of ['cookie', 'Set-Cookie', 'x-api-key', 'X-Session-Id', 'x-auth-token']) assert.match(out[h], /^\[zredagowano: /, h);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['keep-alive'], 'timeout=5');
  assert.equal(out['x-request-id'], 'req-1');
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('ten sam sekret → ten sam skrót; inny klucz kolektora → inny skrót', () => {
  const a = createRedactor({ key }), b = createRedactor({ key: Buffer.alloc(32, 8) });
  assert.equal(a.describe('Bearer X'), a.describe('Bearer X'));
  assert.notEqual(a.describe('Bearer X'), a.describe('Bearer Y'));
  assert.notEqual(a.describe('Bearer X'), b.describe('Bearer X'));
});

test('dodatkowe nagłówki firmowe', () => {
  const r = createRedactor({ key, extraHeaders: ['X-Acme-Internal'] });
  assert.match(r.headers({ 'x-acme-internal': 'v' })['x-acme-internal'], /zredagowano/);
});

test('parametry URL', () => {
  const r = createRedactor({ key });
  const u = r.url('http://svc/a?token=abc&ms=150&api_key=k&sig=x');
  assert.ok(!u.includes('abc') && !u.includes('api_key=k'));
  assert.match(u, /ms=150/);
  assert.equal(r.url('http://svc/a?ms=150&status=500'), 'http://svc/a?ms=150&status=500', 'bez zmian, gdy nic do redakcji');
  assert.equal(r.url('nie-url?token=1'), 'nie-url?token=1');
});

test('wyłączona redakcja', () => {
  const r = createRedactor({ enabled: false, key });
  assert.deepEqual(r.headers({ authorization: 'Bearer S' }), { authorization: 'Bearer S' });
  assert.equal(r.url('http://s/?token=1'), 'http://s/?token=1');
});
