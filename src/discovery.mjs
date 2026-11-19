// Wykrywanie celów: skanowanie portów inspektorów (`/json/list`).

/** @returns {Promise<any[] | null>} lista celów inspektora albo null, gdy port nie odpowiada */
export async function listTargets(port, { timeoutMs }) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })).json(); }
  catch { return null; }
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
    for (const t of list ?? []) if (t.webSocketDebuggerUrl && !isKnown(t.webSocketDebuggerUrl)) onTarget(t, port);
  };
  const scan = () => config.ports.forEach(scanPort);
  return {
    scan,
    start() { timer = setInterval(scan, config.scanIntervalMs); timer.unref(); scan(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
