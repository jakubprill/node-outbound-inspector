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

/** Czas do pierwszego bajtu odpowiedzi w ms. */
export const ttfb = r => (r.tsResponse != null && r.tsStart != null) ? Math.round((r.tsResponse - r.tsStart) * 1000) : null;

/** Szczegóły jednego zapytania (narzędzie get_server_request). Nagłówki są już zredagowane przy przyjęciu. */
export function details(r, maxBodyChars) {
  const data = r.body?.data;
  return {
    ...row(r), port: r.port, pid: r.pid, statusText: r.statusText, mimeType: r.mimeType,
    requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
    body: data == null ? null : data.slice(0, maxBodyChars), body_truncated: (data?.length ?? 0) > maxBodyChars,
    error: r.error, call_stack: r.origin, wallStart: new Date(r.wallStart).toISOString(),
    // M2: stan treści zamiast pustego łańcucha; czas do pierwszego bajtu
    body_state: r.body?.state ?? 'none', body_bytes: r.body?.bytes ?? null, body_reason: r.body?.reason ?? null,
    // tylko dla treści z content-encoding (bez klucza w pozostałych): kodowanie i rozmiar przed dekompresją
    body_encoding: r.body?.encoding, body_encoded_bytes: r.body?.encodedBytes,
    ttfb_ms: ttfb(r),
  };
}
