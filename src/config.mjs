// The one place reading configuration from the environment. The result is frozen.

/** "9229-9249,9300" → [9229, …, 9249, 9300] */
export function parsePorts(spec) {
  return String(spec).split(',').flatMap(part => {
    const [a, b] = part.trim().split('-').map(Number);
    return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  }).filter(Boolean);
}

/** "9231=web,9241=admin" → { 9231: 'web', 9241: 'admin' } */
export function parseAppNames(spec) {
  return Object.fromEntries(String(spec || '').split(',').filter(Boolean).map(kv => kv.split('=').map(s => s.trim())));
}

/**
 * @param {{ env?: Record<string, string | undefined> }} [input]
 */
export function loadConfig({ env = {} } = {}) {
  return Object.freeze({
    // without 9229: that is the default port of a plain `node --inspect` (and of outbound-hub), not of an app under the tool (audit B-01)
    ports: Object.freeze(parsePorts(env.INSPECTOR_PORTS || '9230-9249')),
    appNames: Object.freeze(parseAppNames(env.APP_NAMES)),
    // package names without the npm scope: @acme/web → web (issue #8); APP_NAME_STRIP_SCOPE=0 restores full names
    stripScope: env.APP_NAME_STRIP_SCOPE !== '0',
    ignoreHosts: Object.freeze((env.IGNORE_HOSTS ?? 'registry.npmjs.org').split(',').filter(Boolean)),
    // OpenTelemetry export (OTLP, e.g. @vercel/otel → localhost:4318/v1/traces) is noise when there is no local collector
    ignoreOtlp: env.OUTBOUND_IGNORE_OTLP !== '0',
    maxRequests: Number(env.MAX_REQUESTS || 5000),
    maxResponseChars: Math.max(4000, Number(env.OUTBOUND_MAX_RESPONSE_CHARS || 20000)), // hard character limit of a tool response
    pageCorrelation: env.PAGE_CORRELATION !== '0',
    redact: env.OUTBOUND_REDACT !== '0',
    // extra path fragments treated as libraries when choosing the call site (frames.mjs)
    libraryPaths: Object.freeze(String(env.OUTBOUND_LIBRARY_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)),
    redactHeaders: Object.freeze(String(env.OUTBOUND_REDACT_HEADERS || '').split(',').map(s => s.trim()).filter(Boolean)),
    // response bodies: eager (fetch right away), lazy (on get_server_request), off (never)
    bodies: ['eager', 'lazy', 'off'].includes(env.OUTBOUND_BODIES) ? env.OUTBOUND_BODIES : 'eager',
    bodyMaxBytes: Number(env.OUTBOUND_BODY_MAX_KB || 256) * 1024,            // per response in the collector
    bodiesTotalBytes: Number(env.OUTBOUND_BODIES_TOTAL_MB || 32) * 1024 ** 2, // all bodies in the collector
    inspectorBufferTotal: Number(env.OUTBOUND_INSPECTOR_BUFFER_MB || 32) * 1024 ** 2, // Network.enable in the app process
    inspectorBufferResource: Number(env.OUTBOUND_INSPECTOR_RESOURCE_MB || 2) * 1024 ** 2,
    scanIntervalMs: 1500,
    pollIntervalMs: 1000,
    listTimeoutMs: 500,
    sendTimeoutMs: 3000,
  });
}
