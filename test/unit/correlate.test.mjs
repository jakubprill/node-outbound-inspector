import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPageEntries } from '../../src/correlate.mjs';

const page = id => ({ id, method: 'GET', url: `/${id}` });
const req = (url, wallStart, method = 'GET') => ({ url, method, wallStart });

test('dopasowuje po metodzie, URL i najbliższym czasie', () => {
  const a = req('http://svc/user', 1000), b = req('http://svc/user', 1100);
  applyPageEntries([a, b], [{ url: 'http://svc/user', method: 'GET', page: page('p1'), t: 1090 }], [], 2000);
  assert.equal(b.page.id, 'p1');
  assert.equal(a.page, undefined);
});

test('normalizuje domyślne porty i dopasowuje po ścieżce', () => {
  const a = req('https://svc/x', 1000), b = req('http://svc:8080/y?q=1', 1000);
  applyPageEntries([a, b], [
    { url: 'https://svc:443/x', method: 'GET', page: page('p1'), t: 1000 },
    { url: 'http://other/y?q=1', method: 'GET', page: page('p2'), t: 1000 },
  ], [], 1000);
  assert.equal(a.page.id, 'p1');
  assert.equal(b.page.id, 'p2');
});

test('poza oknem 3 s albo inna metoda → oczekujące', () => {
  const a = req('http://svc/z', 1000);
  const pending = [];
  applyPageEntries([a], [{ url: 'http://svc/z', method: 'GET', page: page('p1'), t: 5000 }, { url: 'http://svc/z', method: 'POST', page: page('p2'), t: 1000 }], pending, 5000);
  assert.equal(a.page, undefined);
  assert.equal(pending.length, 2);
});

test('ponowna próba oczekujących przy pustej porcji; wygasanie po 10 s', () => {
  const pending = [{ url: 'http://svc/late', method: 'GET', page: page('p1'), t: 1000 }, { url: 'http://svc/old', method: 'GET', page: page('p2'), t: 0 }];
  const a = req('http://svc/late', 1200);
  applyPageEntries([a], [], pending, 10500);
  assert.equal(a.page.id, 'p1');
  assert.deepEqual(pending, [], 'dopasowany usunięty, przeterminowany porzucony');
});
