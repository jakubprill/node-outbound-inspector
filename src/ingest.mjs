// Zdarzenia CDP Network.* → zmiany w magazynie (czyste). Efekty uboczne zwracane jako lista.
// Redakcja sekretów odbywa się tutaj, zanim dane trafią do magazynu.
import { userFrames } from './frames.mjs';
import { ignoreReason } from './ignore.mjs';

/** Node podaje wallTime w ms, specyfikacja CDP w sekundach — wartość < 10¹¹ traktujemy jako sekundy. */
/** Limity pól z inspektora (audyt B-11): proces po drugiej stronie może wysłać dowolnie duże dane. */
export const FIELD_LIMITS = Object.freeze({ url: 8192, headerValue: 8192, headers: 200, text: 2000 });
// tekst z inspektora: bez znaków sterujących (nowe linie w nagłówku mogłyby udawać osobne polecenia, audyt B-07)
export const clean = s => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
const cut = (s, n) => typeof s === 'string' ? clean(s.length > n ? s.slice(0, n) + '…' : s) : '';
/** Nagłówki jako obiekt tekstów, z limitem liczby i długości. */
export function capHeaders(h) {
  if (!h || typeof h !== 'object') return {};
  return Object.fromEntries(Object.entries(h).slice(0, FIELD_LIMITS.headers).map(([k, v]) => [cut(k, 256), cut(String(v), FIELD_LIMITS.headerValue)]));
}

export function normalizeWallTime(wallTime, nowMs) {
  if (wallTime == null || !Number.isFinite(wallTime)) return nowMs;
  return wallTime < 1e11 ? wallTime * 1000 : wallTime;
}

/**
 * @param {ReturnType<import('./store.mjs').createStore>} store
 * @param {{ processId: number, port: number, app: string, pid?: number }} session
 * @param {string} method
 * @param {any} p parametry zdarzenia
 * @param {{ ignoreHosts: readonly string[], inspectorPorts: readonly number[], ignoreOtlp?: boolean, nowMs: number,
 *           redact: ReturnType<import('./redact.mjs').createRedactor>, bodies: 'eager' | 'lazy' | 'off',
 *           libraryPaths?: readonly string[] }} ctx
 * @returns {({ type: 'fetch-body', key: string, requestId: string } | { type: 'ignored', reason: 'hosts' | 'inspector' | 'otlp' })[]}
 */
export function applyNetworkEvent(store, session, method, p, { ignoreHosts, inspectorPorts, ignoreOtlp = false, nowMs, redact, bodies = 'eager', libraryPaths = [] }) {
  // kształt zdarzenia sprawdzany przed użyciem: fałszywy inspektor nie może wywrócić kolektora (audyt B-04)
  if (!p || typeof p !== 'object' || typeof p.requestId !== 'string' || p.requestId.length > 256) return [];
  const key = `${session.processId}:${p.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    if (typeof p.request?.url !== 'string' || typeof p.request.method !== 'string' || !Number.isFinite(p.timestamp)) return [];
    // pominięte zapytanie nie trafia do magazynu, więc jego dalsze zdarzenia też przepadają (brak rekordu)
    const reason = ignoreReason(p.request.url, { ignoreHosts, inspectorPorts, ignoreOtlp });
    if (reason) return [{ type: 'ignored', reason }];
    store.add({
      key, processId: session.processId, app: session.app, appAliases: session.appAliases ?? [], port: session.port, pid: session.pid, requestId: p.requestId,
      method: cut(p.request.method, 16), url: redact.url(cut(p.request.url, FIELD_LIMITS.url)), requestHeaders: redact.headers(capHeaders(p.request.headers)),
      wallStart: normalizeWallTime(p.wallTime, nowMs), tsStart: p.timestamp,
      origin: userFrames(p.initiator && typeof p.initiator === 'object' ? p.initiator : {}, { libraryPaths }),
      body: { state: 'none' },
    });
    return [];
  }
  const r = store.get(key);
  if (!r) return [];
  const ts = Number.isFinite(p.timestamp) ? p.timestamp : undefined;
  if (ts === undefined && method !== 'Network.responseReceived') return [];
  if (method === 'Network.responseReceived') {
    const res = p.response;
    if (!res || typeof res !== 'object' || !Number.isInteger(res.status)) return [];
    r.status = res.status; r.statusText = cut(res.statusText, 200);
    r.mimeType = cut(res.mimeType, 200); r.responseHeaders = redact.headers(capHeaders(res.headers)); r.type = cut(p.type, 50);
    r.tsResponse = ts;
  } else if (method === 'Network.loadingFinished') {
    r.tsEnd = p.timestamp; r.state = 'finished';
    if (bodies === 'off') { r.body = { state: 'skipped', reason: 'body mode: off' }; return []; }
    if (bodies === 'eager') return [{ type: 'fetch-body', key, requestId: p.requestId }];
  } else if (method === 'Network.loadingFailed') {
    // errorText bywa pusty (np. AggregateError bez opisu) — pokazanie tego jest zadaniem render.mjs
    r.tsEnd = p.timestamp; r.state = 'failed'; r.error = cut(p.errorText ?? '', FIELD_LIMITS.text);
  }
  return [];
}
