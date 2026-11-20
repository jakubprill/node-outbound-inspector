// Data dependencies between requests (issue #6) on synthetic records: evidence in the URL and a header,
// independent pairs, a missing body = unknown state, large and nested bodies, common values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencyGraph, responseValues, sentValues, isCandidate, LIMITS } from '../../src/analyze/dependencies.mjs';
import { criticalPathMs, describeChain, HINTS } from '../../src/analyze/waterfall.mjs';
import { analyzeApp, analyze } from '../../src/analyze/findings.mjs';

// times in seconds (as in the inspector)
let n = 0;
const json = o => { const data = typeof o === 'string' ? o : JSON.stringify(o); return { state: 'available', data, bytes: data.length }; };
const req = (tsStart, tsEnd, { url, method = 'GET', headers = {}, body = json({}), ...extra } = {}) => ({
  id: ++n, app: 'web', method, url: url ?? `http://svc/r${n}`, requestHeaders: headers, tsStart, tsEnd,
  wallStart: tsStart * 1000, status: 200, state: 'finished', origin: [], body, ...extra,
});
const ORDER = 'ord_550e8400-e29b-41d4-a716-446655440000';
const chainOf = rs => analyzeApp(rs, {}).bursts[0].sequential_chains[0];

test('dependency through the URL (example from the issue): POST /orders → GET /orders/status?orderId=…', () => {
  const a = req(0, 0.1, { method: 'POST', url: 'http://svc/orders', body: json({ orderId: ORDER, status: 'created' }) });
  const b = req(0.101, 0.2, { url: `http://svc/orders/status?orderId=${ORDER}` });
  const burst = analyzeApp([a, b], {}).bursts[0], ch = burst.sequential_chains[0];
  assert.equal(burst.verdict_code, 'sequential', 'the verdict describes the timeline — it does not change');
  assert.deepEqual(ch.dependencies, [{ from_step: 0, to_step: 1, from_id: a.id, to_id: b.id,
    evidence: { value: 'ord_550e8400-e29b-41…', from_path: '$.orderId', found_in: 'query:orderId' } }]);
  assert.equal(ch.potential_saving_ms, 0, 'formerly a false saving of 100 ms');
  assert.equal(ch.if_parallel_ms, ch.wall_ms);
  assert.equal(ch.hint, HINTS.dependent);
  assert.doesNotMatch(ch.hint, /cuts this part down to the time of the slowest/);
  assert.deepEqual(ch.dependency_check, { status: 'complete' });
  assert.equal(burst.potential_saving_ms_if_fully_parallel, 0);
  assert.deepEqual(burst.dependencies.map(d => [d.from_id, d.to_id]), [[a.id, b.id]]);
});

test('dependency through the path after percent-decoding and through a token part', () => {
  const a = req(0, 0.1, { body: json({ ref: 'ab~12345678' }) });
  const b = req(0.101, 0.2, { url: 'http://svc/items/ab%7E12345678/details' });
  assert.equal(chainOf([a, b]).dependencies[0].evidence.found_in, 'path');
  const c = req(1, 1.1, { body: json({ id: 98765432 }) });
  const d = req(1.101, 1.2, { url: 'http://svc/x?ref=ORD-98765432' });
  assert.equal(chainOf([c, d]).dependencies[0].evidence.from_path, '$.id', 'a number of ≥ 6 digits as part of the ORD-… token');
});

test('dependency through a header; technical and redacted headers give no match', () => {
  const a = req(0, 0.1, { body: json({ cart: { ref: 'CART-778899' }, access_token: 'eyJhbGciOi.abc123def456' }) });
  const b = req(0.101, 0.2, { headers: { 'x-cart-ref': 'CART-778899', authorization: '[redacted: Bearer · 30 chars · #a1b2c3]' } });
  assert.deepEqual(chainOf([a, b]).dependencies.map(d => d.evidence.found_in), ['header:x-cart-ref']);
  // a token from the response goes into Authorization — after redaction it cannot be detected (a limitation)
  const c = req(1, 1.1, { body: json({ access_token: 'eyJhbGciOi.abc123def456' }) });
  const d = req(1.101, 1.2, { headers: { authorization: '[redacted: Bearer · 30 chars · #a1b2c3]' } });
  const ch = chainOf([c, d]);
  assert.deepEqual(ch.dependencies, []);
  assert.deepEqual(ch.dependency_check, { status: 'complete' });
});

test('an independent pair: the result as before the change (wall − longest), the old hint', () => {
  const ch = chainOf([req(0, 0.15, { body: json({ items: [{ id: 'p-111111x' }] }) }), req(0.151, 0.3, { url: 'http://svc/offers?segment=gold' })]);
  assert.deepEqual(ch.dependencies, []);
  assert.equal(ch.potential_saving_ms, 150);
  assert.equal(ch.hint, HINTS.independent);
  assert.deepEqual(ch.dependency_check, { status: 'complete' });
});

