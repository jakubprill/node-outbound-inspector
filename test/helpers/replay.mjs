// Odtwarza nagranie NDJSON (scripts/record-fixture.mjs) przez czysty rdzeń: ingest → store → korelacja.
import { readFileSync } from 'node:fs';
import { createStore } from '../../src/store.mjs';
import { applyNetworkEvent } from '../../src/ingest.mjs';
import { applyPageEntries } from '../../src/correlate.mjs';

export function readRecording(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function replay(entries, { maxRequests = 5000, ignoreHosts = ['registry.npmjs.org'], inspectorPorts = [] } = {}) {
  const store = createStore({ maxRequests });
  const sessions = new Map();
  const sessionFor = port => {
    if (!sessions.has(port)) sessions.set(port, { port, app: `port-${port}`, pendingPages: [] });
    return sessions.get(port);
  };
  for (const e of entries) {
    if (e.kind === 'session') Object.assign(sessionFor(e.port), { pid: e.pid, app: e.app });
    else if (e.kind === 'network') applyNetworkEvent(store, sessionFor(e.port), e.method, e.params, { ignoreHosts, inspectorPorts, nowMs: e.nowMs });
    else if (e.kind === 'hook') {
      const s = sessionFor(e.port);
      const pool = store.values().filter(r => r.port === s.port && r.pid === s.pid && !r.page);
      applyPageEntries(pool, e.entries, s.pendingPages, e.nowMs);
    }
  }
  return { store, sessions };
}
