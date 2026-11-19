// Zdarzenia CDP Network.* → zmiany w magazynie (czyste). Efekty uboczne zwracane jako lista.
// Redakcja sekretów odbywa się tutaj, zanim dane trafią do magazynu.
import { userFrames } from './frames.mjs';

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
 * @param {{ ignoreHosts: readonly string[], inspectorPorts: readonly number[], nowMs: number,
 *           redact: ReturnType<import('./redact.mjs').createRedactor>, bodies: 'eager' | 'lazy' | 'off' }} ctx
 * @returns {{ type: 'fetch-body', key: string, requestId: string }[]}
 */
export function applyNetworkEvent(store, session, method, p, { ignoreHosts, inspectorPorts, nowMs, redact, bodies = 'eager' }) {
  const key = `${session.processId}:${p.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    let host = '';
    try { host = new URL(p.request.url).host; } catch {}
    if (ignoreHosts.some(h => host.includes(h))) return [];
    if (inspectorPorts.some(port => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return []; // ruch do inspektorów
    store.add({
      key, processId: session.processId, app: session.app, port: session.port, pid: session.pid, requestId: p.requestId,
      method: p.request.method, url: redact.url(p.request.url), requestHeaders: redact.headers(p.request.headers),
      wallStart: normalizeWallTime(p.wallTime, nowMs), tsStart: p.timestamp,
      origin: userFrames(p.initiator),
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
    r.tsEnd = p.timestamp; r.state = 'failed'; r.error = p.errorText;
  }
  return [];
}
