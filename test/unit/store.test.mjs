import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.mjs';

const rec = (key, extra = {}) => ({ key, app: 'web', port: 9231, url: `http://s/${key}`, wallStart: 1000, tsStart: 1, origin: [], ...extra });

test('assigns increasing ids and removes the oldest when over the limit', () => {
  const s = createStore({ maxRequests: 2 });
  s.add(rec('a')); s.add(rec('b')); s.add(rec('c'));
  assert.equal(s.size, 2);
  assert.equal(s.get('a'), undefined);
  assert.equal(s.byId(3).key, 'c');
  assert.equal(s.lastId, 3);
});

test('select: filters and sorting by time', () => {
  const s = createStore({ maxRequests: 10 });
  s.add(rec('late', { wallStart: 3000, url: 'http://s/orders' }));
  s.add(rec('early', { wallStart: 1000, app: 'admin', port: 9241, page: { method: 'GET', url: '/checkout' } }));
  s.add(rec('mid', { wallStart: 2000, url: 'http://s/user' }));
  assert.deepEqual(s.select().map(r => r.key), ['early', 'mid', 'late']);
  assert.deepEqual(s.select({ app: 'admin' }).map(r => r.key), ['early']);
  assert.deepEqual(s.select({ app: '9241' }).map(r => r.key), ['early'], 'app can be a port');
  assert.deepEqual(s.select({ url_contains: '/user' }).map(r => r.key), ['mid']);
  assert.deepEqual(s.select({ page_contains: '/checkout' }).map(r => r.key), ['early']);
  assert.deepEqual(s.select({ since_id: 2 }).map(r => r.key), ['mid']);
  assert.deepEqual(s.select({ last_ms: 1500 }, 3500).map(r => r.key), ['mid', 'late']);
});

test('clear: everything or one app', () => {
  const s = createStore({ maxRequests: 10 });
  s.add(rec('a')); s.add(rec('b', { app: 'admin', port: 9241 }));
  assert.equal(s.clear({ app: 'admin' }), 1);
  assert.deepEqual(s.appsSeen(), ['web']);
  assert.equal(s.clear(), 1);
  assert.equal(s.size, 0);
  assert.equal(s.lastId, 2, 'the id counter is not reset');
});
