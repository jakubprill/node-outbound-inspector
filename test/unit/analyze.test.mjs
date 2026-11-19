import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { duration, bursts, maxConcurrency } from '../../src/analyze/timeline.mjs';
import { chains } from '../../src/analyze/waterfall.mjs';
import { analyzeApp, analyze } from '../../src/analyze/findings.mjs';
import { readRecording, replay } from '../helpers/replay.mjs';

// czasy w sekundach (jak w inspektorze)
let n = 0;
const r = (tsStart, tsEnd, extra = {}) => ({ id: ++n, app: 'web', method: 'GET', url: `http://svc/${n}`, tsStart, tsEnd, wallStart: tsStart * 1000, status: 200, origin: [], ...extra });

test('timeline: czas trwania, serie, współbieżność', () => {
  assert.equal(duration(r(1, 1.15)), 150);
  assert.equal(duration(r(1, undefined)), null);
  const reqs = [r(0, 0.1), r(0.05, 0.2), r(1, 1.1)];
  assert.deepEqual(bursts(reqs, { idleGapMs: 250 }).map(b => b.length), [2, 1]);
  assert.equal(maxConcurrency(reqs.slice(0, 2)), 2);
  assert.equal(maxConcurrency([r(0, 0.1), r(0.1, 0.2)]), 1, 'koniec i początek w tej samej chwili nie nachodzą na siebie');
});

test('waterfall: łańcuch sekwencyjny tylko bez nakładających się zapytań', () => {
  assert.equal(chains([r(0, 0.15), r(0.152, 0.3), r(0.305, 0.45)], { seqGapMs: 15 })[0].length, 3);
  assert.equal(chains([r(0, 0.15), r(0.2, 0.3)], { seqGapMs: 15 }).length, 0, 'przerwa 50 ms > 15 ms');
  assert.equal(chains([r(0, 0.15), r(0.1, 0.2), r(0.152, 0.3)], { seqGapMs: 15 }).length, 0, 'inne zapytanie trwa w międzyczasie');
});

test('analyzeApp: werdykty', () => {
  const v = rs => analyzeApp(rs, {}).bursts[0].verdict;
  assert.match(v([r(0, 0.15), r(0.151, 0.3)]), /SEKWENCYJNIE/);
  assert.match(v([r(0, 0.15), r(0.001, 0.15)]), /RÓWNOLEGLE/);
  assert.match(v([r(0, 0.15), r(0.001, 0.15), r(0.151, 0.3)]), /MIESZANE/);
  assert.equal(v([r(0, 0.1)]), 'pojedyncze zapytanie');
  const seq = analyzeApp([r(0, 0.15), r(0.151, 0.3), r(0.301, 0.45)], {}).bursts[0];
  assert.equal(seq.sequential_chains[0].potential_saving_ms, 300);
  assert.equal(seq.potential_saving_ms_if_fully_parallel, 300);
});

test('analyze: błędy, strony, zapytania bez strony, pusty wynik', () => {
  const p = { id: 'p1', method: 'GET', url: '/seq' };
  const res = analyze([r(0, 0.1, { page: p }), r(0.1, 0.2, { page: p, status: 500 }), r(5, 5.1), r(6, 6.1, { state: 'failed', status: undefined, error: 'x' })], {});
  assert.equal(res.web.total_requests, 4);
  assert.equal(res.web.errors.length, 2);
  assert.equal(res.web.by_page_request[0].page, 'GET /seq');
  assert.equal(res.web.unattributed.length, 2);
  assert.deepEqual(analyze([], {}, ['web']), { summary: 'Brak zapytań w wybranym zakresie.', apps_with_traffic: ['web'] });
});

test('nagranie (Node 22): odtworzenie daje te same werdykty co scenariusz e2e', () => {
  const rec = readRecording(fileURLToPath(new URL('../fixtures/recordings/two-apps-node22.ndjson', import.meta.url)));
  const { store } = replay(rec);
  assert.equal(store.size, 11);
  assert.ok(store.values().every(x => x.page), 'każde zapytanie przypisane do strony');
  const res = analyze(store.select(), {});
  const page = (app, p) => res[app].by_page_request.find(x => x.page === p);
  assert.match(page('@acme/web', 'GET /seq').verdict, /SEKWENCYJNIE/);
  assert.match(page('@acme/admin', 'GET /par').verdict, /RÓWNOLEGLE/);
  assert.match(page('@acme/admin', 'GET /seq').verdict, /SEKWENCYJNIE/);
  assert.equal(page('@acme/admin', 'GET /http').requests, 1);
  assert.deepEqual(res['@acme/web'].errors.map(e => e.status), [500]);
});
