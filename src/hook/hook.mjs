// Hook: code running in the app process. For every incoming HTTP request it remembers it
// in AsyncLocalStorage, and for every outbound request (fetch/undici, node:http) it records
// in the context of which page request it was made. No changes to app code.
//
// installHook must be self-contained (no imports or closures), because it is sent as text
// through Runtime.evaluate.

export function installHook() {
  if (globalThis.__outboundInspector) return 'already';
  const dc = process.getBuiltinModule('node:diagnostics_channel');
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  const als = new AsyncLocalStorage(); const log = []; const ports = new Set(); let n = 0;
  globalThis.__outboundInspector = { log, ports };
  // the process's HTTP ports (e.g. the next dev server): those it already listens on and those requests arrive on
  try { for (const h of process._getActiveHandles()) { const a = h && typeof h.address === 'function' && h.listening && h.address(); if (a && a.port) ports.add(a.port); } } catch {}
  // internal requests of Next dev tooling (MCP server, HMR, stack frames) are not page requests
  const internal = /^\/(_next\/(mcp|webpack-hmr|turbopack-hmr)|__nextjs_)/;
  const header = (request, name) => { const v = request.headers && request.headers[name]; return typeof v === 'string' && /^[\w.:-]{1,200}$/.test(v) ? v : undefined; }; // ids only, no arbitrary text
  dc.subscribe('http.server.request.start', ({ request }) => {
    const port = request.socket && request.socket.localPort; if (port) ports.add(port);
    if (internal.test(request.url || '')) { als.enterWith(null); return; }
    // Next request ids (the browser sends them in dev with RSC navigations and Server Actions):
    // they allow joining the result with get_request_insights from Next DevTools MCP
    const nextRequestId = header(request, 'x-nextjs-request-id'), nextHtmlRequestId = header(request, 'x-nextjs-html-request-id');
    als.enterWith({ id: process.pid + '-' + (++n), method: request.method, url: request.url, t: Date.now(),
      ...(nextRequestId ? { nextRequestId } : {}), ...(nextHtmlRequestId ? { nextHtmlRequestId } : {}) });
  });
  const rec = (url, method) => { const s = als.getStore(); if (s) { log.push({ url, method, page: s, t: Date.now() }); if (log.length > 5000) log.shift(); } };
  dc.subscribe('undici:request:create', ({ request }) => rec(request.origin + request.path, request.method));
  dc.subscribe('http.client.request.start', ({ request }) => rec(request.protocol + '//' + request.host + (request.port ? '' : '') + request.path, request.method));
  return 'installed';
}

/** A Runtime.evaluate expression that installs the hook. */
export const INSTALL_EXPRESSION = `(${installHook.toString()})()`;

/** A Runtime.evaluate expression that receives (and drains) the hook log and the process's HTTP ports. */
export const DRAIN_EXPRESSION = 'JSON.stringify(globalThis.__outboundInspector ? { log: globalThis.__outboundInspector.log.splice(0), ports: [...(globalThis.__outboundInspector.ports || [])] } : { log: [], ports: [] })';