test('a value known before A ended (A\'s URL, a forwarded header, the page URL) is not evidence', () => {
  const page = { id: 'p1', method: 'GET', url: '/checkout?cart=c-55667788' };
  const a = req(0, 0.1, { url: 'http://svc/user?id=u-12345678', headers: { 'x-request-id': 'req-abcdef123' }, page,
    body: json({ id: 'u-12345678', requestId: 'req-abcdef123', cart: 'c-55667788' }) });
  const b = req(0.101, 0.2, { url: 'http://svc/orders?userId=u-12345678&cart=c-55667788', headers: { 'x-request-id': 'req-abcdef123' }, page });
  assert.deepEqual(dependencyGraph([a, b]).edges, []);
});

test('a missing response body = unknown state, not "independent"; the saving as before', () => {
  const unavailable = { state: 'unavailable', bytes: 0, reason: 'the inspector returned no body' };
  const ch = chainOf([req(0, 0.1, { body: unavailable }), req(0.101, 0.2, { url: `http://svc/s?orderId=${ORDER}` })]);
  assert.deepEqual(ch.dependencies, []);
  assert.equal(ch.dependency_check.status, 'unavailable');
  assert.match(ch.dependency_check.reason, /the inspector returned no body/);
  assert.equal(ch.potential_saving_ms, 100);
  assert.equal(ch.hint, HINTS.independent, 'a conditional hint — "if they do not depend on each other"');
  // three steps: the first body unavailable, the second available → a partial check
  const partial = chainOf([req(1, 1.1, { body: { state: 'none' } }), req(1.101, 1.2), req(1.201, 1.3)]);
  assert.equal(partial.dependency_check.status, 'partial');
  assert.match(partial.dependency_check.reason, /was not fetched/);
  // a request that ended with a connection error has no response — nothing to check
  assert.equal(chainOf([req(2, 2.1, { state: 'failed', body: { state: 'none' } }), req(2.101, 2.2)]).dependency_check.status, 'complete');
  // B's request body (POST) is not in the model — no evidence means nothing
  const post = chainOf([req(3, 3.1, { body: json({ id: 'x-12345678' }) }), req(3.101, 3.2, { method: 'POST', url: 'http://svc/pay' })]);
  assert.equal(post.dependency_check.status, 'unavailable');
  assert.match(post.dependency_check.reason, /POST request body/);
});

test('nested JSON: evidence path, keys as values, large numbers without losing digits', () => {
  const a = req(0, 0.1, { body: json({ data: { items: [{ name: 'x' }, { sku: 'SKU-00042-B' }], byId: { 'k-99887766': {} } } }) });
  const b = req(0.101, 0.2, { url: 'http://svc/stock/SKU-00042-B?k=k-99887766' });
  assert.deepEqual(dependencyGraph([a, b]).edges.map(e => e.evidence.from_path), ['$.data.items[1].sku']);
  const { values } = responseValues(a);
  assert.equal(values.get('k-99887766'), '$.data.byId.k-99887766');
  const big = req(1, 1.1, { body: json('{"order":{"id":12345678901234567890}}') });
  const c = req(1.101, 1.2, { url: 'http://svc/orders/12345678901234567890' });
  assert.equal(dependencyGraph([big, c]).edges[0]?.evidence.from_path, '$.order.id');
  // a truncated body (invalid JSON) — searched as text, the check is incomplete
  const cut = req(2, 2.1, { body: { state: 'truncated', data: '{"items":[{"id":"ab-1234567"},{"id":"ab-76', bytes: 9999, reason: 'collector limit of 256 B' } });
  const d = req(2.101, 2.2, { url: 'http://svc/x/ab-1234567' });
  const g = dependencyGraph([cut, d]);
  assert.equal(g.edges[0].evidence.from_path, undefined, 'text — no JSON path');
  assert.equal(g.check([cut, d]).status, 'complete', 'a pair with evidence is resolved');
  assert.equal(dependencyGraph([cut, req(2.101, 2.2)]).check([cut]), null);
});

test('large bodies: search limit and candidate count, reasonable time', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: `item-${100000 + i}` }));
  const a = req(0, 0.1, { body: json({ first: 'id-00000001x', items }) });
  const t0 = performance.now();
  const p = responseValues(a);
  assert.equal(p.values.size, LIMITS.candidates);
  assert.equal(p.complete, false);
  const early = chainOf([a, req(0.101, 0.2, { url: 'http://svc/x?id=id-00000001x' })]);
  assert.equal(early.dependencies.length, 1, 'a value from the start of the body found despite the limit');
  const late = chainOf([a, req(0.101, 0.2, { url: 'http://svc/x?id=item-104999' })]);
  assert.deepEqual(late.dependencies, []);
  assert.equal(late.dependency_check.status, 'unavailable');
  assert.match(late.dependency_check.reason, /limit of 2000 values/);
  const html = { state: 'available', data: `<html>${'<p>text</p>'.repeat(2000)}<a href="/o/zz-12345678">x</a></html>`, bytes: 0 };
  assert.equal(chainOf([req(0.5, 0.6, { body: html }), req(0.601, 0.7, { url: 'http://svc/o/zz-12345678' })]).dependencies.length, 1,
    'a text body searched further than the limit of a single JSON string');
  const text = { state: 'available', data: 'x '.repeat(LIMITS.scanChars) + 'zz-12345678', bytes: 0 };
  const far = chainOf([req(1, 1.1, { body: text }), req(1.101, 1.2, { url: 'http://svc/zz-12345678' })]);
  assert.deepEqual(far.dependencies, []);
  assert.match(far.dependency_check.reason, /only the first/);
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
});

