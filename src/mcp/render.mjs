// Kształt pojedynczego wiersza zapytania w odpowiedziach narzędzi (czyste).
import { duration } from '../analyze/timeline.mjs';

export const NO_ORIGIN = '(brak ramki z kodu aplikacji — np. fetch opakowany przez Next.js; szukaj po URL)';

/** @param {any} r rekord zapytania  @param {number} [t0] początek osi czasu (sekundy inspektora) */
export function row(r, t0) {
  return {
    id: r.id, app: r.app, page: r.page ? `${r.page.method} ${r.page.url}` : null, method: r.method, url: r.url,
    status: r.state === 'failed' ? `FAILED: ${r.error}` : (r.status ?? 'pending'),
    start_ms: t0 != null ? Math.round((r.tsStart - t0) * 1000) : undefined,
    duration_ms: duration(r),
    origin: r.origin[0] ?? NO_ORIGIN,
  };
}

/** Szczegóły jednego zapytania (narzędzie get_server_request). */
export function details(r, maxBodyChars) {
  return {
    ...row(r), port: r.port, pid: r.pid, statusText: r.statusText, mimeType: r.mimeType,
    requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
    body: r.body?.slice(0, maxBodyChars), body_truncated: (r.body?.length ?? 0) > maxBodyChars,
    error: r.error, call_stack: r.origin, wallStart: new Date(r.wallStart).toISOString(),
  };
}
