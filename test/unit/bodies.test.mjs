import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { classifyBody, enforceBodyBudget, parseCodings } from '../../src/bodies.mjs';

const json = { type: 'Fetch', mimeType: 'application/json', responseHeaders: { 'content-type': 'application/json', 'content-length': '19' } };
const opts = (o = {}) => ({ maxStoredBytes: 1000, missingState: 'unavailable', ...o });

test('pełna treść', () => {
  assert.deepEqual(classifyBody({ body: '{"service":"/user"}', base64Encoded: false }, json, opts()), { state: 'available', data: '{"service":"/user"}', bytes: 19 });
});

test('pusta treść to pusta odpowiedź (Node ≥ 24 zwraca treść fetch)', () => {
  assert.deepEqual(classifyBody({ body: '', base64Encoded: false }, json, opts()), { state: 'truncated', data: '', bytes: 0, reason: 'bufor inspektora obciął treść (0 z 19 B)' });
  assert.equal(classifyBody({ body: '', base64Encoded: false }, { ...json, responseHeaders: { 'content-length': '0' } }, opts()).state, 'available');
});

test('brak treści w inspektorze: evicted (lazy) albo unavailable', () => {
  assert.equal(classifyBody(null, json, opts({ missingState: 'evicted' })).state, 'evicted');
  assert.equal(classifyBody(null, json, opts()).state, 'unavailable');
});

test('treść binarna nie jest dekodowana', () => {
  const b = classifyBody({ body: Buffer.from([0, 1, 2, 255]).toString('base64'), base64Encoded: true }, { responseHeaders: { 'content-type': 'image/png' } }, opts());
  assert.deepEqual(b, { state: 'skipped', bytes: 4, reason: 'treść binarna (image/png)' });
  assert.equal(classifyBody({ body: Buffer.from('{"a":1}').toString('base64'), base64Encoded: true }, json, opts()).data, '{"a":1}', 'tekst w base64 jest dekodowany');
});

test('obcięcie: limit kolektora i bufor inspektora', () => {
  const big = classifyBody({ body: 'x'.repeat(1500), base64Encoded: false }, { responseHeaders: {} }, opts());
  assert.equal(big.state, 'truncated'); assert.equal(big.data.length, 1000); assert.equal(big.bytes, 1500);
  const cut = classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '100' } }, opts());
  assert.equal(cut.state, 'truncated'); assert.match(cut.reason, /10 z 100/);
  assert.equal(classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '5', 'content-encoding': 'gzip' } }, opts()).state, 'available');
});

test('budżet treści: najpierw najstarsze bez błędu', () => {
  const rec = (status, n) => ({ status, body: { state: 'available', data: 'x'.repeat(n), bytes: n } });
  const rs = [rec(500, 40), rec(200, 40), rec(200, 40)];
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 1);
  assert.deepEqual(rs.map(r => r.body.state), ['available', 'evicted', 'available']);
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 0);
});

// Treść skompresowana (issue #1): node:http oddaje w inspektorze surowe bajty z łącza w base64.
const JSON_TEXT = JSON.stringify({ service: '/small', items: Array.from({ length: 50 }, (_, i) => `pozycja ${i}`) });
const packed = (coding, buf, extra = {}) => [
  { body: buf.toString('base64'), base64Encoded: true },
  { type: 'Other', responseHeaders: { 'content-type': 'application/json', 'content-encoding': coding, 'content-length': String(buf.length), ...extra } },
];

test('dekompresja: gzip, br, deflate (zlib i surowy), zstd', () => {
  const src = Buffer.from(JSON_TEXT);
  const cases = { gzip: zlib.gzipSync(src), br: zlib.brotliCompressSync(src), deflate: zlib.deflateSync(src), 'x-gzip': zlib.gzipSync(src) };
  if (zlib.zstdCompressSync) cases.zstd = zlib.zstdCompressSync(src);
  for (const [coding, buf] of Object.entries(cases)) {
    assert.deepEqual(classifyBody(...packed(coding, buf), opts()),
      { state: 'available', data: JSON_TEXT, bytes: src.length, encoding: coding, encodedBytes: buf.length }, coding);
  }
  const raw = classifyBody(...packed('deflate', zlib.deflateRawSync(src)), opts());
  assert.equal(raw.data, JSON_TEXT, 'deflate bez nagłówka zlib (RFC 1951)');
});

