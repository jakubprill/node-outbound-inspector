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
  const als = new AsyncLocalStorage(); const log = []; let n = 0;
  globalThis.__outboundInspector = { log };
  dc.subscribe('http.server.request.start', ({ request }) => {
    als.enterWith({ id: process.pid + '-' + (++n), method: request.method, url: request.url, t: Date.now() });
  });
  const rec = (url, method) => { const s = als.getStore(); if (s) { log.push({ url, method, page: s, t: Date.now() }); if (log.length > 5000) log.shift(); } };
  dc.subscribe('undici:request:create', ({ request }) => rec(request.origin + request.path, request.method));
  dc.subscribe('http.client.request.start', ({ request }) => rec(request.protocol + '//' + request.host + (request.port ? '' : '') + request.path, request.method));
  return 'installed';
}

/** Wyrażenie dla Runtime.evaluate instalujące hak. */
export const INSTALL_EXPRESSION = `(${installHook.toString()})()`;

/** Wyrażenie dla Runtime.evaluate odbierające (i opróżniające) dziennik haka. */
export const DRAIN_EXPRESSION = 'JSON.stringify(globalThis.__outboundInspector ? globalThis.__outboundInspector.log.splice(0) : [])';
