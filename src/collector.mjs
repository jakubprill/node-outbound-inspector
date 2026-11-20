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

const MAX_SESSIONS = 64;

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

  let lastActivityAt = now(); // ostatnie zdarzenie sieciowe (dla settle_ms)

  /** Sekrety w polach treści JSON zastępuje opis, zanim treść trafi do magazynu. */
  function redactBody(body, mimeType) {
    if (!redact.enabled || typeof body?.data !== 'string' || !['available', 'truncated'].includes(body.state)) return;
    if (!/json/i.test(mimeType ?? '') && !/^\s*[[{]/.test(body.data)) return;
    const { text, count } = redact.jsonBody(body.data);
    if (count) { body.data = text; body.redactedFields = count; }
  }

  /** Pobiera treść z inspektora i zapisuje ją w rekordzie z jawnym stanem. */
  async function fetchBody(r, missingState) {
    const session = byProcess.get(r.processId);
    if (!session) { r.body = { state: missingState, reason: 'app process disconnected' }; return; }
    const res = await session.send('Network.getResponseBody', { requestId: r.requestId }).catch(() => null);
    r.body = classifyBody(res, r, { maxStoredBytes: config.bodyMaxBytes, missingState });
    redactBody(r.body, r.mimeType);
    enforceBodyBudget(store.values(), { maxTotalBytes: config.bodiesTotalBytes });
  }

  function onNetwork(session, method, params) {
    lastActivityAt = now();
    const effects = applyNetworkEvent(store, session, method, params,
      { ignoreHosts: config.ignoreHosts, inspectorPorts: config.ports, ignoreOtlp: config.ignoreOtlp, nowMs: now(), redact, bodies: config.bodies, libraryPaths: config.libraryPaths });
    for (const e of effects) {
      if (e.type === 'fetch-body') { const r = store.get(e.key); if (r) fetchBody(r, 'unavailable'); }
      else if (e.type === 'ignored') ignored[e.reason]++;
    }
  }

  const discovery = createDiscovery(config, {
    isKnown: url => sessions.has(url),
    onTarget: (target, port) => {
      if (sessions.size >= MAX_SESSIONS) return; // limit wobec fałszywych inspektorów (audyt B-11)
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
    const entries = await session.drainHookLog().catch(() => []);
    const pool = store.values().filter(r => r.processId === session.processId && !r.page);
    applyPageEntries(pool, entries, session.pendingPages, now());
  }
  const pollAll = () => Promise.all([...sessions.values()].map(pollPages));

  /** Treść dla get_server_request: w trybie lazy pobierana dopiero teraz. */
  async function ensureBody(r) {
    if (config.bodies === 'lazy' && r.state === 'finished' && r.body?.state === 'none') await fetchBody(r, 'evicted');
    return r;
  }

  /**
   * Czeka, aż ruch ucichnie: brak zapytań w toku (w wybranym zakresie) i brak zdarzeń przez `quietMs`.
   * @returns {Promise<{ settled: boolean, waited_ms: number, in_flight?: number }>}
   */
  async function settle({ quietMs, maxWaitMs, args = {} }) {
    const start = now();
    for (;;) {
      await pollAll();
      const pending = store.select(args, now()).filter(r => r.tsEnd == null).length;
      const waited = now() - start;
      if (!pending && now() - lastActivityAt >= quietMs) return { settled: true, waited_ms: waited };
      if (waited >= maxWaitMs) return { settled: false, waited_ms: waited, in_flight: pending };
      await new Promise(res => setTimeout(res, Math.min(50, quietMs)));
    }
  }

  const globalWarnings = () => [
    ...(config.redact ? [] : ['Secret redaction is off (OUTBOUND_REDACT=0): headers, URL parameters and JSON body fields reach the agent unchanged.']),
  ];

  return {
    store,
    now,
    pollAll,
    ensureBody,
    settle,
    start() {
      pollTimer = setInterval(() => pollAll().catch(e => log(`poll error: ${e?.message ?? e}`)), config.pollIntervalMs); pollTimer.unref();
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
          node: s.node, ready: !!s.ready, node_workarounds: s.nodeWorkarounds ?? [],
          // porty HTTP procesu (z haka): np. port next dev do wywołań Next DevTools MCP
          ...(s.httpPorts?.length ? { http_ports: s.httpPorts } : {}),
          warnings: s.warnings })),
        buffered_requests_total: store.size, last_id: store.lastId,
        redaction: config.redact, bodies: config.bodies, warnings: globalWarnings(),
      };
    },
  };
}
