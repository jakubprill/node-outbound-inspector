// Wykrywanie celów: skanowanie portów inspektorów (`/json/list`).

/** Limity wobec procesu na skanowanym porcie, który może być dowolnym lokalnym programem (audyt B-11). */
export const DISCOVERY_LIMITS = Object.freeze({ listBytes: 64 * 1024, targetsPerPort: 8 });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Cel przyjmowany tylko wtedy, gdy jego adres WebSocket wskazuje ten sam port na pętli zwrotnej.
 * Bez tego fałszywy /json/list mógłby skierować kolektor do dowolnego innego procesu albo hosta (audyt B-03).
 */
export function validTarget(t, port) {
  if (!t || typeof t !== 'object' || typeof t.webSocketDebuggerUrl !== 'string' || t.webSocketDebuggerUrl.length > 512) return false;
  try {
    const u = new URL(t.webSocketDebuggerUrl);
    return u.protocol === 'ws:' && LOOPBACK.has(u.hostname) && Number(u.port) === port;
  } catch { return false; }
}

/** Odpowiedź czytana z limitem rozmiaru; większa jest odrzucana. */
async function readLimited(res, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) { await res.body.cancel?.().catch?.(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @returns {Promise<any[] | null>} lista celów inspektora albo null, gdy port nie odpowiada */
export async function listTargets(port, { timeoutMs }) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await readLimited(res, DISCOVERY_LIMITS.listBytes);
    const list = text == null ? null : JSON.parse(text);
    return Array.isArray(list) ? list.slice(0, 100) : null;
  } catch { return null; }
}

/**
 * Cyklicznie skanuje porty i zgłasza nowe cele (po webSocketDebuggerUrl).
 * @param {{ ports: readonly number[], scanIntervalMs: number, listTimeoutMs: number }} config
 * @param {{ isKnown: (wsUrl: string) => boolean, onTarget: (target: any, port: number) => void }} handlers
 */
export function createDiscovery(config, { isKnown, onTarget }) {
  let timer = null;
  const scanPort = async port => {
    const list = await listTargets(port, { timeoutMs: config.listTimeoutMs });
    // cele wystawione przez outbound-hub to te same procesy co na ich własnych portach — pomijamy, żeby nie dublować
    const targets = (list ?? []).filter(t => validTarget(t, port) && !t.outboundHub).slice(0, DISCOVERY_LIMITS.targetsPerPort);
    for (const t of targets) if (!isKnown(t.webSocketDebuggerUrl)) onTarget(t, port);
  };
  const scan = () => config.ports.forEach(scanPort);
  return {
    scan,
    start() { timer = setInterval(scan, config.scanIntervalMs); timer.unref(); scan(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
