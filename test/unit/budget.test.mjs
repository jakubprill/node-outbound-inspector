// Budżet odpowiedzi (ADR 0008, M6): każdy wynik narzędzia to poprawny JSON nie dłuższy niż limit,
// stronicowanie kursorem zwraca każdy rekord dokładnie raz, podsumowanie analizy jest krótkie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.mjs';
import { createTools } from '../../src/mcp/tools.mjs';
import { fitToBudget, shortUrl, size } from '../../src/mcp/budget.mjs';
import { createRedactor } from '../../src/redact.mjs';

/** Deterministyczny generator liczb (mulberry32), żeby porażka była powtarzalna. */
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Magazyn z `n` losowymi zapytaniami: kilka aplikacji, strony, błędy, długie URL-e i treści, zapytania w toku. */
function randomStore(n, seed) {
  const rnd = rng(seed), pick = a => a[Math.floor(rnd() * a.length)];
  const store = createStore({ maxRequests: 5000 });
  let t = 1, page = null;
  for (let i = 0; i < n; i++) {
    if (!page || rnd() < 0.3) page = rnd() < 0.15 ? null : { id: `p${i}`, method: 'GET', url: pick(['/seq', '/par', '/checkout?step=' + i, '/' + 'x'.repeat(Math.floor(rnd() * 300))]) };
    const start = t; t += rnd() * 0.05;
    const done = rnd() > 0.03, failed = done && rnd() < 0.05;
    const q = rnd() < 0.2 ? '?' + 'q=v&'.repeat(Math.floor(rnd() * 200)) : '';
    store.add({
      key: `k${i}`, app: pick(['@acme/web', '@acme/admin', 'svc']), port: 9231, pid: 1, processId: 1,
      method: pick(['GET', 'POST']), url: `http://127.0.0.1:4001/${pick(['user', 'orders', 'offers', 'payments'])}${q}`,
      wallStart: 1e12 + start * 1000, tsStart: start, ...(done ? { tsEnd: start + rnd() * 2, state: failed ? 'failed' : 'finished' } : {}),
      ...(done && !failed ? { status: pick([200, 200, 200, 404, 500]) } : {}), ...(failed ? { error: pick(['', 'ECONNREFUSED', 'x'.repeat(500)]) } : {}),
      requestHeaders: { accept: '*/*', 'x-long': 'h'.repeat(Math.floor(rnd() * 2000)) }, responseHeaders: {},
      origin: rnd() < 0.5 ? [`page @ /app/page.js:${i}:1`] : [],
      ...(page ? { page } : {}),
      body: rnd() < 0.5 ? { state: 'available', data: JSON.stringify({ items: Array.from({ length: Math.floor(rnd() * 50) }, (_, k) => ({ id: `ab-${k}`, name: 'n'.repeat(k) })) }) } : { state: 'none' },
    });
  }
  return store;
}

const toolsFor = (store, maxChars = 20000) => createTools({ store, now: () => 1e12 + 1e6, status: () => ({ apps: [] }), ensureBody: async r => r }, { maxChars });
const call = async (tools, name, args) => JSON.stringify(await tools[name].run(args));

test('fitToBudget: wynik w limicie, przycięcie jawne, najnowsze elementy zostają', () => {
  const v = { items: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(50) })), note: 'ok' };
  const out = fitToBudget(v, { limit: 3000, hint: 'narrow it' });
  assert.ok(size(out) <= 3000);
  assert.equal(out.truncated, true);
  assert.equal(out.truncation_hint, 'narrow it');
  assert.equal(out.items.at(-1).i, 499, 'najnowszy element zostaje');
  assert.equal(out.note, 'ok');
  assert.deepEqual(fitToBudget({ a: 1 }, { limit: 100, hint: 'h' }), { a: 1 }, 'mały wynik bez zmian');
  const text = fitToBudget({ body: 'b'.repeat(10000) }, { limit: 2000, hint: 'h' });
  assert.ok(size(text) <= 2000 && text.body.endsWith('…'));
});

test('shortUrl: długi query string skracany, krótki bez zmian', () => {
  assert.equal(shortUrl('http://s/a?x=1'), 'http://s/a?x=1');
  assert.equal(shortUrl('http://s/a?' + 'q=v&'.repeat(30)), 'http://s/a?…');
  assert.equal(shortUrl('http://s/' + 'p'.repeat(500)), 'http://s/' + 'p'.repeat(500), 'ścieżki nie skracamy');
});