test('common and short values are not candidates', () => {
  for (const v of ['2026-11-19', '127.0.0.1', '100000', 'xxxxxxxxxxxx', 'processing', 'abc1234', '1.20.300', '12345'])
    assert.equal(isCandidate(v), false, v);
  for (const v of ['123456', 'ord-12345678', '550e8400-e29b-41d4-a716-446655440000', 'aBcDeFgHiJkLmNoPq'])
    assert.equal(isCandidate(v), true, v);
  const a = req(0, 0.1, { body: json({ date: '2026-11-19', ip: '127.0.0.1', limit: 100000, status: 'processing', pad: 'xxxxxxxxxxxx' }) });
  const b = req(0.101, 0.2, { url: 'http://127.0.0.1:4850/x?from=2026-11-19&limit=100000&status=processing&pad=xxxxxxxxxxxx' });
  assert.deepEqual(dependencyGraph([a, b]).edges, []);
  assert.ok(!sentValues(b, 'http://x').has('127.0.0.1'), 'B\'s host is not searched');
});

test('evidence under a secret-looking key does not show the value', () => {
  const a = req(0, 0.1, { body: json({ sessionRef: 'S3cr3t-ref-0987654321' }) });
  const b = req(0.101, 0.2, { url: 'http://svc/x?ref=S3cr3t-ref-0987654321' });
  assert.deepEqual(dependencyGraph([a, b]).edges[0].evidence, { value: '[redacted · 21 chars]', from_path: '$.sessionRef', found_in: 'query:ref' });
  // a value that is a key under a secret field: neither the value nor the rest of the path is shown
  const c = req(1, 1.1, { body: json({ tokens: { 'tk-12345678': { ok: true } } }) });
  const d = req(1.101, 1.2, { url: 'http://svc/x/tk-12345678' });
  assert.deepEqual(dependencyGraph([c, d]).edges[0].evidence, { value: '[redacted · 11 chars]', from_path: '$.tokens…', found_in: 'path' });
});

test('a partly dependent chain: saving only from independent steps, a hint without Promise.all for dependent ones', () => {
  const a = req(0, 0.1, { method: 'POST', body: json({ orderId: ORDER }) });
  const b = req(0.101, 0.2, { url: `http://svc/status?orderId=${ORDER}` });
  const c = req(0.201, 0.3, { headers: { 'x-order-id': ORDER } });
  const ch = chainOf([a, b, c]);
  assert.deepEqual(ch.dependencies.map(d => [d.from_step, d.to_step, d.evidence.found_in]), [[0, 1, 'query:orderId'], [0, 2, 'header:x-order-id']]);
  assert.equal(ch.if_parallel_ms, 200, 'A, then B and C in parallel');
  assert.equal(ch.potential_saving_ms, 100, 'dawniej 200');
  assert.match(ch.hint, /Steps steps\[1\], steps\[2\] wait/);
  // B depends on A, C independent: C can go together with A
  const x = req(1, 1.1, { body: json({ orderId: ORDER }) }), y = req(1.101, 1.2, { url: `http://svc/s/${ORDER}` }), z = req(1.201, 1.3);
  assert.equal(criticalPathMs([x, y, z], dependencyGraph([x, y, z]).edges), 200);
  assert.equal(describeChain([x, y, z], dependencyGraph([x, y, z])).potential_saving_ms, 100);
  assert.equal(describeChain([x, y, z]).potential_saving_ms, 200, 'without a graph: as before the change');
});

test('burst and page request level: a dependency outside the chain lowers potential_saving_ms_if_fully_parallel', () => {
  const page = { id: 'p9', method: 'GET', url: '/order' };
  // X and Y in parallel, Z starts 50 ms after X (outside the chain: gap > seq_gap_ms) and uses data from X
  const x = req(0, 0.1, { page, body: json({ orderId: ORDER }) }), y = req(0, 0.05, { page });
  const z = req(0.15, 0.25, { page, url: `http://svc/s?o=${ORDER}` });
  const p = analyze([x, y, z], { detail: 'full' }).web.by_page_request[0];
  assert.deepEqual(p.sequential_chains, []);
  assert.deepEqual(p.dependencies.map(d => [d.from_id, d.to_id]), [[x.id, z.id]]);
  assert.equal(p.potential_saving_ms_if_fully_parallel, 0, 'X → (50 ms of work) → Z is already the critical path; formerly 150');
  assert.equal(p.dependency_check.status, 'complete');
  // a purely parallel burst: no pairs to check — the field is omitted
  const par = analyzeApp([req(5, 5.1), req(5.01, 5.1)], {}).bursts[0];
  assert.equal(par.dependency_check, undefined);
  assert.equal(par.dependencies, undefined);
});
