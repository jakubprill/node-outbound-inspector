// Response bodies: classifying the Network.getResponseBody result, decompression by content-encoding
// and the collector's memory budget (pure: node:zlib is computation, not I/O).
//
// Stany (body.state):
//   none        — not fetched yet (lazy mode) or a request without a response
//   available   — the full text body in body.data
//   truncated   — part of the body (collector limit, inspector buffer, broken stream); body.reason says which
//   unavailable — the inspector does not provide the body (e.g. a body garbled by the inspector)
//   evicted     — the body was removed (from the inspector buffer or the collector budget)
//   skipped     — not shown as text: a binary body, off mode, or an encoding that cannot be
//                 decoded (no raw bytes: they would bypass redaction, audit B-10)
// A body with content-encoding: body.bytes is the size after decompression, body.encodedBytes — on the wire,
// body.encoding — the encodings in header order (e.g. 'gzip, br').
import zlib from 'node:zlib';

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|[\w.+-]*\+(json|xml)))|charset=/i;
// Compressed bytes decoded by the inspector as UTF-8: replacement or control characters.
const MANGLED = /[\uFFFD\u0000-\u0008\u000E-\u001F]/;

const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

const Z = zlib.constants;
const ZLIB_FLUSH = { finishFlush: Z.Z_SYNC_FLUSH };
/** deflate per RFC 9110 is the zlib format, but some servers send a raw stream (RFC 1951). */
const inflateAny = (buf, opts) => {
  try { return zlib.inflateSync(buf, opts); }
  catch (e) { if (e.code === 'Z_DATA_ERROR') return zlib.inflateRawSync(buf, opts); throw e; }
};
// encoding → [decoder, options for decoding a broken stream without an error]
const DECODERS = {
  gzip: [zlib.gunzipSync, ZLIB_FLUSH], 'x-gzip': [zlib.gunzipSync, ZLIB_FLUSH],
  deflate: [inflateAny, ZLIB_FLUSH],
  br: [zlib.brotliDecompressSync, { finishFlush: Z.BROTLI_OPERATION_FLUSH }],
  ...(zlib.zstdDecompressSync && { zstd: [zlib.zstdDecompressSync, {}] }), // Node ≥ 22.15 / 23.8
};

/** 'GZIP, br' → ['gzip', 'br'] (order of application); identity skipped. */
export const parseCodings = value => String(value ?? '').split(/[,\n]/)
  .map(s => s.trim().toLowerCase()).filter(s => s && s !== 'identity');

/**
 * One layer with an output limit (decompression bomb protection). When the limit is exceeded
 * it returns the longest output prefix that fits the limit: a binary search over the input
 * length, each attempt ends after at most `limit` output bytes.
 */
function decodeLayer(buf, [decode, flushOpts], limit) {
  const opts = { maxOutputLength: limit };
  try { return { out: decode(buf, opts), cut: false, over: false }; }
  catch (e) { if (e.code !== 'ERR_BUFFER_TOO_LARGE' && e.code !== 'Z_BUF_ERROR') throw e; }
  const prefix = n => {
    // any prefix error (zstd reports a broken stream, not an exceeded limit) means no output for that length
    try { return decode(buf.subarray(0, n), { ...flushOpts, ...opts }); }
    catch { return null; }
  };
  const whole = prefix(buf.length);
  if (whole) return { out: whole, cut: true, over: false }; // broken stream, but fits the limit
  let lo = 0, hi = buf.length, out = Buffer.alloc(0);
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1, o = prefix(mid);
    if (o) { lo = mid; out = o; } else hi = mid;
  }
  return { out, cut: false, over: true };
}

/**
 * Decompression by the list of encodings (removed from the last one). Throws on an
 * unsupported encoding or broken data.
 * @param {Buffer} raw  @param {string[]} codings  @param {number} limit max output size in bytes
 * @returns {{ out: Buffer, cut: boolean, over: boolean }} cut — broken stream, over — limit exceeded
 */
export function decodeContent(raw, codings, limit) {
  for (const c of codings) {
    if (!DECODERS[c]) throw new Error(c === 'zstd' ? 'zstd requires Node ≥ 22.15' : `unsupported encoding ${c}`);
  }
  let out = raw, cut = false, over = false;
  for (const c of [...codings].reverse()) {
    const r = decodeLayer(out, DECODERS[c], Math.max(1, limit));
    out = r.out; cut ||= r.cut; over ||= r.over;
  }
  return { out, cut, over };
}

