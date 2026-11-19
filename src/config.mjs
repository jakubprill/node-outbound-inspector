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
    ports: Object.freeze(parsePorts(env.INSPECTOR_PORTS || '9229-9249')),
    appNames: Object.freeze(parseAppNames(env.APP_NAMES)),
    ignoreHosts: Object.freeze((env.IGNORE_HOSTS ?? 'registry.npmjs.org').split(',').filter(Boolean)),
    maxRequests: Number(env.MAX_REQUESTS || 5000),
    pageCorrelation: env.PAGE_CORRELATION !== '0',
    scanIntervalMs: 1500,
    pollIntervalMs: 1000,
    listTimeoutMs: 500,
    sendTimeoutMs: 3000,
  });
}
