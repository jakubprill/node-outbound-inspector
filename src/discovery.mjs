// Target discovery: scanning inspector ports (`/json/list`).

/** Limits against the process on a scanned port, which may be any local program (audit B-11). */
export const DISCOVERY_LIMITS = Object.freeze({ listBytes: 64 * 1024, targetsPerPort: 8 });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A target is accepted only when its WebSocket address points to the same port on loopback.
 * Without this a fake /json/list could direct the collector to any other process or host (audit B-03).
 */
export function validTarget(t, port) {
  if (!t || typeof t !== 'object' || typeof t.webSocketDebuggerUrl !== 'string' || t.webSocketDebuggerUrl.length > 512) return false;
  try {
    const u = new URL(t.webSocketDebuggerUrl);
    return u.protocol === 'ws:' && LOOPBACK.has(u.hostname) && Number(u.port) === port;
  } catch { return false; }
}

/** A response read with a size limit; a larger one is rejected. */
async function readLimited(res, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) { await res.body.cancel?.().catch?.(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @returns {Promise<any[] | null>} the inspector target list or null when the port does not answer */
export async function listTargets(port, { timeoutMs }) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await readLimited(res, DISCOVERY_LIMITS.listBytes);
    const list = text == null ? null : JSON.parse(text);
    return Array.isArray(list) ? list.slice(0, 100) : null;
  } catch { return null; }
}

/**
 * Periodically scans ports and reports new targets (by webSocketDebuggerUrl).
 * @param {{ ports: readonly number[], scanIntervalMs: number, listTimeoutMs: number }} config
 * @param {{ isKnown: (wsUrl: string) => boolean, onTarget: (target: any, port: number) => void }} handlers
 */
export function createDiscovery(config, { isKnown, onTarget }) {
  let timer = null;
  const scanPort = async port => {
    const list = await listTargets(port, { timeoutMs: config.listTimeoutMs });
    // targets exposed by outbound-hub are the same processes as on their own ports — skipped to avoid duplicates
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