/**
 * @param {any} res the Network.getResponseBody result or null (error / no body in the inspector)
 * @param {{ type?: string, mimeType?: string, responseHeaders?: object }} record
 * @param {{ maxStoredBytes: number, missingState: 'evicted' | 'unavailable',
 *   redactText?: (text: string, contentType: string) => { text: string, count: number } }} opts
 *   redactText works on the full text, before truncation: the cut will not reveal the start of a secret (audit B-06)
 * @returns {{ state: string, data?: string, bytes?: number, encodedBytes?: number, encoding?: string, reason?: string, redactedFields?: number }}
 */
export function classifyBody(res, record, { maxStoredBytes, missingState, redactText }) {
  if (!res) return { state: missingState, reason: missingState === 'evicted' ? 'body is no longer available in the inspector' : 'the inspector returned no body' };
  const contentType = header(record.responseHeaders, 'content-type') ?? record.mimeType ?? '';
  const declared = Number(header(record.responseHeaders, 'content-length')); // bytes on the wire, i.e. compressed
  const codings = parseCodings(header(record.responseHeaders, 'content-encoding'));
  const encoding = codings.length ? codings.join(', ') : undefined;
  const raw = res.base64Encoded ? Buffer.from(res.body, 'base64') : null;
  const compressed = !!(raw?.length && encoding);
  const enc = compressed ? { encoding, encodedBytes: raw.length } : {};

  if (raw && !TEXTUAL.test(contentType)) {
    return { state: 'skipped', ...(compressed ? enc : { bytes: raw.length }), reason: `binary body (${contentType || 'unknown type'})` };
  }
  let text, bytes, cut = false, over = false;
  if (compressed) {
    let d;
    try { d = decodeContent(raw, codings, maxStoredBytes); } catch (e) {
      return { state: 'skipped', ...enc, reason: `could not decompress the body (${encoding}: ${e.message})` };
    }
    ({ cut, over } = d); text = d.out.toString('utf8'); bytes = d.out.length;
  } else {
    text = raw ? raw.toString('utf8') : String(res.body ?? '');
    bytes = raw ? raw.length : Buffer.byteLength(text);
    // content-type with charset: the inspector returns the bytes as UTF-8 text, compressed bytes are then unrecoverable
    if (!raw && encoding && MANGLED.test(text)) {
      return { state: 'unavailable', encoding, reason: `the Node inspector returned the compressed body (${encoding}) as UTF-8 text (content-type with charset); the bytes are garbled, decompression is impossible` };
    }
  }
  const wireBytes = raw ? raw.length : (encoding ? null : bytes); // text body with an encoding: wire size unknown

  if (over && !text) return { state: 'skipped', ...enc, reason: `the body exceeds the collector limit of ${maxStoredBytes} B after decompression and cannot be cut (${encoding})` };
  let redacted = {};
  if (redactText) { const r = redactText(text, contentType); if (r.count) { text = r.text; redacted = { redactedFields: r.count }; } }
  if (over) {
    return { state: 'truncated', data: text, ...enc, ...redacted, reason: `collector limit of ${maxStoredBytes} B after decompression (compressed body: ${raw.length} B)` };
  }
  if (bytes > maxStoredBytes) {
    return { state: 'truncated', data: Buffer.from(text).subarray(0, maxStoredBytes).toString('utf8'), bytes, ...redacted, reason: `collector limit of ${maxStoredBytes} B` };
  }
  if (declared > 0 && wireBytes != null && wireBytes < declared) {
    return { state: 'truncated', data: text, bytes, ...enc, ...redacted, reason: `the inspector buffer cut the body (${wireBytes} of ${declared}${compressed ? ' compressed' : ''} B)` };
  }
  if (cut) return { state: 'truncated', data: text, bytes, ...enc, ...redacted, reason: `the compressed stream (${encoding}) is incomplete` };
  return { state: 'available', data: text, bytes, ...enc, ...redacted };
}

/**
 * Keeps the total size of stored bodies in check: removes the oldest, first among responses
 * without an error. Modifies records in place; returns the number of removed bodies.
 * @param {any[]} records from oldest
 */
export function enforceBodyBudget(records, { maxTotalBytes }) {
  const stored = records.filter(r => r.body?.data != null);
  let total = stored.reduce((s, r) => s + Buffer.byteLength(r.body.data), 0);
  if (total <= maxTotalBytes) return 0;
  const isError = r => r.state === 'failed' || r.status >= 400;
  const order = [...stored.filter(r => !isError(r)), ...stored.filter(isError)];
  let evicted = 0;
  for (const r of order) {
    if (total <= maxTotalBytes) break;
    total -= Buffer.byteLength(r.body.data);
    const { bytes, encoding, encodedBytes } = r.body;
    r.body = { state: 'evicted', bytes, ...(encoding && { encoding, encodedBytes }), reason: 'collector body budget' };
    evicted++;
  }
  return evicted;
}