test('własność: każdy wynik każdego narzędzia to poprawny JSON w limicie (losowe magazyny do 5000 zapytań)', async () => {
  for (const [n, seed] of [[0, 1], [1, 2], [37, 3], [600, 4], [5000, 5]]) {
    for (const limit of [20000, 6000]) {
      const store = randomStore(n, seed), tools = toolsFor(store, limit);
      const cases = [
        ['inspector_status', {}], ['list_server_requests', {}], ['list_server_requests', { limit: 1000 }],
        ['list_server_requests', { since_id: 0, limit: 1000 }], ['list_server_requests', { status: 'error' }],
        ['analyze_server_timeline', {}], ['analyze_server_timeline', { detail: 'full' }], ['analyze_server_timeline', { app: 'svc' }],
        ...(n ? [['get_server_request', { id: Math.ceil(n / 2), max_body_chars: 1e6 }]] : []),
      ];
      for (const [name, args] of cases) {
        const text = await call(tools, name, args);
        assert.ok(text.length <= limit, `${name} ${JSON.stringify(args)} n=${n} limit=${limit}: ${text.length}`);
        const parsed = JSON.parse(text);
        if (parsed.truncated) assert.ok(parsed.truncation_hint, 'przycięcie ze wskazówką');
      }
    }
  }
});

test('stronicowanie kursorem: każdy rekord dokładnie raz, także gdy budżet tnie strony', async () => {
  const store = randomStore(1200, 7);
  for (const [limit, maxChars] of [[50, 20000], [1000, 20000], [7, 6000]]) {
    const tools = toolsFor(store, maxChars), seen = [];
    let cursor = 0, calls = 0;
    for (;;) {
      const page = await tools.list_server_requests.run({ since_id: cursor, limit });
      seen.push(...page.requests.map(r => r.id));
      assert.ok(page.next_since_id >= cursor, 'kursor nie cofa się');
      cursor = page.next_since_id;
      if (!page.has_more) break;
      assert.ok(++calls < 2000, 'kursor się nie zapętla');
    }
    assert.deepEqual(seen, store.values().map(r => r.id).sort((a, b) => a - b), `limit=${limit}`);
  }
});

test('lista bez kursora: najnowsze, next_since_id do odpytywania o nowe, liczba pominiętych starszych', async () => {
  const store = randomStore(120, 8), tools = toolsFor(store);
  const page = await tools.list_server_requests.run({ limit: 10 });
  assert.deepEqual(page.requests.map(r => r.id), Array.from({ length: 10 }, (_, i) => 111 + i));
  assert.equal(page.next_since_id, 120);
  assert.equal(page.older_not_shown, 110);
  assert.equal(page.has_more, undefined);
  const empty = await tools.list_server_requests.run({ since_id: 120 });
  assert.deepEqual(empty, { requests: [], next_since_id: 120 });
});

test('filtry status i page_request_id', async () => {
  const store = createStore({ maxRequests: 10 });
  const r = (key, extra) => store.add({ key, app: 'web', port: 1, url: `http://s/${key}`, method: 'GET', wallStart: 1, tsStart: 1, origin: [], ...extra });
  r('ok', { status: 200, tsEnd: 2, state: 'finished', page: { id: 'p1', method: 'GET', url: '/a' } });
  r('nf', { status: 404, tsEnd: 2, state: 'finished', page: { id: 'p2', method: 'GET', url: '/b' } });
  r('se', { status: 503, tsEnd: 2, state: 'finished' });
  r('fail', { tsEnd: 2, state: 'failed', error: 'ECONNREFUSED' });
  r('pend', {});
  const keys = a => store.select(a).map(x => x.key);
  assert.deepEqual(keys({ status: '404' }), ['nf']);
  assert.deepEqual(keys({ status: 503 }), ['se'], 'liczba też działa');
  assert.deepEqual(keys({ status: '5xx' }), ['se']);
  assert.deepEqual(keys({ status: 'error' }), ['nf', 'se', 'fail']);
  assert.deepEqual(keys({ status: 'failed' }), ['fail']);
  assert.deepEqual(keys({ status: 'pending' }), ['pend']);
  assert.deepEqual(keys({ page_request_id: 'p2' }), ['nf']);
  assert.throws(() => keys({ status: 'weird' }), /Unknown status filter/);
});

test('podsumowanie analizy: 132 zapytania (44 strony × 3) mieszczą się w 6000 znaków', async () => {
  const store = createStore({ maxRequests: 5000 });
  let t = 1;
  for (let p = 0; p < 44; p++) {
    const page = { id: `1093-${p}`, method: 'GET', url: '/par' };
    for (const svc of ['user', 'orders', 'offers']) store.add({ key: `${p}${svc}`, app: '@acme/admin', port: 9241, method: 'GET', url: `http://127.0.0.1:4001/${svc}?ms=150`,
      wallStart: 1e12 + t * 1000, tsStart: t, tsEnd: t + 0.15, state: 'finished', status: 200, origin: ['get @ /app/par/page.js:5:18'], page, body: { state: 'none' } });
    t += 0.5;
  }
  const tools = toolsFor(store);
  const summary = await call(tools, 'analyze_server_timeline', {});
  assert.ok(summary.length <= 6000, `${summary.length} znaków`);
  const s = JSON.parse(summary)['@acme/admin'];
  assert.equal(s.by_page_request.length, 20);
  assert.equal(s.page_requests_total, 44);
  assert.equal(s.by_page_request.at(-1).page_request_id, '1093-43', 'najnowsze żądania stron');
  assert.ok(s.by_page_request.every(p => !p.timeline), 'bez osi czasu');
  const one = JSON.parse(await call(tools, 'analyze_server_timeline', { page_request_id: '1093-7' }))['@acme/admin'];
  assert.equal(one.by_page_request.length, 1);
  assert.equal(one.by_page_request[0].timeline.length, 3, 'jedno żądanie strony: pełna oś czasu');
});

