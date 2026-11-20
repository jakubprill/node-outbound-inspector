// Replays an NDJSON recording (scripts/record-fixture.mjs) through the pure core: ingest → store → correlation.
import { readFileSync } from 'node:fs';
import { createStore } from '../../src/store.mjs';
import { applyNetworkEvent } from '../../src/ingest.mjs';
import { applyPageEntries } from '../../src/correlate.mjs';
import { createRedactor } from '../../src/redact.mjs';
import { classifyBody } from '../../src/bodies.mjs';

export function readRecording(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function replay(entries, { maxRequests = 5000, ignoreHosts = ['registry.npmjs.org'], inspectorPorts = [], redact = createRedactor({ key: Buffer.alloc(32) }), bodies = 'eager' } = {}) {
  const store = createStore({ maxRequests });
  const sessions = new Map();
  const sessionFor = port => {
    if (!sessions.has(port)) sessions.set(port, { processId: sessions.size + 1, port, app: `port-${port}`, pendingPages: [] });
    return sessions.get(port);
  };
  for (const e of entries) {
    if (e.kind === 'session') Object.assign(sessionFor(e.port), { pid: e.pid, app: e.app });
    else if (e.kind === 'network') applyNetworkEvent(store, sessionFor(e.port), e.method, e.params, { ignoreHosts, inspectorPorts, nowMs: e.nowMs, redact, bodies });
    else if (e.kind === 'body') {
      const s = sessionFor(e.port), r = store.get(`${s.processId}:${e.requestId}`);
      if (r) r.body = classifyBody(e.res, r, { maxStoredBytes: 256 * 1024, missingState: 'unavailable' });
    }
    else if (e.kind === 'hook') {
      const s = sessionFor(e.port);
      const pool = store.values().filter(r => r.processId === s.processId && !r.page);
      applyPageEntries(pool, e.entries, s.pendingPages, e.nowMs);
    }
  }
  return { store, sessions };
}
