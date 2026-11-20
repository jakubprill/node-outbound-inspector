// Composition root: discovery → sessions → ingest → store; page correlation; bodies; status.
// The only place with clocks and side effects. Nothing starts on import — only in start().
import { createStore } from './store.mjs';
import { createDiscovery } from './discovery.mjs';
import { openSession } from './session.mjs';
import { applyNetworkEvent, clean } from './ingest.mjs';
import { applyPageEntries } from './correlate.mjs';
import { createRedactor } from './redact.mjs';
import { classifyBody, enforceBodyBudget } from './bodies.mjs';
import { OTLP_RULES } from './ignore.mjs';
import { assignNames } from './names.mjs';

const MAX_SESSIONS = 64;

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{ log?: (msg: string) => void, now?: () => number }} [deps]
 */
export function createCollector(config, { log = () => {}, now = Date.now } = {}) {
  const store = createStore({ maxRequests: config.maxRequests });
  const redact = createRedactor({ enabled: config.redact, extraHeaders: config.redactHeaders });
  const sessions = new Map();   // wsUrl → aktywna sesja
  const byProcess = new Map();  // processId → active session (for fetching bodies in lazy mode)
  let processSeq = 0;           // every attach gets a new processId — the record key survives a restart (defect 3)
  let pollTimer = null;
  const ignored = { hosts: 0, otlp: 0, inspector: 0 }; // counter of requests skipped since the collector started

  let lastActivityAt = now(); // the last network event (for settle_ms)

  /** Fetches the body from the inspector and stores it in the record with an explicit state. */
  async function fetchBody(r, missingState) {
    const session = byProcess.get(r.processId);
    if (!session) { r.body = { state: missingState, reason: 'app process disconnected' }; return; }
    const res = await session.send('Network.getResponseBody', { requestId: r.requestId }).catch(() => null);
    r.body = classifyBody(res, r, { maxStoredBytes: config.bodyMaxBytes, missingState, redactText: redact.body });
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

  /**
   * Display names after a process is identified (issue #8): short, and on a collision (`@a/web` and `@b/web`)
   * full for the whole group — also in already collected records. Does not depend on start order.
   */
  function assignAppNames() {
    const live = [...sessions.values()].filter(s => s.identity);
    const names = assignNames(live.map(s => s.identity));
    live.forEach((s, i) => {
      if (s.app === names[i]) return;
      s.app = names[i];
      for (const r of store.values()) if (r.processId === s.processId) r.app = s.app;
    });
  }

  const discovery = createDiscovery(config, {
    isKnown: url => sessions.has(url),
    onTarget: (target, port) => {
      if (sessions.size >= MAX_SESSIONS) return; // a limit against fake inspectors (audit B-11)
      const session = openSession(target, port, {
        config, log, onNetwork, processId: ++processSeq, onIdentified: assignAppNames,
        onClose: s => { sessions.delete(s.url); byProcess.delete(s.processId); },
      });
      sessions.set(session.url, session);
      byProcess.set(session.processId, session);
    },
  });

  async function pollPages(session) {
    if (!config.pageCorrelation || !session.pageCorrelation) return;
    const entries = await session.drainHookLog().catch(() => []);
    // the page request address (e.g. /callback?code=…&token=…) is redacted like a request URL; the same HMAC key,
    // so matching an entry to a redacted record still works (audit B-02)
    for (const e of entries) { e.url = redact.url(e.url); e.page.url = clean(redact.url(e.page.url)).slice(0, 2048); e.page.method = clean(e.page.method).slice(0, 16); }
    const pool = store.values().filter(r => r.processId === session.processId && !r.page);
    applyPageEntries(pool, entries, session.pendingPages, now());
  }
  const pollAll = () => Promise.all([...sessions.values()].map(pollPages));

  /** Body for get_server_request: in lazy mode fetched only now. */
  async function ensureBody(r) {
    if (config.bodies === 'lazy' && r.state === 'finished' && r.body?.state === 'none') await fetchBody(r, 'evicted');
    return r;
  }

  /**
   * Waits until traffic is quiet: no requests in flight (in the selected range) and no events for `quietMs`.
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
        // OTLP rules and the number of requests skipped at ingestion since the collector started (not stored)
        ignored_otlp: config.ignoreOtlp ? OTLP_RULES : [], ignored_requests_total: { ...ignored },
        apps: [...sessions.values()].map(s => ({ app: s.app, port: s.port, pid: s.pid, cwd: s.cwd, network_inspection: !!s.networkOk, page_correlation: !!s.pageCorrelation, since: s.connectedAt,
          buffered_requests: store.values().filter(r => r.app === s.app).length,
          node: s.node, ready: !!s.ready, node_workarounds: s.nodeWorkarounds ?? [],
          // the process's HTTP ports (from the hook): e.g. the next dev port for Next DevTools MCP calls
          ...(s.httpPorts?.length ? { http_ports: s.httpPorts } : {}),
          // skipped without inspection: no_consent | other_user (audit B-01)
          ...(s.skipped ? { skipped: s.skipped } : {}),
          warnings: s.warnings })),
        buffered_requests_total: store.size, last_id: store.lastId,
        redaction: config.redact, bodies: config.bodies, warnings: globalWarnings(),
      };
    },
  };
}
