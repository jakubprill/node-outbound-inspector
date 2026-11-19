// Zdarzenia CDP Network.* → zmiany w magazynie (czyste). Efekty uboczne zwracane jako lista.
import { userFrames } from './frames.mjs';

/**
 * @param {ReturnType<import('./store.mjs').createStore>} store
 * @param {{ port: number, app: string, pid?: number }} session
 * @param {string} method
 * @param {any} p parametry zdarzenia
 * @param {{ ignoreHosts: readonly string[], inspectorPorts: readonly number[], nowMs: number }} ctx
 * @returns {{ type: 'fetch-body', key: string, requestId: string }[]}
 */
export function applyNetworkEvent(store, session, method, p, { ignoreHosts, inspectorPorts, nowMs }) {
  const key = `${session.port}:${p.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    let host = '';
    try { host = new URL(p.request.url).host; } catch {}
    if (ignoreHosts.some(h => host.includes(h))) return [];
    if (inspectorPorts.some(port => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return []; // ruch do inspektorów
    store.add({
      key, app: session.app, port: session.port, pid: session.pid, requestId: p.requestId,
      method: p.request.method, url: p.request.url, requestHeaders: p.request.headers,
      wallStart: p.wallTime ?? nowMs, tsStart: p.timestamp,
      origin: userFrames(p.initiator),
    });
    return [];
  }
  const r = store.get(key);
  if (!r) return [];
  if (method === 'Network.responseReceived') {
    r.status = p.response.status; r.statusText = p.response.statusText;
    r.mimeType = p.response.mimeType; r.responseHeaders = p.response.headers; r.type = p.type;
  } else if (method === 'Network.loadingFinished') {
    r.tsEnd = p.timestamp; r.state = 'finished';
    return [{ type: 'fetch-body', key, requestId: p.requestId }];
  } else if (method === 'Network.loadingFailed') {
    r.tsEnd = p.timestamp; r.state = 'failed'; r.error = p.errorText;
  }
  return [];
}

/** Wynik `Network.getResponseBody` → tekst treści (albo undefined). */
export function decodeBody(res) {
  if (!res) return undefined;
  return res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
}
