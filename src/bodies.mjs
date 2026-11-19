// Treści odpowiedzi: klasyfikacja wyniku Network.getResponseBody, dekompresja według content-encoding
// i budżet pamięci kolektora (czyste: node:zlib to obliczenia, nie I/O).
//
// Stany (body.state):
//   none        — jeszcze nie pobrano (tryb lazy) albo zapytanie bez odpowiedzi
//   available   — pełna treść tekstowa w body.data
//   truncated   — część treści (limit kolektora, bufor inspektora, urwany strumień); body.reason mówi który
//   unavailable — inspektor nie udostępnia treści (np. fetch na Node < 24 zwraca pusty łańcuch)
//   evicted     — treść usunięta (z bufora inspektora albo z budżetu kolektora)
//   skipped     — nie pokazana jako tekst: treść binarna, tryb off albo kodowanie, którego nie da się
//                 zdekodować (wtedy body.data to surowe bajty w base64, a body.reason to mówi)
// Treść z content-encoding: body.bytes to rozmiar po dekompresji, body.encodedBytes — na łączu,
// body.encoding — kodowania w kolejności z nagłówka (np. 'gzip, br').
import zlib from 'node:zlib';

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|[\w.+-]*\+(json|xml)))|charset=/i;
// Skompresowane bajty zdekodowane przez inspektor jako UTF-8: znaki zastępcze albo sterujące.
const MANGLED = /[\uFFFD\u0000-\u0008\u000E-\u001F]/;

const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

const Z = zlib.constants;
const ZLIB_FLUSH = { finishFlush: Z.Z_SYNC_FLUSH };
/** deflate według RFC 9110 to format zlib, ale część serwerów wysyła surowy strumień (RFC 1951). */
const inflateAny = (buf, opts) => {
  try { return zlib.inflateSync(buf, opts); }
  catch (e) { if (e.code === 'Z_DATA_ERROR') return zlib.inflateRawSync(buf, opts); throw e; }
};
// kodowanie → [dekoder, opcje dekodowania urwanego strumienia bez błędu]
const DECODERS = {
  gzip: [zlib.gunzipSync, ZLIB_FLUSH], 'x-gzip': [zlib.gunzipSync, ZLIB_FLUSH],
  deflate: [inflateAny, ZLIB_FLUSH],
  br: [zlib.brotliDecompressSync, { finishFlush: Z.BROTLI_OPERATION_FLUSH }],
  ...(zlib.zstdDecompressSync && { zstd: [zlib.zstdDecompressSync, {}] }), // Node ≥ 22.15 / 23.8
};

/** 'GZIP, br' → ['gzip', 'br'] (kolejność nałożenia); identity pomijane. */
export const parseCodings = value => String(value ?? '').split(/[,\n]/)
  .map(s => s.trim().toLowerCase()).filter(s => s && s !== 'identity');

/**
 * Jedna warstwa z limitem wyniku (ochrona przed bombą dekompresyjną). Przy przekroczeniu limitu
 * zwraca najdłuższy początek wyniku mieszczący się w limicie: wyszukiwanie binarne po długości
 * wejścia, każda próba kończy się najpóźniej po `limit` bajtach wyniku.
 */
function decodeLayer(buf, [decode, flushOpts], limit) {
  const opts = { maxOutputLength: limit };
  try { return { out: decode(buf, opts), cut: false, over: false }; }
  catch (e) { if (e.code !== 'ERR_BUFFER_TOO_LARGE' && e.code !== 'Z_BUF_ERROR') throw e; }
  const prefix = n => {
    try { return decode(buf.subarray(0, n), { ...flushOpts, ...opts }); }
    catch (e) { if (e.code === 'ERR_BUFFER_TOO_LARGE') return null; throw e; }
  };
  const whole = prefix(buf.length);
  if (whole) return { out: whole, cut: true, over: false }; // urwany strumień, ale mieści się w limicie
  let lo = 0, hi = buf.length, out = Buffer.alloc(0);
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1, o = prefix(mid);
    if (o) { lo = mid; out = o; } else hi = mid;
  }
  return { out, cut: false, over: true };
}

/**
 * Dekompresja według listy kodowań (zdejmowanych od ostatniego). Rzuca błąd przy kodowaniu
 * nieobsługiwanym albo uszkodzonych danych.
 * @param {Buffer} raw  @param {string[]} codings  @param {number} limit maks. rozmiar wyniku w bajtach
 * @returns {{ out: Buffer, cut: boolean, over: boolean }} cut — strumień urwany, over — przekroczony limit
 */