test('ustalenia: duplikaty w obrębie strony i wolne zapytania', async () => {
  const store = createStore({ maxRequests: 100 });
  const page = { id: 'p1', method: 'GET', url: '/cart' };
  const add = (key, url, ms, extra = {}) => store.add({ key, app: 'web', port: 1, method: 'GET', url, wallStart: 1, tsStart: 1, tsEnd: 1 + ms / 1000, state: 'finished', status: 200, origin: [], page, ...extra });
  add('a', 'http://s/user', 50); add('b', 'http://s/user', 60); add('c', 'http://s/cart', 1500);
  add('d', 'http://s/user', 40, { page: { id: 'p2', method: 'GET', url: '/other' } });
  const { findings } = JSON.parse(await call(toolsFor(store), 'analyze_server_timeline', {})).web;
  assert.deepEqual(findings.duplicates, [{ page: 'GET /cart', page_request_id: 'p1', request: 'GET http://s/user', count: 2, ids: [1, 2] }]);
  assert.deepEqual(findings.slow.map(r => r.id), [3]);
  assert.equal(findings.slow_threshold_ms, 1000);
});

test('get_server_request: treść stronicowana przez body_offset', async () => {
  const store = createStore({ maxRequests: 10 });
  const data = 'abcdefghij'.repeat(100);
  store.add({ key: 'k', app: 'web', port: 1, method: 'GET', url: 'http://s/big', wallStart: 1, tsStart: 1, tsEnd: 2, state: 'finished', status: 200, origin: [], body: { state: 'available', data, bytes: 1000 } });
  const tools = toolsFor(store);
  const first = await tools.get_server_request.run({ id: 1, max_body_chars: 400 });
  assert.equal(first.body, data.slice(0, 400));
  assert.equal(first.body_next_offset, 400);
  assert.equal(first.body_offset, undefined);
  let all = first.body, next = first.body_next_offset;
  while (next != null) { const p = await tools.get_server_request.run({ id: 1, max_body_chars: 400, body_offset: next }); all += p.body; next = p.body_next_offset; }
  assert.equal(all, data);
});

test('redakcja treści JSON: pola sekretów zastąpione, reszta bez zmian, także w treści przyciętej', () => {
  const r = createRedactor();
  const { text, count } = r.jsonBody('{"access_token": "eyJhbGciOi.x.y", "expires_in": 3600, "author": "Jan", "client_secret":"s\\"q", "nested": {"api_key": 12345}, "id_token":"cut');
  assert.equal(count, 4, 'także niezamknięta wartość na końcu przyciętej treści');
  assert.match(text, /"id_token":"\[redacted: cut value · 3\+ chars\]"$/);
  assert.match(text, /"access_token": "\[redacted: 14 chars · #[0-9a-f]{6}\]"/);
  assert.match(text, /"client_secret":"\[redacted: 3 chars · #[0-9a-f]{6}\]"/);
  assert.match(text, /"api_key": "\[redacted: 5 chars · #[0-9a-f]{6}\]"/);
  assert.match(text, /"expires_in": 3600, "author": "Jan"/, 'pola niebędące sekretami bez zmian');
  assert.ok(!text.includes('eyJhbGciOi') && !text.includes('12345'));
  assert.deepEqual(createRedactor({ enabled: false }).jsonBody('{"token":"x"}'), { text: '{"token":"x"}', count: 0 });
});

test('get_server_request: przy dużych nagłówkach treść skrócona do budżetu, body_next_offset nadal prawdziwy', async () => {
  const store = createStore({ maxRequests: 10 });
  const data = 'z'.repeat(30000);
  store.add({ key: 'k', app: 'web', port: 1, method: 'GET', url: 'http://s/big', wallStart: 1, tsStart: 1, tsEnd: 2, state: 'finished', status: 200, origin: [],
    requestHeaders: { 'x-big': 'h'.repeat(8000) }, body: { state: 'available', data, bytes: 30000 } });
  const tools = toolsFor(store, 12000);
  const d = await tools.get_server_request.run({ id: 1, max_body_chars: 1e6 });
  assert.ok(size(d) <= 12000, String(size(d)));
  assert.equal(d.truncated, undefined, 'bez przycięcia za plecami');
  assert.equal(d.body_next_offset, d.body.length);
});
