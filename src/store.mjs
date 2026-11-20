// Magazyn zapytań wychodzących w pamięci (czysty: bez zegarów i I/O).
// Klucz rekordu: `${port}:${requestId}`; `id` to rosnący numer nadawany przy dodaniu.

/**
 * Filtr statusu z narzędzi MCP: kod (`404`), klasa (`5xx`), `error` (4xx/5xx albo nieudane),
 * `failed` (bez odpowiedzi) albo `pending` (w toku).
 * @returns {(r: any) => boolean}
 */
export function statusMatcher(status) {
  const v = String(status).trim().toLowerCase();
  if (/^\d{3}$/.test(v)) return r => r.status === Number(v);
  if (/^[1-5]xx$/.test(v)) return r => r.status != null && Math.floor(r.status / 100) === Number(v[0]);
  if (v === 'error') return r => r.state === 'failed' || r.status >= 400;
  if (v === 'failed') return r => r.state === 'failed';
  if (v === 'pending') return r => r.tsEnd == null;
  throw new Error(`Unknown status filter "${status}". Use a code (404), a class (5xx), "error", "failed" or "pending".`);
}

/**
 * @param {{ maxRequests: number }} limits
 */
export function createStore({ maxRequests }) {
  const requests = new Map();
  let seq = 0;

  const matchesApp = (r, app) => r.app === app || String(r.port) === String(app);

  return {
    /** Dodaje rekord (bez `id`), nadaje `id`, usuwa najstarszy po przekroczeniu limitu. */
    add(record) {
      if (requests.size >= maxRequests) requests.delete(requests.keys().next().value);
      const r = { id: ++seq, ...record };
      requests.set(r.key, r);
      return r;
    },
    get: key => requests.get(key),
    byId: id => [...requests.values()].find(r => r.id === id),
    values: () => [...requests.values()],
    get size() { return requests.size; },
    get lastId() { return seq; },
    appsSeen: () => [...new Set([...requests.values()].map(r => r.app))],

    /** Filtr jak w narzędziach MCP; `nowMs` potrzebne tylko dla `last_ms`. */
    select({ app, url_contains, page_contains, page_request_id, next_request_id, next_html_request_id, status, last_ms, since_id } = {}, nowMs = 0) {
      let rs = [...requests.values()];
      if (app) rs = rs.filter(r => matchesApp(r, app));
      if (url_contains) rs = rs.filter(r => r.url.includes(url_contains));
      if (page_contains) rs = rs.filter(r => r.page && `${r.page.method} ${r.page.url}`.includes(page_contains));
      if (page_request_id != null && page_request_id !== '') rs = rs.filter(r => r.page && String(r.page.id) === String(page_request_id));
      if (next_request_id) rs = rs.filter(r => r.page?.nextRequestId === String(next_request_id));
      if (next_html_request_id) rs = rs.filter(r => r.page?.nextHtmlRequestId === String(next_html_request_id));
      if (status != null && status !== '') rs = rs.filter(statusMatcher(status));
      if (since_id) rs = rs.filter(r => r.id > since_id);
      if (last_ms) { const cut = nowMs - last_ms; rs = rs.filter(r => r.wallStart >= cut); }
      return rs.sort((a, b) => a.wallStart - b.wallStart || a.tsStart - b.tsStart);
    },

    /** Usuwa wszystkie rekordy albo rekordy jednej aplikacji; zwraca liczbę usuniętych. */
    clear({ app } = {}) {
      let n = 0;
      for (const [k, r] of requests) if (!app || matchesApp(r, app)) { requests.delete(k); n++; }
      return n;
    },
  };
}
