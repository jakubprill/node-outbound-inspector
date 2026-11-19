// Magazyn zapytań wychodzących w pamięci (czysty: bez zegarów i I/O).
// Klucz rekordu: `${port}:${requestId}`; `id` to rosnący numer nadawany przy dodaniu.

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
    select({ app, url_contains, page_contains, last_ms, since_id } = {}, nowMs = 0) {
      let rs = [...requests.values()];
      if (app) rs = rs.filter(r => matchesApp(r, app));
      if (url_contains) rs = rs.filter(r => r.url.includes(url_contains));
      if (page_contains) rs = rs.filter(r => r.page && `${r.page.method} ${r.page.url}`.includes(page_contains));
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