export function decodeContent(raw, codings, limit) {
  for (const c of codings) {
    if (!DECODERS[c]) throw new Error(c === 'zstd' ? 'zstd wymaga Node ≥ 22.15' : `nieobsługiwane kodowanie ${c}`);
  }
  let out = raw, cut = false, over = false;
  for (const c of [...codings].reverse()) {
    const r = decodeLayer(out, DECODERS[c], Math.max(1, limit));
    out = r.out; cut ||= r.cut; over ||= r.over;
  }
  return { out, cut, over };
}

/**
 * @param {any} res wynik Network.getResponseBody albo null (błąd / brak treści w inspektorze)
 * @param {{ type?: string, mimeType?: string, responseHeaders?: object }} record
 * @param {{ nodeMajor: number, maxStoredBytes: number, missingState: 'evicted' | 'unavailable' }} opts
 * @returns {{ state: string, data?: string, bytes?: number, encodedBytes?: number, encoding?: string, reason?: string }}
 */
export function classifyBody(res, record, { nodeMajor, maxStoredBytes, missingState }) {
  if (!res) return { state: missingState, reason: missingState === 'evicted' ? 'treść nie jest już dostępna w inspektorze' : 'inspektor nie zwrócił treści' };
  const contentType = header(record.responseHeaders, 'content-type') ?? record.mimeType ?? '';
  const declared = Number(header(record.responseHeaders, 'content-length')); // bajty na łączu, czyli po kompresji
  const codings = parseCodings(header(record.responseHeaders, 'content-encoding'));
  const encoding = codings.length ? codings.join(', ') : undefined;
  const raw = res.base64Encoded ? Buffer.from(res.body, 'base64') : null;
  const compressed = !!(raw?.length && encoding);
  const enc = compressed ? { encoding, encodedBytes: raw.length } : {};

  if (raw && !TEXTUAL.test(contentType)) {
    return { state: 'skipped', ...(compressed ? enc : { bytes: raw.length }), reason: `treść binarna (${contentType || 'nieznany typ'})` };
  }
  let text, bytes, cut = false, over = false;
  if (compressed) {
    let d;
    try { d = decodeContent(raw, codings, maxStoredBytes); } catch (e) {
      const data = raw.subarray(0, Math.floor(maxStoredBytes / 4) * 3).toString('base64');
      return { state: 'skipped', data, ...enc, reason: `nie udało się zdekompresować treści (${encoding}: ${e.message}); body zawiera surowe bajty w base64` };
    }
    ({ cut, over } = d); text = d.out.toString('utf8'); bytes = d.out.length;
  } else {
    text = raw ? raw.toString('utf8') : String(res.body ?? '');
    bytes = raw ? raw.length : Buffer.byteLength(text);
    // content-type z charset: inspektor oddaje bajty jako tekst UTF-8, skompresowane są wtedy nie do odzyskania
    if (!raw && encoding && MANGLED.test(text)) {
      return { state: 'unavailable', encoding, reason: `inspektor Node zwrócił skompresowaną treść (${encoding}) jako tekst UTF-8 (content-type z charset); bajty są zniekształcone, dekompresja niemożliwa` };
    }
  }
  const wireBytes = raw ? raw.length : (encoding ? null : bytes); // treść tekstowa z kodowaniem: rozmiar na łączu nieznany

  if (wireBytes === 0 && record.type === 'Fetch' && nodeMajor < 24 && !(declared === 0)) {
    return { state: 'unavailable', bytes: 0, reason: `Node ${nodeMajor} nie udostępnia treści odpowiedzi fetch (wymagany Node ≥ 24)` };
  }
  if (over) {
    return { state: 'truncated', data: text, ...enc, reason: `limit kolektora ${maxStoredBytes} B po dekompresji (skompresowana treść: ${raw.length} B)` };
  }
  if (bytes > maxStoredBytes) {
    return { state: 'truncated', data: Buffer.from(text).subarray(0, maxStoredBytes).toString('utf8'), bytes, reason: `limit kolektora ${maxStoredBytes} B` };
  }
  if (declared > 0 && wireBytes != null && wireBytes < declared) {
    return { state: 'truncated', data: text, bytes, ...enc, reason: `bufor inspektora obciął treść (${wireBytes} z ${declared} B${compressed ? ' skompresowanych' : ''})` };
  }
  if (cut) return { state: 'truncated', data: text, bytes, ...enc, reason: `skompresowany strumień (${encoding}) jest niepełny` };
  return { state: 'available', data: text, bytes, ...enc };
}

/**
 * Pilnuje łącznego rozmiaru przechowywanych treści: usuwa najstarsze, najpierw spośród odpowiedzi
 * bez błędu. Modyfikuje rekordy w miejscu; zwraca liczbę usuniętych treści.
 * @param {any[]} records w kolejności od najstarszego
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
    r.body = { state: 'evicted', bytes, ...(encoding && { encoding, encodedBytes }), reason: 'budżet treści kolektora' };
    evicted++;
  }
  return evicted;
}
