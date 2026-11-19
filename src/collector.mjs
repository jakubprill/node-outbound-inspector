// Korzeń kompozycji: wykrywanie → sesje → ingest → magazyn; korelacja ze stronami; treści; status.
// Jedyne miejsce z zegarami i efektami ubocznymi. Nic nie startuje przy imporcie — dopiero start().
import { createStore } from './store.mjs';
import { createDiscovery } from './discovery.mjs';
import { openSession } from './session.mjs';
import { applyNetworkEvent } from './ingest.mjs';
import { applyPageEntries } from './correlate.mjs';
import { createRedactor } from './redact.mjs';
import { classifyBody, enforceBodyBudget } from './bodies.mjs';
import { OTLP_RULES } from './ignore.mjs';

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{ log?: (msg: string) => void, now?: () => number }} [deps]
 */
export function createCollector(config, { log = () => {}, now = Date.now } = {}) {
  const store = createStore({ maxRequests: config.maxRequests });
  const redact = createRedactor({ enabled: config.redact, extraHeaders: config.redactHeaders });
  const sessions = new Map();   // wsUrl → aktywna sesja
  const byProcess = new Map();  // processId → aktywna sesja (do pobierania treści w trybie lazy)
  let processSeq = 0;           // każde podłączenie dostaje nowy processId — klucz rekordu przeżywa restart (wada 3)
  let pollTimer = null;
  const ignored = { hosts: 0, otlp: 0, inspector: 0 }; // licznik pominiętych zapytań od startu kolektora

  /** Pobiera treść z inspektora i zapisuje ją w rekordzie z jawnym stanem. */
  async function fetchBody(r, missingState) {
    const session = byProcess.get(r.processId);
    if (!session) { r.body = { state: missingState, reason: 'proces aplikacji rozłączony' }; return; }
    const res = await session.send('Network.getResponseBody', { requestId: r.requestId }).catch(() => null);
    r.body = classifyBody(res, r, { nodeMajor: session.nodeMajor ?? 24, maxStoredBytes: config.bodyMaxBytes, missingState });
    enforceBodyBudget(store.values(), { maxTotalBytes: config.bodiesTotalBytes });
  }

  function onNetwork(session, method, params) {
    const effects = applyNetworkEvent(store, session, method, params,
      { ignoreHosts: config.ignoreHosts, inspectorPorts: config.ports, ignoreOtlp: config.ignoreOtlp, nowMs: now(), redact, bodies: config.bodies });
    for (const e of effects) {
      if (e.type === 'fetch-body') { const r = store.get(e.key); if (r) fetchBody(r, 'unavailable'); }
      else if (e.type === 'ignored') ignored[e.reason]++;
    }
  }

  const discovery = createDiscovery(config, {
    isKnown: url => sessions.has(url),
    onTarget: (target, port) => {
      const session = openSession(target, port, {
        config, log, onNetwork, processId: ++processSeq,
        onClose: s => { sessions.delete(s.url); byProcess.delete(s.processId); },
      });
      sessions.set(session.url, session);
      byProcess.set(session.processId, session);
    },
  });

  async function pollPages(session) {
    if (!config.pageCorrelation || !session.pageCorrelation) return;
    const entries = await session.drainHookLog();
    const pool = store.values().filter(r => r.processId === session.processId && !r.page);
    applyPageEntries(pool, entries, session.pendingPages, now());
  }
  const pollAll = () => Promise.all([...sessions.values()].map(pollPages));

  /** Treść dla get_server_request: w trybie lazy pobierana dopiero teraz. */
  async function ensureBody(r) {
    if (config.bodies === 'lazy' && r.state === 'finished' && r.body?.state === 'none') await fetchBody(r, 'evicted');
    return r;
  }

  const globalWarnings = () => [
    ...(config.redact ? [] : ['Redakcja sekretów wyłączona (OUTBOUND_REDACT=0): nagłówki i parametry URL trafiają do agenta bez zmian.']),
  ];

  return {
    store,
    now,
    pollAll,
    ensureBody,
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
        // reguły OTLP i liczba zapytań pominiętych przy przyjęciu od startu kolektora (nie trafiły do magazynu)
        ignored_otlp: config.ignoreOtlp ? OTLP_RULES : [], ignored_requests_total: { ...ignored },
        apps: [...sessions.values()].map(s => ({ app: s.app, port: s.port, pid: s.pid, cwd: s.cwd, network_inspection: !!s.networkOk, page_correlation: !!s.pageCorrelation, since: s.connectedAt,
          buffered_requests: store.values().filter(r => r.app === s.app).length,
          node: s.node, ready: !!s.ready, warnings: s.warnings })),
        buffered_requests_total: store.size, last_id: store.lastId,
        redaction: config.redact, bodies: config.bodies, warnings: globalWarnings(),
      };
    },
  };
}
