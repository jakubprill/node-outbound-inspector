// Jedno miejsce czytające konfigurację ze środowiska. Wynik jest zamrożony.

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
    // bez 9229: to domyślny port zwykłego `node --inspect` (i port outbound-hub), nie aplikacji pod narzędziem (audyt B-01)
    ports: Object.freeze(parsePorts(env.INSPECTOR_PORTS || '9230-9249')),
    appNames: Object.freeze(parseAppNames(env.APP_NAMES)),
    // nazwy pakietów bez scope npm: @acme/web → web (issue #8); APP_NAME_STRIP_SCOPE=0 przywraca pełne nazwy
    stripScope: env.APP_NAME_STRIP_SCOPE !== '0',
    ignoreHosts: Object.freeze((env.IGNORE_HOSTS ?? 'registry.npmjs.org').split(',').filter(Boolean)),
    // eksport OpenTelemetry (OTLP, np. @vercel/otel → localhost:4318/v1/traces) to szum, gdy lokalnie nie ma kolektora
    ignoreOtlp: env.OUTBOUND_IGNORE_OTLP !== '0',
    maxRequests: Number(env.MAX_REQUESTS || 5000),
    maxResponseChars: Math.max(4000, Number(env.OUTBOUND_MAX_RESPONSE_CHARS || 20000)), // twardy limit znaków odpowiedzi narzędzia
    pageCorrelation: env.PAGE_CORRELATION !== '0',
    redact: env.OUTBOUND_REDACT !== '0',
    // dodatkowe fragmenty ścieżek traktowane jak biblioteki przy wyborze miejsca wywołania (frames.mjs)
    libraryPaths: Object.freeze(String(env.OUTBOUND_LIBRARY_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)),
    redactHeaders: Object.freeze(String(env.OUTBOUND_REDACT_HEADERS || '').split(',').map(s => s.trim()).filter(Boolean)),
    // treści odpowiedzi: eager (pobieraj od razu), lazy (przy get_server_request), off (nigdy)
    bodies: ['eager', 'lazy', 'off'].includes(env.OUTBOUND_BODIES) ? env.OUTBOUND_BODIES : 'eager',
    bodyMaxBytes: Number(env.OUTBOUND_BODY_MAX_KB || 256) * 1024,            // na odpowiedź w kolektorze
    bodiesTotalBytes: Number(env.OUTBOUND_BODIES_TOTAL_MB || 32) * 1024 ** 2, // wszystkie treści w kolektorze
    inspectorBufferTotal: Number(env.OUTBOUND_INSPECTOR_BUFFER_MB || 32) * 1024 ** 2, // Network.enable w procesie aplikacji
    inspectorBufferResource: Number(env.OUTBOUND_INSPECTOR_RESOURCE_MB || 2) * 1024 ** 2,
    scanIntervalMs: 1500,
    pollIntervalMs: 1000,
    listTimeoutMs: 500,
    sendTimeoutMs: 3000,
  });
}
