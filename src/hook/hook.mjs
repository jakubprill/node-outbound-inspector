// Hak: kod działający w procesie aplikacji. Przy każdym przychodzącym żądaniu HTTP zapamiętuje je
// w AsyncLocalStorage, a przy każdym zapytaniu wychodzącym (fetch/undici, node:http) zapisuje,
// w kontekście którego żądania strony powstało. Bez zmian w kodzie aplikacji.
//
// installHook musi być samowystarczalna (bez importów i domknięć), bo jest wysyłana jako tekst
// przez Runtime.evaluate.

export function installHook() {
  if (globalThis.__outboundInspector) return 'already';
  const dc = process.getBuiltinModule('node:diagnostics_channel');
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  const als = new AsyncLocalStorage(); const log = []; const ports = new Set(); let n = 0;
  globalThis.__outboundInspector = { log, ports };
  // porty HTTP procesu (np. serwer next dev): te, na których już słucha, i te, na które przychodzą żądania
  try { for (const h of process._getActiveHandles()) { const a = h && typeof h.address === 'function' && h.listening && h.address(); if (a && a.port) ports.add(a.port); } } catch {}
  // wewnętrzne żądania narzędzi dev Next (serwer MCP, HMR, ramki stosu) nie są żądaniami stron
  const internal = /^\/(_next\/(mcp|webpack-hmr|turbopack-hmr)|__nextjs_)/;
  const header = (request, name) => { const v = request.headers && request.headers[name]; return typeof v === 'string' && /^[\w.:-]{1,200}$/.test(v) ? v : undefined; }; // tylko identyfikatory, bez dowolnego tekstu
  dc.subscribe('http.server.request.start', ({ request }) => {
    const port = request.socket && request.socket.localPort; if (port) ports.add(port);
    if (internal.test(request.url || '')) { als.enterWith(null); return; }
    // identyfikatory żądań Next (przeglądarka wysyła je w dev przy nawigacjach RSC i Server Actions):
    // pozwalają złączyć wynik z get_request_insights z Next DevTools MCP
    const nextRequestId = header(request, 'x-nextjs-request-id'), nextHtmlRequestId = header(request, 'x-nextjs-html-request-id');
    als.enterWith({ id: process.pid + '-' + (++n), method: request.method, url: request.url, t: Date.now(),
      ...(nextRequestId ? { nextRequestId } : {}), ...(nextHtmlRequestId ? { nextHtmlRequestId } : {}) });
  });
  const rec = (url, method) => { const s = als.getStore(); if (s) { log.push({ url, method, page: s, t: Date.now() }); if (log.length > 5000) log.shift(); } };
  dc.subscribe('undici:request:create', ({ request }) => rec(request.origin + request.path, request.method));
  dc.subscribe('http.client.request.start', ({ request }) => rec(request.protocol + '//' + request.host + (request.port ? '' : '') + request.path, request.method));
  return 'installed';
}

/** Wyrażenie dla Runtime.evaluate instalujące hak. */
export const INSTALL_EXPRESSION = `(${installHook.toString()})()`;

/** Wyrażenie dla Runtime.evaluate odbierające (i opróżniające) dziennik haka oraz porty HTTP procesu. */
export const DRAIN_EXPRESSION = 'JSON.stringify(globalThis.__outboundInspector ? { log: globalThis.__outboundInspector.log.splice(0), ports: [...(globalThis.__outboundInspector.ports || [])] } : { log: [], ports: [] })';
