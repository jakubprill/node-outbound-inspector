// Zdarzenia CDP Network.* → zmiany w magazynie (czyste). Efekty uboczne zwracane jako lista.
// Redakcja sekretów odbywa się tutaj, zanim dane trafią do magazynu.
import { userFrames } from './frames.mjs';
import { ignoreReason } from './ignore.mjs';

/** Node podaje wallTime w ms, specyfikacja CDP w sekundach — wartość < 10¹¹ traktujemy jako sekundy. */
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
  const key = `${session.processId}:${p.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    // pominięte zapytanie nie trafia do magazynu, więc jego dalsze zdarzenia też przepadają (brak rekordu)
    const reason = ignoreReason(p.request.url, { ignoreHosts, inspectorPorts, ignoreOtlp });
    if (reason) return [{ type: 'ignored', reason }];
    store.add({
      key, processId: session.processId, app: session.app, port: session.port, pid: session.pid, requestId: p.requestId,
      method: p.request.method, url: redact.url(p.request.url), requestHeaders: redact.headers(p.request.headers),
      wallStart: normalizeWallTime(p.wallTime, nowMs), tsStart: p.timestamp,
      origin: userFrames(p.initiator, { libraryPaths }),
      body: { state: 'none' },
    });
    return [];
  }
  const r = store.get(key);
  if (!r) return [];
  if (method === 'Network.responseReceived') {
    r.status = p.response.status; r.statusText = p.response.statusText;
    r.mimeType = p.response.mimeType; r.responseHeaders = redact.headers(p.response.headers); r.type = p.type;
    r.tsResponse = p.timestamp;
  } else if (method === 'Network.loadingFinished') {
    r.tsEnd = p.timestamp; r.state = 'finished';
    if (bodies === 'off') { r.body = { state: 'skipped', reason: 'tryb treści: off' }; return []; }
    if (bodies === 'eager') return [{ type: 'fetch-body', key, requestId: p.requestId }];
  } else if (method === 'Network.loadingFailed') {
    // errorText bywa pusty (np. AggregateError bez opisu) — pokazanie tego jest zadaniem render.mjs
    r.tsEnd = p.timestamp; r.state = 'failed'; r.error = p.errorText ?? '';
  }
  return [];
}
