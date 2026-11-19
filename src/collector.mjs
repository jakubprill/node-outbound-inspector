// Korzeń kompozycji: wykrywanie → sesje → ingest → magazyn; korelacja ze stronami; status.
// Jedyne miejsce z zegarami i efektami ubocznymi. Nic nie startuje przy imporcie — dopiero start().
import { createStore } from './store.mjs';
import { createDiscovery } from './discovery.mjs';
import { openSession } from './session.mjs';
import { applyNetworkEvent, decodeBody } from './ingest.mjs';
import { applyPageEntries } from './correlate.mjs';

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{ log?: (msg: string) => void, now?: () => number }} [deps]
 */
export function createCollector(config, { log = () => {}, now = Date.now } = {}) {
  const store = createStore({ maxRequests: config.maxRequests });
  const sessions = new Map(); // wsUrl → sesja
  let pollTimer = null;

  function onNetwork(session, method, params) {
    const effects = applyNetworkEvent(store, session, method, params,
      { ignoreHosts: config.ignoreHosts, inspectorPorts: config.ports, nowMs: now() });
    for (const e of effects) {
      if (e.type === 'fetch-body') {
        const r = store.get(e.key);
        session.send('Network.getResponseBody', { requestId: e.requestId }).then(res => {
          const body = decodeBody(res);
          if (body !== undefined) r.body = body;
        }).catch(() => {});
      }
    }
  }

  const discovery = createDiscovery(config, {
    isKnown: url => sessions.has(url),
    onTarget: (target, port) => {
      const session = openSession(target, port, { config, log, onNetwork, onClose: s => sessions.delete(s.url) });
      sessions.set(session.url, session);
    },
  });

  async function pollPages(session) {
    if (!config.pageCorrelation || !session.pageCorrelation) return;
    const entries = await session.drainHookLog();
    const pool = store.values().filter(r => r.port === session.port && r.pid === session.pid && !r.page);
    applyPageEntries(pool, entries, session.pendingPages, now());
  }
  const pollAll = () => Promise.all([...sessions.values()].map(pollPages));

  return {
    store,
    now,
    pollAll,
    start() {
      pollTimer = setInterval(pollAll, config.pollIntervalMs); pollTimer.unref();
      discovery.start();
    },
    stop() {
      clearInterval(pollTimer); pollTimer = null;
      discovery.stop();
      for (const s of sessions.values()) s.close();
    },
    status() {
      const ports = config.ports;
      return {
        ports_scanned: `${ports[0]}-${ports.at(-1)} (${ports.length})`, ignored_hosts: config.ignoreHosts,
        apps: [...sessions.values()].map(s => ({ app: s.app, port: s.port, pid: s.pid, cwd: s.cwd, network_inspection: !!s.networkOk, page_correlation: !!s.pageCorrelation, since: s.connectedAt,
          buffered_requests: store.values().filter(r => r.app === s.app).length })),
        buffered_requests_total: store.size, last_id: store.lastId,
      };
    },
  };
}