test('dekompresja: kilka kodowań, wielkość liter, identity', () => {
  const src = Buffer.from(JSON_TEXT);
  const twice = zlib.brotliCompressSync(zlib.gzipSync(src)); // najpierw gzip, potem br
  const b = classifyBody(...packed('GZIP, Br', twice), opts());
  assert.equal(b.data, JSON_TEXT);
  assert.equal(b.encoding, 'gzip, br');
  assert.equal(classifyBody(...packed('identity', src), opts()).data, JSON_TEXT);
  assert.equal(classifyBody(...packed('identity', src), opts()).encoding, undefined);
  assert.deepEqual(parseCodings(' gzip ,identity, BR'), ['gzip', 'br']);
});

test('dekompresja: nieznane kodowanie i uszkodzone dane → base64 z powodem', () => {
  const src = Buffer.from(JSON_TEXT);
  const unknown = classifyBody(...packed('compress', src), opts());
  assert.equal(unknown.state, 'skipped');
  assert.equal(unknown.data, src.toString('base64'), 'surowe bajty zostają w base64');
  assert.equal(unknown.encodedBytes, src.length);
  assert.match(unknown.reason, /nieobsługiwane kodowanie compress.*base64/);
  const broken = zlib.gzipSync(src); broken[20] ^= 0xff; broken[21] ^= 0xff;
  const b = classifyBody(...packed('gzip', broken), opts());
  assert.equal(b.state, 'skipped');
  assert.match(b.reason, /nie udało się zdekompresować treści \(gzip: /);
  assert.equal(classifyBody(...packed('br', Buffer.from('to nie jest brotli, tylko tekst')), opts()).state, 'skipped');
  assert.ok(classifyBody(...packed('gzip', broken), opts({ maxStoredBytes: 16 })).data.length <= 16, 'base64 w limicie kolektora');
});

test('dekompresja: bomba dekompresyjna → truncated w limicie kolektora', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 'a')); // ~50 KB → 50 MB
  const b = classifyBody(...packed('gzip', bomb), opts({ maxStoredBytes: 10_000 }));
  assert.equal(b.state, 'truncated');
  // dokładność: jeden bajt wejścia gzip to do ~1 KB wyniku
  assert.ok(b.data.length > 8000 && b.data.length <= 10_000, String(b.data.length));
  assert.match(b.data, /^a+$/, 'początek treści po dekompresji');
  assert.equal(b.bytes, undefined, 'pełny rozmiar po dekompresji nieznany');
  assert.equal(b.encodedBytes, bomb.length);
  assert.match(b.reason, /limit kolektora 10000 B po dekompresji/);
  const twice = classifyBody(...packed('gzip, br', zlib.brotliCompressSync(bomb)), opts({ maxStoredBytes: 10_000 }));
  assert.equal(twice.state, 'truncated', 'limit także na warstwie pośredniej');
  assert.match(twice.data, /^a+$/);
});

test('dekompresja: obcięcie liczone w bajtach skompresowanych', () => {
  const full = zlib.gzipSync(Buffer.from(JSON_TEXT.repeat(20)));
  const [res, rec] = packed('gzip', full.subarray(0, full.length >> 1));
  rec.responseHeaders['content-length'] = String(full.length);
  const b = classifyBody(res, rec, opts({ maxStoredBytes: 1e6 }));
  assert.equal(b.state, 'truncated');
  assert.match(b.reason, new RegExp(`${full.length >> 1} z ${full.length} B skompresowanych`));
  assert.ok(JSON_TEXT.repeat(20).startsWith(b.data) && b.data.length > 0, 'zdekodowany początek');
  delete rec.responseHeaders['content-length'];
  assert.match(classifyBody(res, rec, opts({ maxStoredBytes: 1e6 })).reason, /strumień \(gzip\) jest niepełny/, 'bez content-length');
});

test('dekompresja: treść binarna nie jest rozpakowywana; pusta treść i tekst z charset', () => {
  const png = zlib.gzipSync(Buffer.from([0, 1, 2, 255]));
  const b = classifyBody({ body: png.toString('base64'), base64Encoded: true }, { responseHeaders: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }, opts());
  assert.deepEqual(b, { state: 'skipped', encoding: 'gzip', encodedBytes: png.length, reason: 'treść binarna (image/png)' });
  assert.equal(classifyBody({ body: '', base64Encoded: true }, { type: 'Other', responseHeaders: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, opts()).state, 'available', 'pusta odpowiedź (np. 204, HEAD)');
  // charset=utf-8: inspektor Node oddaje bajty jako tekst UTF-8 (sprawdzone na Node 22), gzip jest wtedy zniekształcony
  const mangled = zlib.gzipSync(Buffer.from(JSON_TEXT)).toString('utf8');
  const m = classifyBody({ body: mangled, base64Encoded: false }, { responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' } }, opts());
  assert.equal(m.state, 'unavailable');
  assert.match(m.reason, /zniekształcone/);
});
