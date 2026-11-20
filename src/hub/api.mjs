// Programowe API huba (issue #9): `import { startHub } from 'node-outbound-inspector/hub'`.
// The hub in the caller's process (e.g. a monorepo dev script), without a child process, without process.exit
// and without signal handlers: the caller decides about cleanup (`await hub.close()`).
import { readFileSync } from 'node:fs';
import { createHub, HUB_MARKER } from './hub.mjs';
import { parsePorts, parseAppNames } from '../config.mjs';

export { HUB_MARKER };
export const DEFAULT_HUB_PORT = 9229;
export const DEFAULT_INSPECTOR_PORTS = '9230-9249';
const MIN_NODE_MAJOR = 24;

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return '0'; }
})();

/** Who holds the port: another outbound-hub (marker in /json/version), a Node inspector or something else. */
async function probe(host, port) {
  try {
    const res = await fetch(`http://${host === '::1' ? '[::1]' : host}:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    if (body?.[HUB_MARKER]) return { hub: true, holder: `outbound-hub ${body[HUB_MARKER]}` };
    return { hub: false, holder: typeof body?.Browser === 'string' ? body.Browser.slice(0, 100) : null };
  } catch { return { hub: false, holder: null }; }
}

/**
 * Starts the hub for chrome://inspect in the current process.
 *
 * A status instead of an exception for a taken port: `listening` (this hub listens), `already-running` (another
 * outbound-hub already runs on the port — nothing to do), `port-taken` (another process holds the port, e.g. `node --inspect` without a port).
 * An exception only for environment errors: Node < 24 (`ERR_OUTBOUND_NODE_VERSION`) or another listen error.
 * The hub works under Bun (checked on Bun 1.4.4), so the version is checked only under Node.
 *
 * @param {import('./api.d.ts').StartHubOptions} [options]
 * @returns {Promise<import('./api.d.ts').Hub>}
 */
export async function startHub({
  host = '127.0.0.1', port = DEFAULT_HUB_PORT, ports = DEFAULT_INSPECTOR_PORTS, appNames = {}, stripScope = true,
  identify = true, scanIntervalMs = 1500, log = () => {},
} = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!process.versions.bun && major < MIN_NODE_MAJOR) {
    throw Object.assign(new Error(`Node ${process.versions.node} is not supported. Node ≥ ${MIN_NODE_MAJOR} is required.`), { code: 'ERR_OUTBOUND_NODE_VERSION' });
  }
  const hub = createHub({
    host, port, stripScope, identify, scanIntervalMs, log, version: VERSION,
    ports: typeof ports === 'string' ? parsePorts(ports) : [...ports],
    appNames: typeof appNames === 'string' ? parseAppNames(appNames) : appNames,
  });
  let closed = false;
  const result = (status, extra = {}) => ({
    status, port, version: VERSION, ...extra,
    apps: () => (status === 'listening' && !closed ? hub.apps() : []),
    async close() {
      if (closed) return;
      closed = true;
      if (status === 'listening') await hub.close();
    },
  });
  try {
    const { port: actual } = await hub.listen();
    const shown = host.includes(':') ? `[${host}]` : host;
    return { ...result('listening'), port: actual, url: `http://${shown}:${actual}` };
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
    const other = await probe(host, port);
    return result(other.hub ? 'already-running' : 'port-taken', { holder: other.holder });
  }
}
