// Treści odpowiedzi: klasyfikacja wyniku Network.getResponseBody i budżet pamięci kolektora (czyste).
//
// Stany (body.state):
//   none        — jeszcze nie pobrano (tryb lazy) albo zapytanie bez odpowiedzi
//   available   — pełna treść tekstowa w body.data
//   truncated   — część treści (limit kolektora albo bufora inspektora); body.reason mówi który
//   unavailable — inspektor nie udostępnia treści (np. fetch na Node < 24 zwraca pusty łańcuch)
//   evicted     — treść usunięta (z bufora inspektora albo z budżetu kolektora)
//   skipped     — celowo pominięta (treść binarna, tryb off)

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|[\w.+-]*\+(json|xml)))|charset=/i;

const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

/**
 * @param {any} res wynik Network.getResponseBody albo null (błąd / brak treści w inspektorze)
 * @param {{ type?: string, mimeType?: string, responseHeaders?: object }} record
 * @param {{ nodeMajor: number, maxStoredBytes: number, missingState: 'evicted' | 'unavailable' }} opts
 * @returns {{ state: string, data?: string, bytes?: number, reason?: string }}
 */
export function classifyBody(res, record, { nodeMajor, maxStoredBytes, missingState }) {
  if (!res) return { state: missingState, reason: missingState === 'evicted' ? 'treść nie jest już dostępna w inspektorze' : 'inspektor nie zwrócił treści' };
  const contentType = header(record.responseHeaders, 'content-type') ?? record.mimeType ?? '';
  const raw = res.base64Encoded ? Buffer.from(res.body, 'base64') : null;
  if (raw && !TEXTUAL.test(contentType)) return { state: 'skipped', bytes: raw.length, reason: `treść binarna (${contentType || 'nieznany typ'})` };
  const text = raw ? raw.toString('utf8') : String(res.body ?? '');
  const bytes = raw ? raw.length : Buffer.byteLength(text);
  const declared = Number(header(record.responseHeaders, 'content-length'));
  const encoded = header(record.responseHeaders, 'content-encoding');

  if (bytes === 0 && record.type === 'Fetch' && nodeMajor < 24 && !(declared === 0)) {
    return { state: 'unavailable', bytes: 0, reason: `Node ${nodeMajor} nie udostępnia treści odpowiedzi fetch (wymagany Node ≥ 24)` };
  }
  if (bytes > maxStoredBytes) {
    return { state: 'truncated', data: Buffer.from(text).subarray(0, maxStoredBytes).toString('utf8'), bytes, reason: `limit kolektora ${maxStoredBytes} B` };
  }
  if (declared > 0 && !encoded && bytes < declared) {
    return { state: 'truncated', data: text, bytes, reason: `bufor inspektora obciął treść (${bytes} z ${declared} B)` };
  }
  return { state: 'available', data: text, bytes };
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
    r.body = { state: 'evicted', bytes: r.body.bytes, reason: 'budżet treści kolektora' };
    evicted++;
  }
  return evicted;
}
