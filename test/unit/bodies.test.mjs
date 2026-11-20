import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { classifyBody, enforceBodyBudget, parseCodings } from '../../src/bodies.mjs';

const json = { type: 'Fetch', mimeType: 'application/json', responseHeaders: { 'content-type': 'application/json', 'content-length': '19' } };
const opts = (o = {}) => ({ maxStoredBytes: 1000, missingState: 'unavailable', ...o });

test('full body', () => {
  assert.deepEqual(classifyBody({ body: '{"service":"/user"}', base64Encoded: false }, json, opts()), { state: 'available', data: '{"service":"/user"}', bytes: 19 });
});

test('an empty body is an empty response (Node ≥ 24 returns the fetch body)', () => {
  assert.deepEqual(classifyBody({ body: '', base64Encoded: false }, json, opts()), { state: 'truncated', data: '', bytes: 0, reason: 'the inspector buffer cut the body (0 of 19 B)' });
  assert.equal(classifyBody({ body: '', base64Encoded: false }, { ...json, responseHeaders: { 'content-length': '0' } }, opts()).state, 'available');
});

test('no body in the inspector: evicted (lazy) or unavailable', () => {
  assert.equal(classifyBody(null, json, opts({ missingState: 'evicted' })).state, 'evicted');
  assert.equal(classifyBody(null, json, opts()).state, 'unavailable');
});

test('a binary body is not decoded', () => {
  const b = classifyBody({ body: Buffer.from([0, 1, 2, 255]).toString('base64'), base64Encoded: true }, { responseHeaders: { 'content-type': 'image/png' } }, opts());
  assert.deepEqual(b, { state: 'skipped', bytes: 4, reason: 'binary body (image/png)' });
  assert.equal(classifyBody({ body: Buffer.from('{"a":1}').toString('base64'), base64Encoded: true }, json, opts()).data, '{"a":1}', 'text in base64 is decoded');
});

test('truncation: collector limit and inspector buffer', () => {
  const big = classifyBody({ body: 'x'.repeat(1500), base64Encoded: false }, { responseHeaders: {} }, opts());
  assert.equal(big.state, 'truncated'); assert.equal(big.data.length, 1000); assert.equal(big.bytes, 1500);
  const cut = classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '100' } }, opts());
  assert.equal(cut.state, 'truncated'); assert.match(cut.reason, /10 of 100/);
  assert.equal(classifyBody({ body: 'x'.repeat(10), base64Encoded: false }, { responseHeaders: { 'content-length': '5', 'content-encoding': 'gzip' } }, opts()).state, 'available');
});

test('body budget: the oldest successful ones first', () => {
  const rec = (status, n) => ({ status, body: { state: 'available', data: 'x'.repeat(n), bytes: n } });
  const rs = [rec(500, 40), rec(200, 40), rec(200, 40)];
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 1);
  assert.deepEqual(rs.map(r => r.body.state), ['available', 'evicted', 'available']);
  assert.equal(enforceBodyBudget(rs, { maxTotalBytes: 80 }), 0);
});

// A compressed body (issue #1): node:http gives the raw bytes from the wire in base64 in the inspector.
const JSON_TEXT = JSON.stringify({ service: '/small', items: Array.from({ length: 50 }, (_, i) => `pozycja ${i}`) });
const packed = (coding, buf, extra = {}) => [
  { body: buf.toString('base64'), base64Encoded: true },
  { type: 'Other', responseHeaders: { 'content-type': 'application/json', 'content-encoding': coding, 'content-length': String(buf.length), ...extra } },
];

test('decompression: gzip, br, deflate (zlib and raw), zstd', () => {
  const src = Buffer.from(JSON_TEXT);
  const cases = { gzip: zlib.gzipSync(src), br: zlib.brotliCompressSync(src), deflate: zlib.deflateSync(src), 'x-gzip': zlib.gzipSync(src) };
  if (zlib.zstdCompressSync) cases.zstd = zlib.zstdCompressSync(src);
  for (const [coding, buf] of Object.entries(cases)) {
    assert.deepEqual(classifyBody(...packed(coding, buf), opts()),
      { state: 'available', data: JSON_TEXT, bytes: src.length, encoding: coding, encodedBytes: buf.length }, coding);
  }
  const raw = classifyBody(...packed('deflate', zlib.deflateRawSync(src)), opts());
  assert.equal(raw.data, JSON_TEXT, 'deflate without the zlib header (RFC 1951)');
});

test('decompression: several encodings, letter case, identity', () => {
  const src = Buffer.from(JSON_TEXT);
  const twice = zlib.brotliCompressSync(zlib.gzipSync(src)); // gzip first, then br
  const b = classifyBody(...packed('GZIP, Br', twice), opts());
  assert.equal(b.data, JSON_TEXT);
  assert.equal(b.encoding, 'gzip, br');
  assert.equal(classifyBody(...packed('identity', src), opts()).data, JSON_TEXT);
  assert.equal(classifyBody(...packed('identity', src), opts()).encoding, undefined);
  assert.deepEqual(parseCodings(' gzip ,identity, BR'), ['gzip', 'br']);
});

test('decompression: unknown encoding and broken data → skipped with a reason, without raw bytes (audit B-10)', () => {
  const src = Buffer.from(JSON_TEXT);
  const unknown = classifyBody(...packed('compress', src), opts());
  assert.equal(unknown.state, 'skipped');
  assert.equal(unknown.data, undefined, 'raw bytes would bypass redaction');
  assert.equal(unknown.encodedBytes, src.length);
  assert.match(unknown.reason, /unsupported encoding compress/);
  const broken = zlib.gzipSync(src); broken[20] ^= 0xff; broken[21] ^= 0xff;
  const b = classifyBody(...packed('gzip', broken), opts());
  assert.equal(b.state, 'skipped');
  assert.match(b.reason, /could not decompress the body \(gzip: /);
  assert.equal(classifyBody(...packed('br', Buffer.from('this is not brotli, just text')), opts()).state, 'skipped');
  assert.equal(classifyBody(...packed('gzip', broken), opts({ maxStoredBytes: 16 })).data, undefined);
});

test('decompression: decompression bomb → truncated at the collector limit', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 'a')); // ~50 KB → 50 MB
  const b = classifyBody(...packed('gzip', bomb), opts({ maxStoredBytes: 10_000 }));
  assert.equal(b.state, 'truncated');
  // precision: one gzip input byte is up to ~1 KB of output
  assert.ok(b.data.length > 8000 && b.data.length <= 10_000, String(b.data.length));
  assert.match(b.data, /^a+$/, 'the start of the body after decompression');
  assert.equal(b.bytes, undefined, 'the full size after decompression is unknown');
  assert.equal(b.encodedBytes, bomb.length);
  assert.match(b.reason, /collector limit of 10000 B after decompression/);
  const twice = classifyBody(...packed('gzip, br', zlib.brotliCompressSync(bomb)), opts({ maxStoredBytes: 10_000 }));
  assert.equal(twice.state, 'truncated', 'the limit also on an intermediate layer');
  assert.match(twice.data, /^a+$/);
});

test('decompression: truncation counted in compressed bytes', () => {
  const full = zlib.gzipSync(Buffer.from(JSON_TEXT.repeat(20)));
  const [res, rec] = packed('gzip', full.subarray(0, full.length >> 1));
  rec.responseHeaders['content-length'] = String(full.length);
  const b = classifyBody(res, rec, opts({ maxStoredBytes: 1e6 }));
  assert.equal(b.state, 'truncated');
  assert.match(b.reason, new RegExp(`${full.length >> 1} of ${full.length} compressed B`));
  assert.ok(JSON_TEXT.repeat(20).startsWith(b.data) && b.data.length > 0, 'the decoded start');
  delete rec.responseHeaders['content-length'];
  assert.match(classifyBody(res, rec, opts({ maxStoredBytes: 1e6 })).reason, /stream \(gzip\) is incomplete/, 'without content-length');
});

test('decompression: a binary body is not unpacked; an empty body and text with charset', () => {
  const png = zlib.gzipSync(Buffer.from([0, 1, 2, 255]));
  const b = classifyBody({ body: png.toString('base64'), base64Encoded: true }, { responseHeaders: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }, opts());
  assert.deepEqual(b, { state: 'skipped', encoding: 'gzip', encodedBytes: png.length, reason: 'binary body (image/png)' });
  assert.equal(classifyBody({ body: '', base64Encoded: true }, { type: 'Other', responseHeaders: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, opts()).state, 'available', 'an empty response (e.g. 204, HEAD)');
  // charset=utf-8: the Node inspector gives the bytes as UTF-8 text (checked on Node 22), gzip is then garbled
  const mangled = zlib.gzipSync(Buffer.from(JSON_TEXT)).toString('utf8');
  const m = classifyBody({ body: mangled, base64Encoded: false }, { responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' } }, opts());
  assert.equal(m.state, 'unavailable');
  assert.match(m.reason, /garbled/);
});

test('redaction before truncation: a secret at the limit boundary does not leak (audit B-06)', async () => {
  const { createRedactor } = await import('../../src/redact.mjs');
  const r = createRedactor();
  const text = JSON.stringify({ data: 'x'.repeat(200), access_token: 'A'.repeat(60) });
  const res = { body: text, base64Encoded: false };
  const out = classifyBody(res, { mimeType: 'application/json', responseHeaders: { 'content-type': 'application/json' } },
    { maxStoredBytes: 230, missingState: 'unavailable', redactText: r.body });
  assert.equal(out.state, 'truncated');
  assert.ok(!out.data.includes('AAAAAAAAAA'), out.data);
  assert.equal(out.redactedFields, 1);
});

test('zstd over the collector limit: skipped without data (audit B-10)', { skip: !zlib.zstdCompressSync && 'no zstd' }, () => {
  const json = JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ i, name: 'item ' + i })), access_token: 'TOPSECRET123' });
  const out = classifyBody({ body: zlib.zstdCompressSync(Buffer.from(json)).toString('base64'), base64Encoded: true },
    { responseHeaders: { 'content-type': 'application/json', 'content-encoding': 'zstd' } }, { maxStoredBytes: 16 * 1024, missingState: 'unavailable' });
  assert.equal(out.state, 'skipped');
  assert.equal(out.data, undefined);
  assert.match(out.reason, /exceeds the collector limit/);
});
